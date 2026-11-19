// 照片調整（仿 Camera Raw）：
// - 中間大圖、下方正在編輯的照片縮圖列（點一下切換）
// - 右上色階分布圖：滑鼠移到黑色 / 陰影 / 曝光度 / 亮部 / 白色區域，左右拖曳直接調整
// - 亮度（曝光度、對比、亮部、陰影、白色、黑色）、顏色（色溫、色調、細節飽和度、飽和度、HSL）、曲線
//
// 預覽用 WebGL 即時計算；存檔時只把數值寫進 XMP，縮圖、全螢幕、影像轉存由後端用「完全相同的公式」套用
// （src-tauri/src/edit.rs）。改公式時 shader 與 edit.rs 要一起改；曲線演算法在 curve.ts 與 edit.rs 各一份。

import { api, url, Item, EditParams } from "./api";
import { CurveEditor, Pt, cleanCurve, curveLut, sameCurve } from "./curve";

type NumKey = Exclude<keyof EditParams, "curve" | "hsl">;
type SyncKey = keyof EditParams;

const GROUPS: { group: string; items: { key: NumKey; label: string; min: number; max: number; step: number; cls?: string }[] }[] = [
  {
    group: "亮",
    items: [
      { key: "exposure", label: "曝光度", min: -5, max: 5, step: 0.05 },
      { key: "contrast", label: "對比", min: -100, max: 100, step: 1 },
      { key: "highlights", label: "亮部", min: -100, max: 100, step: 1 },
      { key: "shadows", label: "陰影", min: -100, max: 100, step: 1 },
      { key: "whites", label: "白色", min: -100, max: 100, step: 1 },
      { key: "blacks", label: "黑色", min: -100, max: 100, step: 1 },
    ],
  },
  {
    group: "顏色",
    items: [
      { key: "temp", label: "色溫", min: -100, max: 100, step: 1, cls: "temp" },
      { key: "tint", label: "色調", min: -100, max: 100, step: 1, cls: "tint" },
      { key: "vibrance", label: "細節飽和度", min: -100, max: 100, step: 1 },
      { key: "saturation", label: "飽和度", min: -100, max: 100, step: 1 },
    ],
  },
];

/** HSL 的 8 個色相區段（順序與 edit.rs 相同），hue = 區段中心色相（度） */
const BANDS: { label: string; hue: number }[] = [
  { label: "紅色", hue: 0 },
  { label: "橙色", hue: 30 },
  { label: "黃色", hue: 60 },
  { label: "綠色", hue: 120 },
  { label: "水綠色", hue: 180 },
  { label: "藍色", hue: 240 },
  { label: "紫色", hue: 270 },
  { label: "洋紅色", hue: 300 },
];
const HSL_LEN = 24;
const HSL_TABS = ["色相", "飽和度", "明亮度"];
const zeroHsl = () => new Array<number>(HSL_LEN).fill(0);
/** 補滿 24 格、限制 ±100 */
function normHsl(h: unknown): number[] {
  const v = zeroHsl();
  if (Array.isArray(h)) h.slice(0, HSL_LEN).forEach((x, i) => (v[i] = Number.isFinite(x) ? Math.max(-100, Math.min(100, Number(x))) : 0));
  return v;
}
const hslActive = (h: number[]) => h.some((x) => Math.abs(x) > 1e-4);
const EYEDROPPER = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M13.6 2.4a2 2 0 0 0-2.8 0L9.3 3.9l-.7-.7-1 1 .7.7-5.5 5.5a1.6 1.6 0 0 0-.4.7l-.6 2.3a.6.6 0 0 0 .8.8l2.3-.6c.3-.1.5-.2.7-.4L11.1 8l.7.7 1-1-.7-.7 1.5-1.5a2 2 0 0 0 0-2.8zM4 12.9l-1.3.4.4-1.3L8.6 6.4l.9.9z"/></svg>`;
const toLinJs = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgbJs = (c: number) => {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};
/** sRGB 數值 → HSV 色相（度）與飽和度；與 shader / edit.rs 相同 */
function hueOf(o: [number, number, number]): { hue: number; sat: number } {
  const mx = Math.max(...o);
  const mn = Math.min(...o);
  const c = mx - mn;
  if (c < 1e-5 || mx < 1e-6) return { hue: 0, sat: 0 };
  let hue = mx === o[0] ? 60 * ((o[1] - o[2]) / c) : mx === o[1] ? 60 * ((o[2] - o[0]) / c + 2) : 60 * ((o[0] - o[1]) / c + 4);
  if (hue < 0) hue += 360;
  return { hue, sat: c / mx };
}
/** 色相落在哪兩個 HSL 區段之間（i、j 與 j 的權重 t） */
function bandsOf(hue: number): { i: number; j: number; t: number } {
  const C = [...BANDS.map((b) => b.hue), 360];
  let i = 0;
  while (i < 7 && hue >= C[i + 1]) i++;
  return { i, j: (i + 1) % 8, t: Math.min(1, Math.max(0, (hue - C[i]) / (C[i + 1] - C[i]))) };
}

export const ZERO: EditParams = {
  temp: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
  curve: [],
  hsl: zeroHsl(),
};

const NUM_KEYS = GROUPS.flatMap((g) => g.items.map((s) => s.key));
const SYNC_KEYS: SyncKey[] = [...NUM_KEYS, "hsl", "curve"];
const LABEL_OF: Record<SyncKey, string> = {
  ...(Object.fromEntries(GROUPS.flatMap((g) => g.items.map((s) => [s.key, s.label]))) as Record<NumKey, string>),
  curve: "曲線",
  hsl: "HSL",
};
const SYNC_GROUPS: { group: string; keys: SyncKey[] }[] = [
  ...GROUPS.map((g) => ({ group: g.group, keys: [...g.items.map((s) => s.key), ...(g.group === "顏色" ? ["hsl"] : [])] as SyncKey[] })),
  { group: "曲線", keys: ["curve"] },
];

/** 色階分布圖上可拖曳的區域（與 Camera Raw 相同的五段） */
const ZONES: { key: NumKey; from: number; to: number }[] = [
  { key: "blacks", from: 0, to: 0.1 },
  { key: "shadows", from: 0.1, to: 0.35 },
  { key: "exposure", from: 0.35, to: 0.65 },
  { key: "highlights", from: 0.65, to: 0.9 },
  { key: "whites", from: 0.9, to: 1 },
];

function clone(p: EditParams): EditParams {
  return { ...p, curve: p.curve.map((q) => [q[0], q[1]] as Pt), hsl: normHsl(p.hsl) };
}

/** 上次同步時勾選的項目（預設全部） */
function loadSyncFields(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("editSyncFields") ?? "null");
    if (Array.isArray(v) && v.length) {
      // 舊版沒有 HSL：預設勾選
      if (localStorage.getItem("editSyncHasHsl") !== "1" && !v.includes("hsl")) v.push("hsl");
      return v.filter((k) => (SYNC_KEYS as string[]).includes(k));
    }
  } catch {
    /* ignore */
  }
  return [...SYNC_KEYS];
}

/** 調整面板各區塊的收合狀態（true = 收合），下次開啟沿用 */
type Sec = "basic" | "color" | "curve";
function loadCollapsed(): Record<Sec, boolean> {
  const d = { basic: false, color: false, curve: false };
  try {
    const v = JSON.parse(localStorage.getItem("editCollapsed") ?? "null");
    if (v && typeof v === "object") for (const k of Object.keys(d) as Sec[]) d[k] = v[k] === true;
  } catch {
    /* ignore */
  }
  return d;
}

function saveCollapsed(c: Record<Sec, boolean>) {
  try {
    localStorage.setItem("editCollapsed", JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

function loadHslTab(): number {
  try {
    const v = Number(localStorage.getItem("editHslTab"));
    return v === 1 || v === 2 ? v : 0;
  } catch {
    return 0;
  }
}

function saveHslTab(t: number) {
  try {
    localStorage.setItem("editHslTab", String(t));
  } catch {
    /* ignore */
  }
}

function saveSyncFields(f: string[]) {
  try {
    localStorage.setItem("editSyncFields", JSON.stringify(f));
    localStorage.setItem("editSyncHasHsl", "1");
  } catch {
    /* ignore */
  }
}

export function isIdentity(p: EditParams) {
  return NUM_KEYS.every((k) => Math.abs(p[k]) < 1e-4) && cleanCurve(p.curve).length === 0 && !hslActive(normHsl(p.hsl));
}

const same = (a: EditParams, b: EditParams) =>
  NUM_KEYS.every((k) => Math.abs(a[k] - b[k]) < 1e-4) &&
  sameCurve(a.curve, b.curve) &&
  normHsl(a.hsl).every((x, i) => Math.abs(x - normHsl(b.hsl)[i]) < 1e-4);

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
uniform vec2 u_scale;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos * u_scale, 0.0, 1.0);
}`;

// 與 edit.rs 的 pixel() / tone() / lut_apply() 完全相同
const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform sampler2D u_lut;
uniform float u_useLut;
uniform float u_bypass;
uniform vec3 u_gains;
uniform float u_ev, u_c, u_h, u_s, u_w, u_b, u_vib, u_sat;
uniform float u_useHsl;
uniform float u_hh[9];
uniform float u_hs[9];
uniform float u_hl[9];
const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
const float TAU = 6.28318530718;
float toLin(float c) { return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4); }
float toSrgb(float c) { c = clamp(c, 0.0, 1.0); return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055; }
float tone(float l) {
  float v = pow(max(l, 0.0), 1.0 / 2.2);
  float lo = -0.08 * u_b;
  float hi = 1.0 - 0.15 * u_w;
  v = (v - lo) / (hi - lo);
  float ws = smoothstep(0.0, 0.15, v) * (1.0 - smoothstep(0.15, 0.65, v));
  v += 0.2 * u_s * ws;
  float wh = smoothstep(0.45, 0.85, v);
  v += 0.25 * u_h * wh;
  float q = clamp(v, 0.0, 1.0);
  v -= u_c * 0.8 * sin(TAU * q) / TAU;
  return pow(max(v, 0.0), 2.2);
}
float lutAt(float i) {
  vec4 t = texture2D(u_lut, vec2((i + 0.5) / 256.0, 0.5));
  return (t.r * 255.0 * 256.0 + t.g * 255.0) / 65535.0;
}
float curve(float v) {
  float x = clamp(v, 0.0, 1.0) * 255.0;
  float i = min(floor(x), 254.0);
  return mix(lutAt(i), lutAt(i + 1.0), x - i);
}
vec3 hsv2rgb(float hue, float s, float v) {
  float h = mod(hue, 360.0) / 60.0;
  float i = min(floor(h), 5.0);
  float f = h - i;
  float p = v * (1.0 - s);
  float q = v * (1.0 - s * f);
  float t = v * (1.0 - s * (1.0 - f));
  if (i < 0.5) return vec3(v, t, p);
  if (i < 1.5) return vec3(q, v, p);
  if (i < 2.5) return vec3(p, v, t);
  if (i < 3.5) return vec3(p, q, v);
  if (i < 4.5) return vec3(t, p, v);
  return vec3(v, p, q);
}
// 與 edit.rs 的 hsl_adjust() 相同
vec3 hslAdjust(vec3 o) {
  float mx = max(o.r, max(o.g, o.b));
  float mn = min(o.r, min(o.g, o.b));
  float c = mx - mn;
  if (c < 1e-5 || mx < 1e-6) return o;
  float hue;
  if (mx == o.r) hue = 60.0 * ((o.g - o.b) / c);
  else if (mx == o.g) hue = 60.0 * ((o.b - o.r) / c + 2.0);
  else hue = 60.0 * ((o.r - o.g) / c + 4.0);
  if (hue < 0.0) hue += 360.0;
  float C[9];
  C[0] = 0.0; C[1] = 30.0; C[2] = 60.0; C[3] = 120.0; C[4] = 180.0; C[5] = 240.0; C[6] = 270.0; C[7] = 300.0; C[8] = 360.0;
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) {
    if (hue >= C[i] && (hue < C[i + 1] || i == 7)) {
      float t = clamp((hue - C[i]) / (C[i + 1] - C[i]), 0.0, 1.0);
      dh = mix(u_hh[i], u_hh[i + 1], t) / 100.0;
      ds = mix(u_hs[i], u_hs[i + 1], t) / 100.0;
      dl = mix(u_hl[i], u_hl[i + 1], t) / 100.0;
    }
  }
  float sv = c / mx;
  float s2 = clamp(sv * (1.0 + ds), 0.0, 1.0);
  vec3 rgb = hsv2rgb(hue + dh * 30.0, s2, mx);
  float a = dl * sv * 0.5;
  return a >= 0.0 ? rgb + (1.0 - rgb) * a : rgb * (1.0 + a);
}
void main() {
  vec3 s = texture2D(u_tex, v_uv).rgb;
  if (u_bypass > 0.5) { gl_FragColor = vec4(s, 1.0); return; }
  float ev = exp2(u_ev);
  vec3 c = vec3(toLin(s.r), toLin(s.g), toLin(s.b)) * u_gains * ev;
  float l = dot(c, LUM);
  float l2 = tone(l);
  c = l > 1e-6 ? c * (l2 / l) : vec3(l2);
  float y = dot(c, LUM);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float s0 = mx > 1e-6 ? (mx - mn) / mx : 0.0;
  float k = (1.0 + u_sat) * (1.0 + u_vib * (1.0 - s0));
  c = max(vec3(y) + (c - vec3(y)) * k, 0.0);
  vec3 o = vec3(toSrgb(c.r), toSrgb(c.g), toSrgb(c.b));
  if (u_useHsl > 0.5) o = hslAdjust(o);
  if (u_useLut > 0.5) o = vec3(curve(o.r), curve(o.g), curve(o.b));
  gl_FragColor = vec4(o, 1.0);
}`;

/** 色溫 −1…1 → 紅藍各自的增益（EV）；與 edit.rs wb_gains 相同 */
const tempStops = (k: number) => 0.35 * k + 0.4 * k * k * k;

function wbGains(p: EditParams): [number, number, number] {
  const k = p.temp / 100;
  const t = p.tint / 100;
  const kk = tempStops(k);
  const g = [2 ** (kk + 0.1 * t), 2 ** (-0.2 * t), 2 ** (-kk + 0.1 * t)];
  const l = g[0] * 0.2126 + g[1] * 0.7152 + g[2] * 0.0722;
  return [g[0] / l, g[1] / l, g[2] / l];
}

export interface EditorHost {
  session(): number;
  toast(msg: string): void;
  /** 存檔後通知（更新縮圖與「已調整」標記）：[id, 是否還有調整] */
  saved(results: [number, boolean][]): void;
  /** 編輯中的照片換了（讓主畫面的焦點跟著） */
  focus(id: number): void;
  /** 關閉後讓主畫面重新回報可見的縮圖 */
  closed(): void;
}

/** 色階分布：R、G、B、亮度各 256 格 */
interface Hist {
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  l: Float32Array;
}

export class Editor {
  private list: Item[] = [];
  private pos = 0;
  /** 目前照片在檔案裡的設定（判斷有沒有改過） */
  private saved: EditParams = clone(ZERO);
  private p: EditParams = clone(ZERO);
  /** 縮圖列中選取的照片（位置）：「套用到選取的照片」的對象，⌘ / ⇧ 點選增減 */
  private stripSel = new Set<number>();
  private stripAnchor = 0;
  private gl: WebGLRenderingContext | null = null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private lutTex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  private fboTex: WebGLTexture | null = null;
  private fboW = 0;
  private fboH = 0;
  private imgW = 0;
  private imgH = 0;
  private bypass = false;
  private loadSeq = 0;
  private raf = 0;
  private histTimer = 0;
  private hist: Hist | null = null;
  private hover: (typeof ZONES)[number] | null = null;
  private drag: { zone: (typeof ZONES)[number]; x: number; start: number } | null = null;
  private canvas: HTMLCanvasElement;
  private histo: HTMLCanvasElement;
  private curveEd: CurveEditor;
  private stripObs: IntersectionObserver | null = null;
  private q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;

  constructor(
    private el: HTMLElement,
    private host: EditorHost,
  ) {
    el.innerHTML = this.markup();
    this.canvas = this.q<HTMLCanvasElement>("#ed-canvas");
    this.histo = this.q<HTMLCanvasElement>("#ed-histo");
    this.curveEd = new CurveEditor(this.q<HTMLCanvasElement>("#ed-curve"), this.q("#ed-curve-info"), (pts) => {
      this.p.curve = pts;
      this.updateLut();
      this.markChanged();
      if (this.bypass) this.setBefore(false);
      this.draw();
    });
    el.addEventListener("input", (e) => this.onInput(e));
    el.addEventListener("dblclick", (e) => {
      const hi = (e.target as HTMLElement).closest<HTMLElement>("[data-hsl-reset]")?.dataset.hslReset;
      if (hi !== undefined) return this.setHsl(Number(hi), 0);
      const k = (e.target as HTMLElement).closest<HTMLElement>("[data-reset]")?.dataset.reset as NumKey | undefined;
      if (k) this.set(k, 0);
    });
    this.q("#ed-reset").addEventListener("click", () => {
      this.p = clone(ZERO);
      this.curveEd.set([]);
      this.updateLut();
      this.syncInputs();
      this.draw();
    });
    // 區塊收合：狀態記在 localStorage，下次開啟沿用（色階分布圖不收合）
    const collapsed = loadCollapsed();
    this.el.querySelectorAll<HTMLElement>(".ed-sec").forEach((sec) => {
      const k = sec.dataset.sec as Sec;
      sec.classList.toggle("collapsed", collapsed[k]);
      const head = sec.querySelector<HTMLElement>(".ed-sec-head")!;
      const toggle = () => {
        collapsed[k] = !sec.classList.contains("collapsed");
        sec.classList.toggle("collapsed", collapsed[k]);
        saveCollapsed(collapsed);
        if (!collapsed[k] && k === "curve") this.curveEd.draw();
      };
      head.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        toggle();
      });
      head.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }
      });
    });
    this.el.querySelectorAll<HTMLElement>("[data-hsl-tab]").forEach((b) =>
      b.addEventListener("click", () => this.setHslTab(Number(b.dataset.hslTab))),
    );
    this.setHslTab(loadHslTab());
    this.q("#ed-wb-pick").addEventListener("click", () => this.setTool("wb"));
    this.q("#ed-hsl-pick").addEventListener("click", () => this.setTool("hsl"));
    this.canvas.addEventListener("pointerdown", (e) => this.toolDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.toolMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.toolUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.toolUp(e));
    this.q("#ed-hsl-reset").addEventListener("click", () => {
      this.p.hsl = zeroHsl();
      this.syncInputs();
      if (this.bypass) this.setBefore(false);
      this.draw();
    });
    this.q("#ed-curve-reset").addEventListener("click", (e) => {
      e.stopPropagation();
      this.p.curve = [];
      this.curveEd.set([]);
      this.updateLut();
      this.markChanged();
      this.draw();
    });
    this.q("#ed-before").addEventListener("click", () => this.toggleBefore());
    this.q("#ed-prev").addEventListener("click", () => void this.goto(this.pos - 1));
    this.q("#ed-next").addEventListener("click", () => void this.goto(this.pos + 1));
    this.q("#ed-sync").addEventListener("click", () => this.openSync());
    this.q("#ed-sync-go").addEventListener("click", () => void this.syncToSelection());
    this.q("#ed-sync-cancel").addEventListener("click", () => this.q("#ed-syncbox").classList.add("hidden"));
    this.q("#ed-syncbox").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-sync-all]");
      if (b) this.onSyncChange(b as unknown as HTMLInputElement);
    });
    this.q("#ed-syncbox").addEventListener("change", (e) => this.onSyncChange(e.target as HTMLInputElement));
    this.q("#ed-cancel").addEventListener("click", () => void this.close(false));
    this.q("#ed-done").addEventListener("click", () => void this.close(true));
    this.q("#ed-strip").addEventListener("click", (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>("[data-pos]")?.dataset.pos;
      if (i === undefined) return;
      const n = Number(i);
      if (e.metaKey || e.ctrlKey) {
        // ⌘ 點選：加入 / 移出「一起套用」的選取（目前編輯的這張一定在內）
        if (n !== this.pos) this.stripSel.has(n) ? this.stripSel.delete(n) : this.stripSel.add(n);
        this.stripAnchor = n;
        this.markStrip();
      } else if (e.shiftKey) {
        // ⇧ 點選：選取一段範圍
        const a = Math.min(this.stripAnchor, n);
        const b = Math.max(this.stripAnchor, n);
        for (let k = a; k <= b; k++) this.stripSel.add(k);
        this.markStrip();
      } else {
        void this.goto(n);
      }
    });
    this.q("#ed-sel-all").addEventListener("click", () => this.selectAllStrip());
    // 色階分布圖：滑過顯示區域、左右拖曳調整
    this.histo.addEventListener("pointermove", (e) => this.histMove(e));
    this.histo.addEventListener("pointerdown", (e) => this.histDown(e));
    this.histo.addEventListener("pointerup", (e) => this.histUp(e));
    this.histo.addEventListener("pointercancel", (e) => this.histUp(e));
    this.histo.addEventListener("pointerleave", () => {
      if (!this.drag) {
        this.hover = null;
        this.drawHist();
      }
    });
    new ResizeObserver(() => this.draw()).observe(this.q("#ed-stage"));
    new ResizeObserver(() => this.drawHist()).observe(this.histo);
    this.canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.gl = null;
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.initGl();
      void this.loadImage();
    });
  }

  get isOpen() {
    return !this.el.classList.contains("hidden");
  }

  private markup() {
    const rowsOf = (g: (typeof GROUPS)[number]) =>
      `<div class="ed-group">${g.items
        .map(
          (s) => `<div class="ed-row">
            <label data-reset="${s.key}" title="雙擊恢復為 0">${s.label}</label>
            <input type="number" data-num="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
            <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" class="${s.cls ?? ""}" />
          </div>`,
        )
        .join("")}</div>`;
    const light = rowsOf(GROUPS[0]);
    const color = `<div class="ed-pickrow"><button id="ed-wb-pick" class="ed-pick" title="白平衡滴管（I）：點選照片中應該是白色或灰色的地方，自動設定色溫與色調">${EYEDROPPER} 白平衡滴管</button></div>${rowsOf(GROUPS[1])}`;
    const hsl = `<div class="ed-hsl">
        <div class="ed-hsl-head"><span>HSL</span><button id="ed-hsl-pick" class="ed-pick" title="目標調整滴管（T）：在照片上按住某個顏色上下拖曳，調整目前分頁中那個顏色">${EYEDROPPER} 目標調整</button><button id="ed-hsl-reset" class="link" title="HSL 全部恢復為 0">重設 HSL</button></div>
        <div class="ed-tabs">${HSL_TABS.map((t, i) => `<button data-hsl-tab="${i}">${t}</button>`).join("")}</div>
        ${BANDS.map(
          (b, i) => `<div class="ed-row">
            <label data-hsl-reset="${i}" title="雙擊恢復為 0">${b.label}</label>
            <input type="number" data-hsl-num="${i}" min="-100" max="100" step="1" />
            <input type="range" data-hsl="${i}" min="-100" max="100" step="1" class="hslr" />
          </div>`,
        ).join("")}
      </div>`;
    const sync = SYNC_GROUPS.map((g) =>
      g.keys.length === 1
        ? `<div class="ed-sync-group"><label class="check grp"><input type="checkbox" data-sync="${g.keys[0]}" data-group="${g.group}" /> ${LABEL_OF[g.keys[0]]}</label></div>`
        : `<div class="ed-sync-group">
        <label class="check grp"><input type="checkbox" data-sync-group="${g.group}" /> ${g.group}</label>
        ${g.keys.map((k) => `<label class="check"><input type="checkbox" data-sync="${k}" data-group="${g.group}" /> ${LABEL_OF[k]}</label>`).join("")}
      </div>`,
    ).join("");
    return `
      <div class="ed-main">
        <div id="ed-stage" class="ed-stage"><canvas id="ed-canvas"></canvas><div id="ed-msg" class="ed-msg"></div><div id="ed-badge" class="ed-badge hidden">原圖</div><div id="ed-tool-hint" class="ed-tool-hint hidden"></div></div>
        <div id="ed-strip" class="ed-strip"></div>
      </div>
      <aside class="ed-panel">
        <div class="ed-histo-wrap">
          <canvas id="ed-histo" class="ed-histo"></canvas>
          <div id="ed-histo-tip" class="ed-histo-tip"></div>
        </div>
        <div class="ed-head">
          <button id="ed-prev" title="上一張（←）">‹</button>
          <div class="ed-title"><div id="ed-name"></div><div id="ed-count" class="muted small"></div></div>
          <button id="ed-next" title="下一張（→）">›</button>
        </div>
        <div class="ed-scroll">
          <section class="ed-sec" data-sec="basic">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev">▾</span><span class="ed-sec-title">亮度</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
            </div>
            <div class="ed-sec-body">${light}</div>
          </section>
          <section class="ed-sec" data-sec="color">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev">▾</span><span class="ed-sec-title">顏色</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
            </div>
            <div class="ed-sec-body">${color}${hsl}</div>
          </section>
          <section class="ed-sec" data-sec="curve">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev">▾</span><span class="ed-sec-title">曲線</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
              <button id="ed-curve-reset" class="link" title="恢復成直線">重設曲線</button>
            </div>
            <div class="ed-sec-body">
              <canvas id="ed-curve" class="ed-curve"></canvas>
              <div id="ed-curve-info" class="muted small ed-curve-info"></div>
            </div>
          </section>
          <div class="ed-tools">
            <button id="ed-before" title="按 \\ 切換調整前 / 調整後">調整前 / 後（\\）</button>
            <button id="ed-reset" title="全部恢復為 0">全部重設</button>
          </div>
          <div id="ed-syncrow" class="ed-syncrow">
            <button id="ed-sync" class="ed-sync" title="把目前的設定套用到縮圖列中選取的照片，可勾選只套用某幾項"></button>
            <div class="ed-sync-hint muted small">在下方縮圖列 ⌘ 點選或 ⇧ 點選要一起套用的照片 · <button id="ed-sel-all" class="link">全選（⌘A）</button></div>
          </div>
          <div id="ed-syncbox" class="ed-syncbox hidden">
            <div id="ed-sync-title" class="ed-sync-title"></div>
            <div class="ed-sync-quick"><button data-sync-all="1" class="link">全選</button><button data-sync-all="0" class="link">全不選</button></div>
            ${sync}
            <p class="muted small">沒勾選的項目，每張照片保留各自原本的值。</p>
            <div class="ed-sync-actions"><button id="ed-sync-cancel">取消</button><button id="ed-sync-go" class="primary"></button></div>
          </div>
          <p class="muted small">調整不會改動原始影像，只把設定存在檔案的中繼資料裡；切換照片或按「完成」時自動儲存。要輸出調整後的照片請用「影像轉存」。</p>
        </div>
        <div class="ed-foot">
          <button id="ed-cancel" title="放棄這張照片尚未儲存的變更（Esc）">取消</button>
          <button id="ed-done" class="primary" title="儲存並關閉（Enter）">完成</button>
        </div>
      </aside>`;
  }

  /** 開啟：list = 要逐張調整的照片（下方縮圖列），start = 從哪一張開始 */
  async open(list: Item[], start: number) {
    if (!list.length) return;
    this.list = list;
    this.pos = Math.max(0, Math.min(start, list.length - 1));
    this.stripSel = new Set([this.pos]);
    this.stripAnchor = this.pos;
    this.el.classList.remove("hidden");
    if (!this.gl) this.initGl();
    if (!this.gl) {
      this.el.classList.add("hidden");
      this.host.toast("這台電腦的顯示環境不支援即時預覽（WebGL），無法開啟調整");
      return;
    }
    this.buildStrip();
    await this.show();
  }

  // ---------------------------------------------------------------- 下方縮圖列

  private buildStrip() {
    const strip = this.q("#ed-strip");
    this.stripObs?.disconnect();
    strip.classList.toggle("hidden", this.list.length < 2);
    strip.innerHTML = this.list
      .map((it, i) => `<div class="ed-thumb" data-pos="${i}" data-id="${it.id}" title="${it.name}"><img alt="" draggable="false" /><span>${i + 1}</span></div>`)
      .join("");
    // 縮圖列中的照片不一定在主畫面上：讓後端不要把它們的縮圖當成「已捲出畫面」而取消
    void api.setViewport(this.host.session(), this.list.map((it) => it.id)).catch(() => {});
    // 只載入看得到的縮圖（照片很多時不會一次全部要求）
    this.stripObs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const d = e.target as HTMLElement;
          const img = d.querySelector("img")!;
          if (!img.getAttribute("src")) img.src = url.thumb(this.host.session(), Number(d.dataset.id));
        }
      },
      { root: strip, rootMargin: "0px 400px" },
    );
    strip.querySelectorAll(".ed-thumb").forEach((d) => this.stripObs!.observe(d));
  }

  private markStrip() {
    this.stripSel.add(this.pos);
    const strip = this.q("#ed-strip");
    strip.querySelectorAll<HTMLElement>(".ed-thumb").forEach((d) => {
      const i = Number(d.dataset.pos);
      d.classList.toggle("current", i === this.pos);
      d.classList.toggle("picked", this.stripSel.has(i));
    });
    strip.querySelector<HTMLElement>(".ed-thumb.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const n = this.stripSel.size;
    const sync = this.q<HTMLButtonElement>("#ed-sync");
    sync.disabled = n < 2;
    sync.textContent = n < 2 ? "套用到選取的照片（先在縮圖列選取）" : `套用到選取的 ${n} 張照片`;
    if (n < 2) this.q("#ed-syncbox").classList.add("hidden");
    else if (!this.q("#ed-syncbox").classList.contains("hidden")) this.q("#ed-sync-title").textContent = this.syncTitle();
  }

  private selectAllStrip() {
    this.list.forEach((_, i) => this.stripSel.add(i));
    this.markStrip();
  }

  /** 「一起套用」的照片 id（縮圖列順序） */
  private get targets(): number[] {
    return [...this.stripSel].sort((a, b) => a - b).map((i) => this.list[i].id);
  }

  private syncTitle() {
    return `要套用到選取的 ${this.stripSel.size} 張照片的項目`;
  }

  /** 存檔後重新載入縮圖列中這些照片的縮圖 */
  private refreshStrip(ids: number[]) {
    const set = new Set(ids);
    this.q("#ed-strip")
      .querySelectorAll<HTMLElement>(".ed-thumb")
      .forEach((d) => {
        const id = Number(d.dataset.id);
        if (!set.has(id)) return;
        const img = d.querySelector("img")!;
        if (img.getAttribute("src")) img.src = url.thumb(this.host.session(), id);
      });
  }

  // ---------------------------------------------------------------- WebGL

  private initGl() {
    const gl = this.canvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
      return s;
    };
    const mkTex = (filter: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    try {
      const prog = gl.createProgram()!;
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link");
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, "a_pos");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.tex = mkTex(gl.LINEAR);
      this.lutTex = mkTex(gl.NEAREST);
      this.fboTex = mkTex(gl.NEAREST);
      this.fbo = gl.createFramebuffer();
      this.fboW = this.fboH = 0;
      gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);
      gl.uniform1i(gl.getUniformLocation(prog, "u_lut"), 1);
      this.gl = gl;
      this.prog = prog;
      this.updateLut();
    } catch (e) {
      console.warn("WebGL init failed", e);
      this.gl = null;
    }
  }

  /** 曲線查表 → 256×1 貼圖（R = 高位元組、G = 低位元組，16 位元精度） */
  private updateLut() {
    const gl = this.gl;
    if (!gl || !this.lutTex) return;
    const lut = curveLut(cleanCurve(this.p.curve));
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const v = Math.round((lut ? lut[i] : i / 255) * 65535);
      data[i * 4] = v >> 8;
      data[i * 4 + 1] = v & 255;
      data[i * 4 + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.activeTexture(gl.TEXTURE0);
  }

  private get item() {
    return this.list[this.pos];
  }

  private async show() {
    const it = this.item;
    this.host.focus(it.id);
    this.q("#ed-name").textContent = it.name;
    this.q("#ed-count").textContent = this.list.length > 1 ? `${this.pos + 1} / ${this.list.length}` : "";
    this.q<HTMLButtonElement>("#ed-prev").disabled = this.pos === 0;
    this.q<HTMLButtonElement>("#ed-next").disabled = this.pos >= this.list.length - 1;
    this.q("#ed-syncrow").classList.toggle("hidden", this.list.length < 2);
    this.markStrip();
    this.setBefore(false);
    this.q("#ed-syncbox").classList.add("hidden");
    try {
      const r = await api.getEdit(this.host.session(), it.id);
      this.saved = clone({ ...ZERO, ...r, curve: (r.curve ?? []) as Pt[], hsl: normHsl(r.hsl) });
    } catch {
      this.saved = clone(ZERO);
    }
    this.p = clone(this.saved);
    this.curveEd.set(this.p.curve);
    this.updateLut();
    this.syncInputs();
    await this.loadImage();
  }

  private async loadImage() {
    const gl = this.gl;
    if (!gl) return;
    const seq = ++this.loadSeq;
    const msg = this.q("#ed-msg");
    msg.textContent = "載入中…";
    try {
      const res = await fetch(url.base(this.host.session(), this.item.id));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      if (seq !== this.loadSeq || !this.gl) return bmp.close();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bmp);
      this.imgW = bmp.width;
      this.imgH = bmp.height;
      // 滴管取色用的縮小原圖
      try {
        const sc = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
        const cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(bmp.width * sc));
        cv.height = Math.max(1, Math.round(bmp.height * sc));
        const g2 = cv.getContext("2d", { willReadFrequently: true })!;
        g2.drawImage(bmp, 0, 0, cv.width, cv.height);
        this.sample = g2.getImageData(0, 0, cv.width, cv.height);
      } catch {
        this.sample = null;
      }
      bmp.close();
      msg.textContent = "";
      this.draw();
    } catch (e) {
      if (seq === this.loadSeq) msg.textContent = `無法載入照片：${e}`;
    }
  }

  private draw() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      this.render();
      // 色階分布不必每一格都算（拖曳時約每 80ms 更新一次）
      if (!this.histTimer) {
        this.histTimer = window.setTimeout(() => {
          this.histTimer = 0;
          this.computeHist();
        }, 80);
      }
    });
  }

  private setUniforms(scaleX: number, scaleY: number) {
    const gl = this.gl!;
    const u = (k: string) => gl.getUniformLocation(this.prog!, k);
    const p = this.p;
    const g = wbGains(p);
    gl.uniform2f(u("u_scale"), scaleX, scaleY);
    gl.uniform1f(u("u_bypass"), this.bypass ? 1 : 0);
    gl.uniform1f(u("u_useLut"), cleanCurve(p.curve).length ? 1 : 0);
    gl.uniform3f(u("u_gains"), g[0], g[1], g[2]);
    gl.uniform1f(u("u_ev"), p.exposure);
    gl.uniform1f(u("u_c"), p.contrast / 100);
    gl.uniform1f(u("u_h"), p.highlights / 100);
    gl.uniform1f(u("u_s"), p.shadows / 100);
    gl.uniform1f(u("u_w"), p.whites / 100);
    gl.uniform1f(u("u_b"), p.blacks / 100);
    gl.uniform1f(u("u_vib"), p.vibrance / 100);
    gl.uniform1f(u("u_sat"), p.saturation / 100);
    // HSL：每種 9 格（第 9 格 = 紅色，讓洋紅→紅之間可以混合）
    const h = normHsl(p.hsl);
    gl.uniform1f(u("u_useHsl"), hslActive(h) ? 1 : 0);
    const band = (k: number) => new Float32Array([...h.slice(k * 8, k * 8 + 8), h[k * 8]]);
    gl.uniform1fv(u("u_hh"), band(0));
    gl.uniform1fv(u("u_hs"), band(1));
    gl.uniform1fv(u("u_hl"), band(2));
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
  }

  private render() {
    const gl = this.gl;
    if (!gl || !this.prog || !this.imgW || !this.isOpen) return;
    const stage = this.q("#ed-stage");
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(stage.clientWidth * dpr));
    const ch = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) {
      this.canvas.width = cw;
      this.canvas.height = ch;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.07, 0.07, 0.08, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pad = 16 * dpr;
    const s = Math.min((cw - pad * 2) / this.imgW, (ch - pad * 2) / this.imgH);
    this.setUniforms((this.imgW * s) / cw, (this.imgH * s) / ch);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** 把調整後的影像縮小畫到離屏緩衝區，讀回像素算色階分布 */
  private computeHist() {
    const gl = this.gl;
    if (!gl || !this.prog || !this.imgW || !this.isOpen || !this.fbo || !this.fboTex) return;
    const long = 256;
    const sc = long / Math.max(this.imgW, this.imgH);
    const w = Math.max(1, Math.round(this.imgW * sc));
    const h = Math.max(1, Math.round(this.imgH * sc));
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    if (w !== this.fboW || h !== this.fboH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.fboW = w;
      this.fboH = h;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    gl.viewport(0, 0, w, h);
    this.setUniforms(1, 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const hist: Hist = { r: new Float32Array(256), g: new Float32Array(256), b: new Float32Array(256), l: new Float32Array(256) };
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      hist.r[r]++;
      hist.g[g]++;
      hist.b[b]++;
      hist.l[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    }
    this.hist = hist;
    this.drawHist();
    this.curveEd.setHistogram(hist.l);
    // 離屏繪製會改到 viewport，重畫一次畫面（不再觸發計算）
    this.render();
  }

  // ---------------------------------------------------------------- 色階分布圖

  private zoneAt(e: PointerEvent) {
    const r = this.histo.getBoundingClientRect();
    const f = Math.min(0.9999, Math.max(0, (e.clientX - r.left) / r.width));
    return ZONES.find((z) => f >= z.from && f < z.to) ?? null;
  }

  private fmt(k: NumKey) {
    const v = this.p[k];
    return k === "exposure" ? `${v > 0 ? "+" : ""}${v.toFixed(2)}` : `${v > 0 ? "+" : ""}${Math.round(v)}`;
  }

  private histMove(e: PointerEvent) {
    if (this.drag) {
      const r = this.histo.getBoundingClientRect();
      const dx = (e.clientX - this.drag.x) / r.width;
      const k = this.drag.zone.key;
      // 整個寬度 = 曝光度 4 EV / 其他 200 單位
      const v = this.drag.start + dx * (k === "exposure" ? 4 : 200);
      this.set(k, k === "exposure" ? Math.round(v * 100) / 100 : Math.round(v));
      return;
    }
    const z = this.zoneAt(e);
    if (z !== this.hover) {
      this.hover = z;
      this.drawHist();
    }
  }

  private histDown(e: PointerEvent) {
    const z = this.zoneAt(e);
    if (!z) return;
    e.preventDefault();
    this.hover = z;
    this.drag = { zone: z, x: e.clientX, start: this.p[z.key] };
    this.histo.setPointerCapture(e.pointerId);
    this.drawHist();
  }

  private histUp(e: PointerEvent) {
    if (!this.drag) return;
    this.drag = null;
    try {
      this.histo.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.drawHist();
  }

  private drawHist() {
    const cv = this.histo;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr));
    const h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const g = cv.getContext("2d");
    if (!g) return;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#18181b";
    g.fillRect(0, 0, w, h);
    const z = this.drag?.zone ?? this.hover;
    if (z) {
      g.fillStyle = "#ffffff12";
      g.fillRect(z.from * w, 0, (z.to - z.from) * w, h);
    }
    const H = this.hist;
    if (H) {
      let mx = 0;
      for (const ch of [H.r, H.g, H.b]) for (let i = 1; i < 255; i++) mx = Math.max(mx, ch[i]);
      if (mx > 0) {
        g.globalCompositeOperation = "lighter";
        const paint = (ch: Float32Array, color: string) => {
          g.fillStyle = color;
          g.beginPath();
          g.moveTo(0, h);
          for (let i = 0; i < 256; i++) g.lineTo((i / 255) * w, h - Math.min(1, ch[i] / mx) * h * 0.92);
          g.lineTo(w, h);
          g.closePath();
          g.fill();
        };
        paint(H.r, "rgba(220,60,60,0.75)");
        paint(H.g, "rgba(60,190,80,0.75)");
        paint(H.b, "rgba(70,110,230,0.75)");
        g.globalCompositeOperation = "source-over";
      }
    }
    const tip = this.q("#ed-histo-tip");
    tip.textContent = z ? `${LABEL_OF[z.key]}　${this.fmt(z.key)}` : "";
    tip.classList.toggle("show", !!z);
    this.histo.style.cursor = z ? "ew-resize" : "default";
  }

  // ---------------------------------------------------------------- 滑桿

  private hslTab = 0;
  /** 滴管工具：wb = 白平衡、hsl = HSL 目標調整 */
  private tool: "wb" | "hsl" | null = null;
  /** 縮小的原始影像（滴管取色用） */
  private sample: ImageData | null = null;
  private tdrag: { y: number; i: number; j: number; t: number; start: number[] } | null = null;

  /** 開關滴管（再按一次同一個 = 關閉） */
  setTool(t: "wb" | "hsl" | null) {
    this.tool = this.tool === t ? null : t;
    this.tdrag = null;
    this.q("#ed-wb-pick").classList.toggle("active", this.tool === "wb");
    this.q("#ed-hsl-pick").classList.toggle("active", this.tool === "hsl");
    this.canvas.style.cursor = this.tool ? "crosshair" : "";
    if (this.tool) {
      // 確認「顏色」區塊是展開的，看得到數值變化
      const sec = this.q('[data-sec="color"]');
      if (sec.classList.contains("collapsed")) (sec.querySelector(".ed-sec-head") as HTMLElement).click();
    }
    this.hint(
      this.tool === "wb"
        ? "白平衡滴管：點選照片中應該是白色或灰色的地方（Esc 結束）"
        : this.tool === "hsl"
          ? `目標調整（${HSL_TABS[this.hslTab]}）：在照片上按住某個顏色，往上拖增加、往下拖減少（Esc 結束）`
          : "",
    );
  }

  private hint(text: string) {
    const h = this.q("#ed-tool-hint");
    h.textContent = text;
    h.classList.toggle("hidden", !text);
  }

  /** 滑鼠位置 → 原始影像上的顏色（約 5×5 平均，0–1 sRGB）；不在照片上回傳 null */
  private pick(e: PointerEvent): [number, number, number] | null {
    const d = this.sample;
    if (!d || !this.imgW) return null;
    const stage = this.q("#ed-stage");
    const r = stage.getBoundingClientRect();
    const pad = 16;
    const s = Math.min((r.width - pad * 2) / this.imgW, (r.height - pad * 2) / this.imgH);
    const w = this.imgW * s;
    const h = this.imgH * s;
    const u = (e.clientX - r.left - (r.width - w) / 2) / w;
    const v = (e.clientY - r.top - (r.height - h) / 2) / h;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const cx = Math.min(d.width - 1, Math.floor(u * d.width));
    const cy = Math.min(d.height - 1, Math.floor(v * d.height));
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = Math.max(0, cy - 2); y <= Math.min(d.height - 1, cy + 2); y++)
      for (let x = Math.max(0, cx - 2); x <= Math.min(d.width - 1, cx + 2); x++) {
        const k = (y * d.width + x) * 4;
        sum[0] += d.data[k];
        sum[1] += d.data[k + 1];
        sum[2] += d.data[k + 2];
        n++;
      }
    return [sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255];
  }

  /** 原始顏色套上目前白平衡後的 sRGB 值（HSL 是在白平衡之後作用） */
  private afterWb(c: [number, number, number]): [number, number, number] {
    const g = wbGains(this.p);
    return [toSrgbJs(toLinJs(c[0]) * g[0]), toSrgbJs(toLinJs(c[1]) * g[1]), toSrgbJs(toLinJs(c[2]) * g[2])];
  }

  /** 白平衡：讓點到的顏色變成中性灰。增益比例 R:G:B 拉平 → 解出色溫 / 色調（與 wbGains 的公式對應） */
  private pickWb(c: [number, number, number]) {
    const lin = c.map((v) => Math.max(1e-4, toLinJs(v)));
    const [lr, lg, lb] = lin.map(Math.log2);
    if (Math.max(...c) < 0.02) return this.hint("這裡太暗了，請點選亮一點的白色或灰色區域");
    if (Math.min(...c) > 0.995) return this.hint("這裡已經過曝成純白，請點選有細節的白色或灰色區域");
    // 紅藍拉平：2·tempStops(k) = lb − lr（單調遞增，用二分法解）
    const want = (lb - lr) / 2;
    let lo = -2;
    let hi = 2;
    for (let n = 0; n < 50; n++) {
      const mid = (lo + hi) / 2;
      if (tempStops(mid) < want) lo = mid;
      else hi = mid;
    }
    const k = (lo + hi) / 2;
    // 綠與紅藍平均拉平（紅藍各 +0.1t、綠 −0.2t）
    const t = (lg - (lr + lb) / 2) / 0.3;
    const clamp = (x: number) => Math.round(Math.max(-100, Math.min(100, x * 100)));
    this.p.temp = clamp(k);
    this.p.tint = clamp(t);
    this.syncInputs();
    if (this.bypass) this.setBefore(false);
    this.draw();
    const capped = Math.abs(k) > 1 || Math.abs(t) > 1;
    this.hint(`色溫 ${this.p.temp} · 色調 ${this.p.tint}${capped ? "（已達調整上限）" : ""}　可以再點其他地方，Esc 結束`);
  }

  private toolDown(e: PointerEvent) {
    if (!this.tool || e.button !== 0) return;
    const c = this.pick(e);
    if (!c) return;
    e.preventDefault();
    if (this.tool === "wb") return this.pickWb(c);
    const { hue, sat } = hueOf(this.afterWb(c));
    if (sat < 0.08) return this.hint("這裡幾乎沒有顏色，請按住有顏色的地方拖曳");
    const b = bandsOf(hue);
    this.tdrag = { y: e.clientY, ...b, start: normHsl(this.p.hsl) };
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "ns-resize";
    this.toolMove(e);
  }

  private toolMove(e: PointerEvent) {
    if (this.tool !== "hsl") return;
    const d = this.tdrag;
    if (!d) {
      // 滑過時顯示這裡是哪個顏色
      const c = this.pick(e);
      if (!c) return;
      const { hue, sat } = hueOf(this.afterWb(c));
      if (sat < 0.08) return this.hint(`目標調整（${HSL_TABS[this.hslTab]}）：這裡幾乎沒有顏色`);
      const b = bandsOf(hue);
      const names = b.t < 0.15 ? BANDS[b.i].label : b.t > 0.85 ? BANDS[b.j].label : `${BANDS[b.i].label} / ${BANDS[b.j].label}`;
      return this.hint(`目標調整（${HSL_TABS[this.hslTab]}）：${names}　按住上下拖曳`);
    }
    const delta = (d.y - e.clientY) * 0.5;
    const h = [...d.start];
    const base = this.hslTab * 8;
    const clamp = (x: number) => Math.round(Math.max(-100, Math.min(100, x)));
    h[base + d.i] = clamp(d.start[base + d.i] + delta * (1 - d.t));
    h[base + d.j] = clamp(d.start[base + d.j] + delta * d.t);
    this.p.hsl = h;
    this.syncInputs();
    if (this.bypass) this.setBefore(false);
    this.draw();
    const show = (k: number) => `${BANDS[k].label} ${h[base + k] > 0 ? "+" : ""}${h[base + k]}`;
    const parts = [d.t < 0.95 ? show(d.i) : "", d.t > 0.05 ? show(d.j) : ""].filter(Boolean);
    this.hint(`${HSL_TABS[this.hslTab]}：${parts.join(" · ")}`);
  }

  private toolUp(e: PointerEvent) {
    if (!this.tdrag) return;
    this.tdrag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.canvas.style.cursor = this.tool ? "crosshair" : "";
  }

  /** 切換 HSL 分頁（色相 / 飽和度 / 明亮度）：滑桿換成該分頁的 8 個值與對應的色條 */
  private setHslTab(t: number) {
    this.hslTab = t;
    saveHslTab(t);
    this.el.querySelectorAll<HTMLElement>("[data-hsl-tab]").forEach((b) => b.classList.toggle("active", Number(b.dataset.hslTab) === t));
    this.el.querySelectorAll<HTMLInputElement>("input[data-hsl]").forEach((r) => {
      const hue = BANDS[Number(r.dataset.hsl)].hue;
      r.style.background =
        t === 0
          ? `linear-gradient(90deg, hsl(${hue - 30} 75% 55%), hsl(${hue} 75% 55%), hsl(${hue + 30} 75% 55%))`
          : t === 1
            ? `linear-gradient(90deg, hsl(${hue} 0% 55%), hsl(${hue} 90% 55%))`
            : `linear-gradient(90deg, hsl(${hue} 70% 18%), hsl(${hue} 70% 50%), hsl(${hue} 70% 82%))`;
    });
    this.syncInputs();
    if (this.tool === "hsl") this.hint(`目標調整（${HSL_TABS[t]}）：在照片上按住某個顏色，往上拖增加、往下拖減少（Esc 結束）`);
  }

  private setHsl(i: number, v: number, from?: HTMLInputElement) {
    const h = normHsl(this.p.hsl);
    h[this.hslTab * 8 + i] = Math.max(-100, Math.min(100, v));
    this.p.hsl = h;
    this.syncInputs(from);
    if (this.bypass) this.setBefore(false);
    this.draw();
  }

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
    const hi = t.dataset.hsl ?? t.dataset.hslNum;
    if (hi !== undefined) {
      const v = Number(t.value);
      if (Number.isFinite(v)) this.setHsl(Number(hi), v, t);
      return;
    }
    const k = (t.dataset.key ?? t.dataset.num) as NumKey | undefined;
    if (!k) return;
    const v = Number(t.value);
    if (!Number.isFinite(v)) return;
    this.set(k, v, t);
  }

  private set(k: NumKey, v: number, from?: HTMLInputElement) {
    const lim = k === "exposure" ? 5 : 100;
    this.p[k] = Math.max(-lim, Math.min(lim, v));
    this.syncInputs(from);
    if (this.bypass) this.setBefore(false);
    this.draw();
  }

  private markChanged() {
    const curved = cleanCurve(this.p.curve).length > 0;
    this.q("#ed-curve-reset").classList.toggle("changed", curved);
    this.q('[data-sec="curve"]').classList.toggle("has-changes", curved);
    const any = (keys: NumKey[]) => keys.some((k) => Math.abs(this.p[k]) > 1e-4);
    const hslOn = hslActive(normHsl(this.p.hsl));
    this.q("#ed-hsl-reset").classList.toggle("changed", hslOn);
    this.q('[data-sec="basic"]').classList.toggle("has-changes", any(GROUPS[0].items.map((s) => s.key)));
    this.q('[data-sec="color"]').classList.toggle("has-changes", any(GROUPS[1].items.map((s) => s.key)) || hslOn);
  }

  private syncInputs(except?: HTMLInputElement) {
    for (const k of NUM_KEYS) {
      const v = this.p[k];
      const txt = k === "exposure" ? v.toFixed(2) : String(Math.round(v));
      this.el.querySelectorAll<HTMLInputElement>(`[data-key="${k}"],[data-num="${k}"]`).forEach((i) => {
        if (i === except) return;
        i.value = i.type === "number" ? txt : String(v);
      });
      this.q(`[data-reset="${k}"]`).classList.toggle("changed", Math.abs(v) > 1e-4);
    }
    const h = normHsl(this.p.hsl);
    for (let i = 0; i < 8; i++) {
      const v = h[this.hslTab * 8 + i];
      this.el.querySelectorAll<HTMLInputElement>(`[data-hsl="${i}"],[data-hsl-num="${i}"]`).forEach((inp) => {
        if (inp !== except) inp.value = String(Math.round(v));
      });
      // 標籤：這個色彩在任一分頁有調整就標色
      this.q(`[data-hsl-reset="${i}"]`).classList.toggle("changed", [0, 1, 2].some((t) => Math.abs(h[t * 8 + i]) > 1e-4));
    }
    this.markChanged();
    if (this.hover || this.drag) this.drawHist();
  }

  private setBefore(on: boolean) {
    this.bypass = on;
    this.q("#ed-badge").classList.toggle("hidden", !on);
    this.q("#ed-before").classList.toggle("active", on);
    this.draw();
  }

  toggleBefore() {
    this.setBefore(!this.bypass);
  }

  // ---------------------------------------------------------------- 存檔與切換

  private async save(ids: number[], params: EditParams, fields: string[] | null = null) {
    const send = { ...params, curve: cleanCurve(params.curve) };
    const r = await api.saveEdit(this.host.session(), ids, send, fields);
    if (r.failed.length) this.host.toast(`有 ${r.failed.length} 張無法儲存調整：${r.failed[0]}`);
    this.host.saved(r.edited);
    this.refreshStrip(ids);
  }

  /** 有改過才存 */
  private async saveCurrent() {
    if (same(this.p, this.saved)) return;
    const params = clone(this.p);
    await this.save([this.item.id], params);
    this.saved = params;
  }

  async goto(next: number) {
    if (next < 0 || next >= this.list.length || next === this.pos) return;
    try {
      await this.saveCurrent();
    } catch (e) {
      this.host.toast(`無法儲存調整：${e}`);
      return;
    }
    this.pos = next;
    this.stripSel = new Set([next]);
    this.stripAnchor = next;
    await this.show();
  }

  /** 「套用到所有選取的照片」：先選要同步哪些項目 */
  private openSync() {
    if (this.stripSel.size < 2) return;
    const box = this.q("#ed-syncbox");
    const chosen = loadSyncFields();
    box.querySelectorAll<HTMLInputElement>("input[data-sync]").forEach((i) => {
      i.checked = chosen.includes(i.dataset.sync!);
    });
    this.q("#ed-sync-title").textContent = this.syncTitle();
    this.updateSyncUi();
    box.classList.remove("hidden");
    box.scrollIntoView({ block: "nearest" });
  }

  private syncFields(): string[] {
    return [...this.el.querySelectorAll<HTMLInputElement>("input[data-sync]")].filter((i) => i.checked).map((i) => i.dataset.sync!);
  }

  private updateSyncUi() {
    const n = this.syncFields().length;
    const go = this.q<HTMLButtonElement>("#ed-sync-go");
    go.disabled = n === 0;
    go.textContent = n === SYNC_KEYS.length ? "全部套用" : `套用勾選的 ${n} 項`;
    this.el.querySelectorAll<HTMLInputElement>("input[data-sync-group]").forEach((g) => {
      const items = [...this.el.querySelectorAll<HTMLInputElement>(`input[data-sync][data-group="${g.dataset.syncGroup}"]`)];
      const on = items.filter((i) => i.checked).length;
      g.checked = on === items.length;
      g.indeterminate = on > 0 && on < items.length;
    });
  }

  private onSyncChange(t: HTMLInputElement) {
    if (t.dataset.syncGroup) {
      this.el.querySelectorAll<HTMLInputElement>(`input[data-sync][data-group="${t.dataset.syncGroup}"]`).forEach((i) => (i.checked = t.checked));
    }
    if (t.dataset.syncAll !== undefined) {
      this.el.querySelectorAll<HTMLInputElement>("input[data-sync]").forEach((i) => (i.checked = t.dataset.syncAll === "1"));
    }
    this.updateSyncUi();
  }

  private async syncToSelection() {
    const ids = this.targets;
    const fields = this.syncFields();
    if (ids.length < 2 || !fields.length) return;
    saveSyncFields(fields);
    this.q("#ed-syncbox").classList.add("hidden");
    try {
      // 目前這張先完整存檔（包含沒勾選的項目），其他照片只覆寫勾選的項目
      await this.saveCurrent();
      const others = ids.filter((id) => id !== this.item.id);
      const all = fields.length === SYNC_KEYS.length;
      await this.save(others, clone(this.p), all ? null : fields);
      const names = fields.map((f) => LABEL_OF[f as SyncKey]).join("、");
      this.host.toast(all ? `已把全部調整套用到 ${ids.length} 張照片` : `已把「${names}」套用到 ${ids.length} 張照片，其他設定保留各自的值`);
    } catch (e) {
      this.host.toast(`無法套用：${e}`);
    }
  }

  async close(save: boolean) {
    if (save) {
      try {
        await this.saveCurrent();
      } catch (e) {
        this.host.toast(`無法儲存調整：${e}`);
        return;
      }
    }
    if (this.tool) this.setTool(null);
    this.loadSeq++;
    this.el.classList.add("hidden");
    this.stripObs?.disconnect();
    this.q("#ed-strip").innerHTML = "";
    // 釋放貼圖記憶體
    const gl = this.gl;
    if (gl && this.tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array(3));
    }
    this.imgW = 0;
    this.hist = null;
    this.host.closed();
  }

  /** 調整視窗開著時的按鍵（回傳 true = 已處理） */
  key(ev: KeyboardEvent): boolean {
    const t = ev.target as HTMLElement;
    // 焦點在滑桿或數字欄時，方向鍵用來微調數值
    const typing = t.tagName === "INPUT";
    if (ev.key === "Escape" && this.tool) return this.setTool(null), true;
    if (ev.key === "Escape") {
      const box = this.q("#ed-syncbox");
      if (!box.classList.contains("hidden")) return box.classList.add("hidden"), true;
      return void this.close(false), true;
    }
    if (ev.key === "Enter" && !typing) return void this.close(true), true;
    if (typing) return false;
    if (ev.key === "\\") return this.toggleBefore(), true;
    if (!ev.metaKey && !ev.ctrlKey && ev.key.toLowerCase() === "i") return this.setTool("wb"), true;
    if (!ev.metaKey && !ev.ctrlKey && ev.key.toLowerCase() === "t") return this.setTool("hsl"), true;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "a") return this.selectAllStrip(), true;
    if (ev.key === "ArrowLeft") return void this.goto(this.pos - 1), true;
    if (ev.key === "ArrowRight") return void this.goto(this.pos + 1), true;
    return true; // 其他按鍵不傳到背後的主畫面（避免誤評分）
  }
}
