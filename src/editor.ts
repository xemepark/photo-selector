// 照片調整（仿 Camera Raw）：
// - 中間大圖、下方正在編輯的照片縮圖列（點一下切換）
// - 右上色階分布圖：滑鼠移到黑色 / 陰影 / 曝光度 / 亮部 / 白色區域，左右拖曳直接調整
// - 亮（曝光度、對比、亮部、陰影、白色、黑色）、顏色（色溫、色調、細節飽和度、飽和度）、曲線
//
// 預覽用 WebGL 即時計算；存檔時只把數值寫進 XMP，縮圖、全螢幕、影像轉存由後端用「完全相同的公式」套用
// （src-tauri/src/edit.rs）。改公式時 shader 與 edit.rs 要一起改；曲線演算法在 curve.ts 與 edit.rs 各一份。

import { api, url, Item, EditParams } from "./api";
import { CurveEditor, Pt, cleanCurve, curveLut, sameCurve } from "./curve";

type NumKey = Exclude<keyof EditParams, "curve">;
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
};

const NUM_KEYS = GROUPS.flatMap((g) => g.items.map((s) => s.key));
const SYNC_KEYS: SyncKey[] = [...NUM_KEYS, "curve"];
const LABEL_OF: Record<SyncKey, string> = {
  ...(Object.fromEntries(GROUPS.flatMap((g) => g.items.map((s) => [s.key, s.label]))) as Record<NumKey, string>),
  curve: "曲線",
};
const SYNC_GROUPS: { group: string; keys: SyncKey[] }[] = [
  ...GROUPS.map((g) => ({ group: g.group, keys: g.items.map((s) => s.key) as SyncKey[] })),
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
  return { ...p, curve: p.curve.map((q) => [q[0], q[1]] as Pt) };
}

/** 上次同步時勾選的項目（預設全部） */
function loadSyncFields(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("editSyncFields") ?? "null");
    if (Array.isArray(v) && v.length) return v.filter((k) => (SYNC_KEYS as string[]).includes(k));
  } catch {
    /* ignore */
  }
  return [...SYNC_KEYS];
}

function saveSyncFields(f: string[]) {
  try {
    localStorage.setItem("editSyncFields", JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

export function isIdentity(p: EditParams) {
  return NUM_KEYS.every((k) => Math.abs(p[k]) < 1e-4) && cleanCurve(p.curve).length === 0;
}

const same = (a: EditParams, b: EditParams) => NUM_KEYS.every((k) => Math.abs(a[k] - b[k]) < 1e-4) && sameCurve(a.curve, b.curve);

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
  if (u_useLut > 0.5) o = vec3(curve(o.r), curve(o.g), curve(o.b));
  gl_FragColor = vec4(o, 1.0);
}`;

function wbGains(p: EditParams): [number, number, number] {
  const k = p.temp / 100;
  const t = p.tint / 100;
  const g = [2 ** (0.35 * k + 0.1 * t), 2 ** (-0.2 * t), 2 ** (-0.35 * k + 0.1 * t)];
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
  private selection: number[] = [];
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
    this.q("#ed-curve-reset").addEventListener("click", () => {
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
      if (i !== undefined) void this.goto(Number(i));
    });
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
    const rows = GROUPS.map(
      (g) => `<div class="ed-group"><h4>${g.group}</h4>${g.items
        .map(
          (s) => `<div class="ed-row">
            <label data-reset="${s.key}" title="雙擊恢復為 0">${s.label}</label>
            <input type="number" data-num="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" />
            <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" class="${s.cls ?? ""}" />
          </div>`,
        )
        .join("")}</div>`,
    ).join("");
    const sync = SYNC_GROUPS.map(
      (g) => `<div class="ed-sync-group">
        <label class="check grp"><input type="checkbox" data-sync-group="${g.group}" /> ${g.group}</label>
        ${g.keys.map((k) => `<label class="check"><input type="checkbox" data-sync="${k}" data-group="${g.group}" /> ${LABEL_OF[k]}</label>`).join("")}
      </div>`,
    ).join("");
    return `
      <div class="ed-main">
        <div id="ed-stage" class="ed-stage"><canvas id="ed-canvas"></canvas><div id="ed-msg" class="ed-msg"></div><div id="ed-badge" class="ed-badge hidden">原圖</div></div>
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
          ${rows}
          <div class="ed-group">
            <h4>曲線 <button id="ed-curve-reset" class="link" title="恢復成直線">重設曲線</button></h4>
            <canvas id="ed-curve" class="ed-curve"></canvas>
            <div id="ed-curve-info" class="muted small ed-curve-info"></div>
          </div>
          <div class="ed-tools">
            <button id="ed-before" title="按 \\ 切換調整前 / 調整後">調整前 / 後（\\）</button>
            <button id="ed-reset" title="全部恢復為 0">全部重設</button>
          </div>
          <button id="ed-sync" class="ed-sync" title="把目前的設定套用到所有選取的照片，可勾選只套用某幾項"></button>
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

  /** 開啟：list = 要逐張調整的照片，start = 從哪一張開始，selection = 「套用到選取」的對象 */
  async open(list: Item[], start: number, selection: number[]) {
    if (!list.length) return;
    this.list = list;
    this.pos = Math.max(0, Math.min(start, list.length - 1));
    this.selection = selection;
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
    const strip = this.q("#ed-strip");
    strip.querySelectorAll<HTMLElement>(".ed-thumb").forEach((d) => d.classList.toggle("current", Number(d.dataset.pos) === this.pos));
    strip.querySelector<HTMLElement>(".ed-thumb.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
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
    const n = this.selection.length;
    const sync = this.q<HTMLButtonElement>("#ed-sync");
    sync.textContent = `套用到所有選取的照片（${n} 張）`;
    sync.classList.toggle("hidden", n < 2);
    this.markStrip();
    this.setBefore(false);
    this.q("#ed-syncbox").classList.add("hidden");
    try {
      const r = await api.getEdit(this.host.session(), it.id);
      this.saved = clone({ ...ZERO, ...r, curve: (r.curve ?? []) as Pt[] });
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

  private onInput(e: Event) {
    const t = e.target as HTMLInputElement;
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
    this.q("#ed-curve-reset").classList.toggle("changed", cleanCurve(this.p.curve).length > 0);
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
    await this.show();
  }

  /** 「套用到所有選取的照片」：先選要同步哪些項目 */
  private openSync() {
    if (this.selection.length < 2) return;
    const box = this.q("#ed-syncbox");
    const chosen = loadSyncFields();
    box.querySelectorAll<HTMLInputElement>("input[data-sync]").forEach((i) => {
      i.checked = chosen.includes(i.dataset.sync!);
    });
    this.q("#ed-sync-title").textContent = `要套用到選取的 ${this.selection.length} 張照片的項目`;
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
    const ids = this.selection;
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
    if (ev.key === "Escape") {
      const box = this.q("#ed-syncbox");
      if (!box.classList.contains("hidden")) return box.classList.add("hidden"), true;
      return void this.close(false), true;
    }
    if (ev.key === "Enter" && !typing) return void this.close(true), true;
    if (typing) return false;
    if (ev.key === "\\") return this.toggleBefore(), true;
    if (ev.key === "ArrowLeft") return void this.goto(this.pos - 1), true;
    if (ev.key === "ArrowRight") return void this.goto(this.pos + 1), true;
    return true; // 其他按鍵不傳到背後的主畫面（避免誤評分）
  }
}
