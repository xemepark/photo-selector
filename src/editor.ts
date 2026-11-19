// 照片調整（仿 Camera Raw）：
// - 中間大圖、下方正在編輯的照片縮圖列（點一下切換）
// - 右上色階分布圖：滑鼠移到黑色 / 陰影 / 曝光度 / 亮部 / 白色區域，左右拖曳直接調整
// - 亮度（曝光度、對比、亮部、陰影、白色、黑色）、顏色（色溫、色調、細節飽和度、飽和度、HSL）、曲線
//
// 預覽用 WebGL 即時計算；存檔時只把數值寫進 XMP，縮圖、全螢幕、影像轉存由後端用「完全相同的公式」套用
// （src-tauri/src/edit.rs）。改公式時 shader 與 edit.rs 要一起改；曲線演算法在 curve.ts 與 edit.rs 各一份。

import { api, url, Item, EditParams } from "./api";
import { CurveEditor, Pt, cleanCurve, curveLut, sameCurve } from "./curve";
import { MAX_SPOT_POINTS, Spot, SpotMode, applySpots, autoRadius, cleanSpots, distToStroke, findSource, outerR } from "./heal";
import { Crop, MAX_ANGLE, RATIOS, bboxFrame, bisect, fits, fitted, fromNorm, fullCrop, largestAt, toFrame, toImg, toNorm } from "./crop";

type NumKey = Exclude<keyof EditParams, "curve" | "hsl" | "crop" | "spots">;
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
/** 裁切：5 個有效數字，否則空陣列 */
const normCrop = (c: unknown): number[] =>
  Array.isArray(c) && c.length === 5 && c.every((x) => Number.isFinite(x)) ? c.map(Number) : [];
const sameCrop = (a: number[], b: number[]) => {
  const x = normCrop(a);
  const y = normCrop(b);
  return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 1e-5);
};
const RESET_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5"/><path fill="currentColor" d="M2 1.8v4.4h4.4z"/></svg>`;
const CROP_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" d="M4 1v11h11M1 4h11v11"/></svg>`;
const LEVEL_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M1.5 11.5 14.5 4.5"/><circle cx="4" cy="10.2" r="1.6" fill="currentColor"/><circle cx="12" cy="5.8" r="1.6" fill="currentColor"/></svg>`;
const SWAP_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><rect x="1.5" y="4.5" width="8" height="10" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M7 1.8h3.5a3 3 0 0 1 3 3V9m-2-2 2 2 2-2"/></svg>`;
const ERASER_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M9.5 2.5 14 7l-6 6H4.5L2 10.5z"/><path stroke="currentColor" stroke-width="1.5" d="M6 6l4.5 4.5M8 13.5h6"/></svg>`;
const HEAL_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5" y="0.8" width="6" height="14.4" rx="3" transform="rotate(45 8 8)" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="7" cy="7" r=".8" fill="currentColor"/><circle cx="9" cy="9" r=".8" fill="currentColor"/><circle cx="9" cy="7" r=".8" fill="currentColor"/><circle cx="7" cy="9" r=".8" fill="currentColor"/></svg>`;
const STAMP_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M6.3 8.5V6.7a1.9 1.9 0 1 1 3.4 0v1.8M2.5 8.5h11v3h-11zM3.5 14h9"/></svg>`;
const SPOT_TOOLS: { m: SpotMode; label: string; icon: string; tip: string }[] = [
  { m: 0, label: "移除", icon: ERASER_ICON, tip: "移除：塗抹要去掉的東西，自動在周圍找最吻合的畫面補上並融合" },
  { m: 1, label: "修復", icon: HEAL_ICON, tip: "修復：用旁邊的紋理覆蓋，顏色與明暗自動跟周圍融合" },
  { m: 2, label: "仿製", icon: STAMP_ICON, tip: "仿製：把來源區域原樣複製過來" },
];
/** 自訂游標（SVG）：白平衡 = 滴管、曲線 = 上下箭頭、HSL = 左右箭頭 */
const svgCursor = (svg: string, x: number, y: number, fallback: string) =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${x} ${y}, ${fallback}`;
const CUR_DROPPER = svgCursor(
  `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path d="M18.6 3.4a2.4 2.4 0 0 0-3.4 0l-2 2-1-1-1.4 1.4 1 1-7.6 7.6c-.3.3-.5.6-.6 1l-.8 3.1c-.1.5.3.9.8.8l3.1-.8c.4-.1.7-.3 1-.6l7.6-7.6 1 1 1.4-1.4-1-1 2-2a2.4 2.4 0 0 0 0-3.4z" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>`,
  2,
  20,
  "crosshair",
);
const arrows = (vertical: boolean) =>
  svgCursor(
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g transform="rotate(${vertical ? 0 : 90} 12 12)" stroke="#000" stroke-width="1.2" fill="#fff" stroke-linejoin="round"><path d="M12 1.5 16.5 7h-3v3.2h-3V7h-3z"/><path d="M12 22.5 7.5 17h3v-3.2h3V17h3z"/></g><circle cx="12" cy="12" r="1.8" fill="#fff" stroke="#000" stroke-width="1"/></svg>`,
    12,
    12,
    vertical ? "ns-resize" : "ew-resize",
  );
const CUR_UPDOWN = arrows(true);
const CUR_LEFTRIGHT = arrows(false);
const iconCache = new Map<string, HTMLImageElement>();
/** 修補標記用的工具圖示（指定顏色的 SVG 圖片） */
function spotIcon(m: SpotMode, color: string): HTMLImageElement {
  const key = `${m}${color}`;
  let img = iconCache.get(key);
  if (!img) {
    const svg = [ERASER_ICON, HEAL_ICON, STAMP_ICON][m]
      .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')
      .replace(/currentColor/g, color);
    img = new Image();
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    iconCache.set(key, img);
  }
  return img;
}
/** 目標調整工具圖示（仿 Camera Raw：左上十字 + 右下圓心靶） */
const TARGET_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M5 1.5v6M2 4.5h6"/><circle cx="10.5" cy="10.5" r="3.8" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="10.5" cy="10.5" r="1.4" fill="currentColor"/></svg>`;
const CURVE_TAT_ICON = `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3 16C8 16 8 4 17 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="3" cy="16" r="1.6" fill="currentColor"/><circle cx="17" cy="4" r="1.6" fill="currentColor"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.8 9.5h6.4L12 4M6.8 6.5v5M9.2 6.5v5"/></svg>`;
const EYE_ICON = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>`;
const EYEDROPPER = `<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M13.6 2.4a2 2 0 0 0-2.8 0L9.3 3.9l-.7-.7-1 1 .7.7-5.5 5.5a1.6 1.6 0 0 0-.4.7l-.6 2.3a.6.6 0 0 0 .8.8l2.3-.6c.3-.1.5-.2.7-.4L11.1 8l.7.7 1-1-.7-.7 1.5-1.5a2 2 0 0 0 0-2.8zM4 12.9l-1.3.4.4-1.3L8.6 6.4l.9.9z"/></svg>`;
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
  crop: [],
  spots: [],
};

const NUM_KEYS = GROUPS.flatMap((g) => g.items.map((s) => s.key));
const SYNC_KEYS: SyncKey[] = [...NUM_KEYS, "hsl", "curve", "crop", "spots"];
const LABEL_OF: Record<SyncKey, string> = {
  ...(Object.fromEntries(GROUPS.flatMap((g) => g.items.map((s) => [s.key, s.label]))) as Record<NumKey, string>),
  curve: "曲線",
  hsl: "HSL",
  crop: "裁切",
  spots: "修補",
};
const SYNC_GROUPS: { group: string; keys: SyncKey[] }[] = [
  ...GROUPS.map((g) => ({ group: g.group, keys: g.items.map((s) => s.key) as SyncKey[] })),
  { group: "HSL", keys: ["hsl"] },
  { group: "曲線", keys: ["curve"] },
  { group: "裁切", keys: ["crop"] },
  { group: "修補", keys: ["spots"] },
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
  return { ...p, curve: p.curve.map((q) => [q[0], q[1]] as Pt), hsl: normHsl(p.hsl), crop: normCrop(p.crop), spots: cleanSpots(JSON.parse(JSON.stringify(p.spots ?? []))) };
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
  // 修補預設不勾（通常每張照片要修的地方不同；感光元件灰塵才需要同步）
  return SYNC_KEYS.filter((k) => k !== "spots");
}

/** 調整面板各區塊的收合狀態（true = 收合），下次開啟沿用 */
type Sec = "crop" | "patch" | "basic" | "color" | "hsl" | "curve";
function loadCollapsed(): Record<Sec, boolean> {
  const d = { crop: false, patch: false, basic: false, color: false, hsl: false, curve: false };
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

function loadBrush(): { size: number; feather: number; opacity: number } {
  const d = { size: 20, feather: 25, opacity: 100 };
  try {
    const v = JSON.parse(localStorage.getItem("editBrush") ?? "null");
    if (v && typeof v === "object") for (const k of Object.keys(d) as (keyof typeof d)[]) if (Number.isFinite(v[k])) d[k] = v[k];
  } catch {
    /* ignore */
  }
  return d;
}

function saveBrush(b: { size: number; feather: number; opacity: number }) {
  try {
    localStorage.setItem("editBrush", JSON.stringify(b));
  } catch {
    /* ignore */
  }
}

function loadRatio(): string {
  try {
    const v = localStorage.getItem("editCropRatio") ?? "orig";
    return RATIOS.some((r) => r.id === v) ? v : "orig";
  } catch {
    return "orig";
  }
}

function saveRatio(v: string) {
  try {
    localStorage.setItem("editCropRatio", v);
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
  return NUM_KEYS.every((k) => Math.abs(p[k]) < 1e-4) && cleanCurve(p.curve).length === 0 && !hslActive(normHsl(p.hsl)) && !normCrop(p.crop).length && !(p.spots ?? []).length;
}

const same = (a: EditParams, b: EditParams) =>
  NUM_KEYS.every((k) => Math.abs(a[k] - b[k]) < 1e-4) &&
  sameCurve(a.curve, b.curve) &&
  normHsl(a.hsl).every((x, i) => Math.abs(x - normHsl(b.hsl)[i]) < 1e-4) &&
  sameCrop(a.crop, b.crop) &&
  JSON.stringify(a.spots ?? []) === JSON.stringify(b.spots ?? []);

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
uniform vec2 u_scale;
uniform vec2 u_fc;   // 顯示範圍（框）中心，原圖像素
uniform vec2 u_fs;   // 框寬高，像素
uniform vec2 u_img;  // 原圖寬高
uniform vec2 u_rot;  // (cos, sin) of 角度；與 crop.ts toImg 相同
void main() {
  vec2 d = vec2(a_pos.x * 0.5, -a_pos.y * 0.5) * u_fs;
  vec2 p = u_fc + vec2(u_rot.x * d.x + u_rot.y * d.y, -u_rot.y * d.x + u_rot.x * d.y);
  v_uv = p / u_img;
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
uniform float u_outside;
uniform float u_viz;
uniform vec2 u_texel;
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
  if (u_outside > 0.5 && (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0)) {
    gl_FragColor = vec4(0.07, 0.07, 0.08, 1.0);
    return;
  }
  vec3 s = texture2D(u_tex, v_uv).rgb;
  if (u_viz > 0.0) {
    // 顯現汙點：亮度的高頻成分（與周圍的差）放大，白底上看得到灰塵與雜點
    float l0 = dot(s, LUM);
    float acc = 0.0;
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        acc += dot(texture2D(u_tex, v_uv + vec2(float(i), float(j)) * u_texel * 2.0).rgb, LUM);
      }
    }
    float hp = l0 - acc / 9.0;
    float v = 1.0 - clamp(abs(hp) * u_viz, 0.0, 1.0);
    gl_FragColor = vec4(v, v, v, 1.0);
    return;
  }
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
        if (collapsed[k] && k === "patch" && this.ptool !== null) this.setPatch(null);
        if (collapsed[k] && this.tool && (this.tool === "wb" ? "color" : this.tool) === k) this.setTool(null);
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
    // 右側面板寬度可拖曳調整（記住寬度）
    {
      const panel = this.q(".ed-panel");
      const DEF = 272;
      const clampW = (w: number) => Math.round(Math.max(220, Math.min(480, w)));
      let w0 = DEF;
      try {
        w0 = clampW(Number(localStorage.getItem("editPanelW")) || DEF);
      } catch {
        /* ignore */
      }
      panel.style.width = `${w0}px`;
      const handle = this.q("#ed-resizer");
      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        const x0 = e.clientX;
        const start = panel.getBoundingClientRect().width;
        const move = (ev: PointerEvent) => {
          panel.style.width = `${clampW(start + (x0 - ev.clientX))}px`;
          this.draw();
        };
        const up = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          try {
            localStorage.setItem("editPanelW", String(Math.round(panel.getBoundingClientRect().width)));
          } catch {
            /* ignore */
          }
          this.draw();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
      });
      handle.addEventListener("dblclick", () => {
        panel.style.width = `${DEF}px`;
        try {
          localStorage.setItem("editPanelW", String(DEF));
        } catch {
          /* ignore */
        }
        this.draw();
      });
    }
    this.overlay = this.q<HTMLCanvasElement>("#ed-overlay");
    this.overlay.addEventListener("pointerdown", (e) => (this.cropping ? this.cropDown(e) : this.patchDown(e)));
    this.overlay.addEventListener("pointermove", (e) => (this.cropping ? this.cropMove(e) : this.patchMove(e)));
    this.overlay.addEventListener("pointerup", (e) => (this.cropping ? this.cropUp(e) : this.patchUp(e)));
    this.overlay.addEventListener("pointercancel", (e) => (this.cropping ? this.cropUp(e) : this.patchUp(e)));
    this.overlay.addEventListener("pointerleave", () => {
      this.phover = null;
      if (this.ptool !== null) this.drawOverlay();
    });
    this.el.querySelectorAll<HTMLElement>("[data-ptool]").forEach((b) =>
      b.addEventListener("click", () => {
        const m = Number(b.dataset.ptool) as SpotMode;
        this.setPatch(this.ptool === m ? null : m);
      }),
    );
    const brush = loadBrush();
    this.brush = brush;
    for (const k of ["size", "feather", "opacity"] as const) {
      for (const sel of [`[data-brush="${k}"]`, `[data-brush-num="${k}"]`]) {
        const inp = this.q<HTMLInputElement>(sel);
        inp.value = String(brush[k]);
        inp.addEventListener("input", (e) => {
          e.stopPropagation();
          const v = Number(inp.value);
          if (Number.isFinite(v)) this.setBrush(k, v, inp);
        });
      }
    }
    this.q("#ed-ov-show").addEventListener("change", () => this.drawOverlay());
    this.q("#ed-patch-eye").addEventListener("click", () => {
      this.spotsHidden = !this.spotsHidden;
      this.q("#ed-patch-eye").classList.toggle("active", this.spotsHidden);
      this.draw();
    });
    this.q("#ed-spot-del").addEventListener("click", () => this.deleteSpot());
    this.q<HTMLSelectElement>("#ed-spot-mode").addEventListener("change", (e) => {
      e.stopPropagation();
      const s = this.p.spots?.[this.selSpot];
      if (!s) return;
      s.m = Number((e.target as HTMLSelectElement).value) as SpotMode;
      this.refreshRank = 0;
      if (s.m === 0) {
        // 改成移除：用內容感知合成（不需要來源）
        s.d = [0, 0];
        this.markChanged();
        this.syncSpotSel();
        this.draw();
        return;
      }
      this.resample(this.selSpot, 0);
    });
    this.q("#ed-spot-refresh").addEventListener("click", () => {
      const s = this.p.spots?.[this.selSpot];
      if (!s) return;
      if (s.m === 0 && s.d[0] === 0 && s.d[1] === 0) {
        // 移除：換一個亂數種子重新合成
        s.k = (s.k ?? 0) + 1;
        this.markChanged();
        this.draw();
        return;
      }
      this.refreshRank++;
      this.resample(this.selSpot, this.refreshRank);
    });
    this.q("#ed-viz").addEventListener("change", () => this.draw());
    this.q("#ed-viz-amt").addEventListener("input", (e) => {
      e.stopPropagation();
      if (this.vizOn()) this.draw();
    });
    this.overlay.addEventListener("dblclick", (e) => {
      if (this.cropping && !this.leveling && this.hitCrop(e.clientX, e.clientY).kind === "move") this.commitCrop();
    });
    this.q("#ed-crop-tool").addEventListener("click", () => (this.cropping ? this.commitCrop() : this.enterCrop()));
    this.q("#ed-level-tool").addEventListener("click", () => {
      if (!this.cropping) this.enterCrop();
      this.setLeveling(!this.leveling);
    });
    this.q("#ed-swap").addEventListener("click", () => {
      if (!this.cropping) this.enterCrop();
      this.swapOrient();
    });
    const ratioSel = this.q<HTMLSelectElement>("#ed-ratio");
    ratioSel.value = loadRatio();
    ratioSel.addEventListener("change", () => {
      saveRatio(ratioSel.value);
      if (!this.cropping) this.enterCrop();
      this.applyRatio();
    });
    for (const id of ["#ed-angle", "#ed-angle-num"]) {
      this.q(id).addEventListener("input", (e) => {
        e.stopPropagation();
        const v = Number((e.target as HTMLInputElement).value);
        if (!Number.isFinite(v)) return;
        if (!this.cropping) this.enterCrop();
        this.setAngle(v, e.target as HTMLInputElement);
      });
    }
    this.q("[data-crop-angle-reset]").addEventListener("dblclick", () => {
      if (!this.cropping) this.enterCrop();
      this.setAngle(0);
    });
    // 在右側面板點了別的區塊 → 結束修補 / 滴管（與 Camera Raw 切換面板相同），不會留著筆刷游標
    this.q(".ed-panel").addEventListener(
      "pointerdown",
      (e) => {
        const sec = (e.target as HTMLElement).closest<HTMLElement>(".ed-sec")?.dataset.sec;
        if (this.ptool !== null && sec !== "patch") this.setPatch(null);
        if (this.tool) {
          const own = this.tool === "wb" ? "color" : this.tool;
          if (sec !== own) this.setTool(null);
        }
      },
      true,
    );
    this.q("#ed-wb-pick").addEventListener("click", () => this.setTool("wb"));
    this.q("#ed-hsl-pick").addEventListener("click", () => this.setTool("hsl"));
    this.q("#ed-curve-pick").addEventListener("click", () => this.setTool("curve"));
    // 目標調整浮動工具列（仿 Camera Raw）：切換曲線 / HSL、色相 / 飽和度 / 明度、關閉；左邊握把可拖曳
    const tat = this.q("#ed-tat");
    tat.querySelectorAll<HTMLElement>("[data-tat]").forEach((b) =>
      b.addEventListener("click", () => {
        const t = b.dataset.tat as "curve" | "hsl";
        if (this.tool !== t) this.setTool(t);
      }),
    );
    tat.querySelectorAll<HTMLElement>("[data-tat-tab]").forEach((b) =>
      b.addEventListener("click", () => this.setHslTab(Number(b.dataset.tatTab))),
    );
    tat.querySelector(".ed-tat-x")!.addEventListener("click", () => this.setTool(null));
    const grip = tat.querySelector<HTMLElement>(".ed-tat-grip")!;
    grip.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const stage = this.q("#ed-stage").getBoundingClientRect();
      const r0 = tat.getBoundingClientRect();
      const ox = e.clientX - r0.left;
      const oy = e.clientY - r0.top;
      grip.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const x = Math.max(0, Math.min(stage.width - r0.width, ev.clientX - stage.left - ox));
        const y = Math.max(0, Math.min(stage.height - r0.height, ev.clientY - stage.top - oy));
        tat.style.left = `${x}px`;
        tat.style.top = `${y}px`;
        tat.style.bottom = "auto";
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
    });
    this.canvas.addEventListener("pointerdown", (e) => this.toolDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.toolMove(e));
    this.canvas.addEventListener("pointerup", (e) => this.toolUp(e));
    this.canvas.addEventListener("pointercancel", (e) => this.toolUp(e));
    // 各區塊的重設按鈕
    this.el.querySelectorAll<HTMLElement>("[data-sec-reset]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        const k = b.dataset.secReset as Sec;
        if (k === "basic" || k === "color") for (const it of GROUPS[k === "basic" ? 0 : 1].items) this.p[it.key] = 0;
        if (k === "hsl") this.p.hsl = zeroHsl();
        if (k === "patch") {
          this.p.spots = [];
          this.selSpot = -1;
          this.syncSpotSel();
        }
        if (k === "crop") {
          if (this.cropping) {
            this.draft = fullCrop(this.imgW, this.imgH);
            this.rotBase = { w: this.draft.w, h: this.draft.h };
          } else this.p.crop = [];
        }
        if (k === "curve") {
          this.p.curve = [];
          this.curveEd.set([]);
          this.updateLut();
        }
        this.syncInputs();
        if (this.bypass) this.setBefore(false);
        this.draw();
      }),
    );
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
    const color = rowsOf(GROUPS[1]);
    const brushRow = (k: string, label: string, min: number, max: number) => `<div class="ed-row">
          <label>${label}</label>
          <input type="number" data-brush-num="${k}" min="${min}" max="${max}" step="1" />
          <input type="range" data-brush="${k}" min="${min}" max="${max}" step="1" />
        </div>`;
    const patch = `<div class="ed-patch">
        <div class="ed-patch-tools">${SPOT_TOOLS.map((t) => `<button class="ed-ptool" data-ptool="${t.m}" title="${t.label}：${t.tip.split("：")[1] ?? t.tip}">${t.icon}</button>`).join("")}<span id="ed-ptool-name" class="ed-ptool-name"></span></div>
        ${brushRow("size", "大小", 1, 200)}
        <div class="ed-feather-row">${brushRow("feather", "羽化", 0, 100)}</div>
        <div id="ed-spot-sel" class="ed-spot-sel hidden">
          <div class="ed-spot-sel-head"><span>已選取</span><button id="ed-spot-del" class="ed-ib" title="刪除這筆修補（Delete）">${TRASH_ICON}</button></div>
          <div class="ed-crop-row"><label>填滿</label><select id="ed-spot-mode">${SPOT_TOOLS.map((t) => `<option value="${t.m}">${t.label}</option>`).join("")}</select></div>
          ${brushRow("opacity", "不透明", 1, 100)}
          <div class="ed-spot-refresh"><button id="ed-spot-refresh" title="換一個取樣的地方重新填補">⟳ 重新整理</button></div>
        </div>
        <div class="muted small ed-crop-tip">ⓘ ⌘ + 在相片上拖曳可選取自訂來源</div>
        <div class="ed-crop-row"><label class="check small"><input type="checkbox" id="ed-viz" /> 顯現汙點</label><input type="range" id="ed-viz-amt" min="1" max="100" value="40" /></div>
        <label class="check small"><input type="checkbox" id="ed-ov-show" checked /> 顯示覆蓋</label>
        <div class="muted small ed-crop-tip">B 開始修補 · 點一下或塗抹要去掉的地方 · Delete 刪除選取 · ⌘Z 復原 · [ 變小 ] 變大</div>
      </div>`;
    const crop = `<div class="ed-crop">
        <div class="ed-crop-row">
          <label>比例</label>
          <select id="ed-ratio">${RATIOS.map((r) => `<option value="${r.id}">${r.label}</option>`).join("")}</select>
          <button id="ed-swap" class="ed-ib" title="直式 / 橫式互換（X）">${SWAP_ICON}</button>
        </div>
        <div class="ed-row">
          <label data-crop-angle-reset title="雙擊恢復為 0">角度</label>
          <input type="number" id="ed-angle-num" min="-45" max="45" step="0.1" />
          <input type="range" id="ed-angle" min="-45" max="45" step="0.1" />
        </div>
        <div class="muted small ed-crop-tip">C 開始裁切 · 拖曳框角調整、框內移動、框外拖曳旋轉 · Enter 套用 · Esc 取消</div>
      </div>`;
    const hsl = `<div class="ed-hsl">
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
        <div id="ed-stage" class="ed-stage"><canvas id="ed-canvas"></canvas><div id="ed-msg" class="ed-msg"></div><div id="ed-badge" class="ed-badge hidden">原圖</div><canvas id="ed-overlay" class="ed-overlay"></canvas><div id="ed-tat" class="ed-tat hidden"><span class="ed-tat-grip" title="拖曳移動"></span><button data-tat="curve" title="曲線目標調整">${CURVE_TAT_ICON}</button><button data-tat="hsl" title="HSL 目標調整"><span class="ed-wheel"></span></button><span class="ed-tat-sep"></span><div class="ed-tat-tabs">${HSL_TABS.map((t, i) => `<button data-tat-tab="${i}">${t === "明亮度" ? "明度" : t}</button>`).join("")}</div><button class="ed-tat-x" title="結束目標調整（Esc）">✕</button></div><div id="ed-tool-hint" class="ed-tool-hint hidden"></div></div>
        <div id="ed-strip" class="ed-strip"></div>
      </div>
      <aside class="ed-panel"><div id="ed-resizer" class="ed-resizer" title="拖曳調整寬度（雙擊恢復預設）"></div>
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
          <section class="ed-sec" data-sec="curve">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="ed-sec-title">曲線</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
              <button id="ed-curve-pick" class="ed-ib" title="曲線目標調整：在照片上按住某個亮度的地方，往上拖變亮、往下拖變暗">${TARGET_ICON}</button>
              <button class="ed-ib" data-sec-reset="curve" title="重設曲線">${RESET_ICON}</button>
            </div>
            <div class="ed-sec-body">
              <canvas id="ed-curve" class="ed-curve"></canvas>
              <div id="ed-curve-info" class="muted small ed-curve-info"></div>
            </div>
          </section>
          <section class="ed-sec" data-sec="basic">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="ed-sec-title">亮度</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
              <button class="ed-ib" data-sec-reset="basic" title="重設亮度">${RESET_ICON}</button>
            </div>
            <div class="ed-sec-body">${light}</div>
          </section>
          <section class="ed-sec" data-sec="color">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="ed-sec-title">顏色</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
              <button id="ed-wb-pick" class="ed-ib" title="白平衡滴管（I）：點選照片中應該是白色或灰色的地方，自動設定色溫與色調">${EYEDROPPER}</button><button class="ed-ib" data-sec-reset="color" title="重設顏色">${RESET_ICON}</button>
            </div>
            <div class="ed-sec-body">${color}</div>
          </section>
          <section class="ed-sec" data-sec="hsl">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="ed-sec-title">HSL</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
              <button id="ed-hsl-pick" class="ed-ib" title="目標調整滴管（T）：在照片上按住某個顏色上下拖曳，調整目前分頁中那個顏色">${TARGET_ICON}</button><button class="ed-ib" data-sec-reset="hsl" title="重設HSL">${RESET_ICON}</button>
            </div>
            <div class="ed-sec-body">${hsl}</div>
          </section>
          <section class="ed-sec" data-sec="patch">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="ed-sec-title">修補</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
              <button id="ed-patch-eye" class="ed-ib" title="暫時隱藏修補效果（比較修補前後）">${EYE_ICON}</button><button class="ed-ib" data-sec-reset="patch" title="清除所有修補">${RESET_ICON}</button>
            </div>
            <div class="ed-sec-body">${patch}</div>
          </section>
          <section class="ed-sec" data-sec="crop">
            <div class="ed-sec-head" role="button" tabindex="0" title="點一下收合 / 展開">
              <span class="ed-chev"><svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="ed-sec-title">裁切</span><span class="ed-sec-dot" title="這個區塊有調整"></span>
              <button id="ed-crop-tool" class="ed-ib" title="裁切（C）">${CROP_ICON}</button><button id="ed-level-tool" class="ed-ib" title="拉直工具：在照片上沿著應該水平或垂直的線拖曳">${LEVEL_ICON}</button><button class="ed-ib" data-sec-reset="crop" title="重設裁切">${RESET_ICON}</button>
            </div>
            <div class="ed-sec-body">${crop}</div>
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
  // ---------------------------------------------------------------- 多張同時調整（仿 Camera Raw）
  // 縮圖列選了多張時，改了哪個項目就同步寫到其他選取的照片（只寫改過的項目，其他保留各自的值），
  // 停下來約 0.35 秒後寫檔並更新它們的縮圖。按「取消」會把其他照片還原成開啟前的設定。

  /** 上次比對時的設定（找出這次改了哪些項目） */
  private lastP: EditParams | null = null;
  private multiFields = new Set<string>();
  private multiTimer = 0;
  /** 其他照片在這次調整前的設定（取消時還原） */
  private multiOrig = new Map<number, EditParams>();

  private changedFields(a: EditParams, b: EditParams): string[] {
    const out: string[] = NUM_KEYS.filter((k) => Math.abs(a[k] - b[k]) > 1e-6);
    if (!sameCurve(a.curve, b.curve)) out.push("curve");
    const ha = normHsl(a.hsl);
    const hb = normHsl(b.hsl);
    if (ha.some((x, i) => Math.abs(x - hb[i]) > 1e-6)) out.push("hsl");
    if (!sameCrop(a.crop, b.crop)) out.push("crop");
    if (JSON.stringify(a.spots ?? []) !== JSON.stringify(b.spots ?? [])) out.push("spots");
    return out;
  }

  private checkMulti() {
    if (!this.isOpen || !this.lastP) return;
    const changed = this.changedFields(this.lastP, this.p);
    if (!changed.length) return;
    this.lastP = clone(this.p);
    if (this.stripSel.size < 2 || !this.stripSel.has(this.pos)) return;
    for (const f of changed) this.multiFields.add(f);
    clearTimeout(this.multiTimer);
    this.multiTimer = window.setTimeout(() => void this.flushMulti(), 350);
  }

  private async flushMulti() {
    const fields = [...this.multiFields];
    this.multiFields.clear();
    const others = this.targets.filter((id) => id !== this.item.id);
    if (!fields.length || !others.length) return;
    try {
      // 第一次改到某張時先記下它原本的設定（取消時還原）
      await Promise.all(
        others
          .filter((id) => !this.multiOrig.has(id))
          .map(async (id) => {
            const r = await api.getEdit(this.host.session(), id).catch(() => null);
            this.multiOrig.set(id, clone({ ...ZERO, ...(r ?? {}), curve: (r?.curve ?? []) as Pt[], hsl: normHsl(r?.hsl), crop: normCrop(r?.crop), spots: cleanSpots(r?.spots) }));
          }),
      );
      await this.save(others, clone(this.p), fields);
    } catch (e) {
      this.host.toast(`無法同步調整：${e}`);
    }
  }

  /** 下方縮圖列：目前這張即時顯示調整後的樣子（用算色階分布時讀回的小圖） */
  private stripCanvas: HTMLCanvasElement | null = null;
  private updateStripThumb(px: Uint8Array, w: number, h: number) {
    const cell = this.q("#ed-strip").querySelector<HTMLElement>(`.ed-thumb[data-pos="${this.pos}"] img`) as HTMLImageElement | null;
    if (!cell || this.bypass) return;
    const cv = (this.stripCanvas ??= document.createElement("canvas"));
    cv.width = w;
    cv.height = h;
    const g = cv.getContext("2d");
    if (!g) return;
    const img = g.createImageData(w, h);
    // readPixels 是由下往上，翻轉成由上往下
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    g.putImageData(img, 0, 0);
    cell.src = cv.toDataURL("image/jpeg", 0.85);
  }

  private async refreshStrip(ids: number[]) {
    // 確定後端把縮圖列的照片當成可見（不會被取消），再重新載入縮圖
    await api.setViewport(this.host.session(), this.list.map((it) => it.id)).catch(() => {});
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
    if (this.cropping) this.leaveCrop();
    this.selSpot = -1;
    this.pdrag = null;
    this.spotsHidden = false;
    this.q("#ed-patch-eye").classList.remove("active");
    this.q("#ed-spot-sel").classList.add("hidden");
    this.setBefore(false);
    this.q("#ed-syncbox").classList.add("hidden");
    try {
      const r = await api.getEdit(this.host.session(), it.id);
      this.saved = clone({ ...ZERO, ...r, curve: (r.curve ?? []) as Pt[], hsl: normHsl(r.hsl), crop: normCrop(r.crop), spots: cleanSpots(r.spots) });
    } catch {
      this.saved = clone(ZERO);
    }
    this.p = clone(this.saved);
    this.lastP = clone(this.p);
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
      // 最多等 60 秒（避免後端出錯時一直顯示「載入中」）
      const ctl = new AbortController();
      const timer = window.setTimeout(() => ctl.abort(), 60000);
      const res = await fetch(url.base(this.host.session(), this.item.id), { signal: ctl.signal }).finally(() => clearTimeout(timer));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      if (seq !== this.loadSeq || !this.gl) return bmp.close();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      this.imgW = bmp.width;
      this.imgH = bmp.height;
      // 完整的原圖像素（修補要在 CPU 上算，算完再上傳成貼圖）
      {
        const cv = document.createElement("canvas");
        cv.width = bmp.width;
        cv.height = bmp.height;
        const g2 = cv.getContext("2d", { willReadFrequently: true })!;
        g2.drawImage(bmp, 0, 0);
        this.baseOrig = g2.getImageData(0, 0, bmp.width, bmp.height);
        this.baseKey = "";
        this.healCache.clear();
        // 先顯示原圖，修補稍後再套（修補多時要算一下，畫面不會卡在「載入中」）
        this.healPending = (this.p.spots ?? []).length > 0;
        this.uploadBase();
      }
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
      if (this.healPending) {
        msg.textContent = "套用修補中…";
        window.setTimeout(() => {
          if (seq !== this.loadSeq) return;
          this.healPending = false;
          try {
            this.uploadBase();
          } finally {
            if (seq === this.loadSeq) msg.textContent = "";
          }
          this.draw();
        }, 40);
      }
    } catch (e) {
      if (seq === this.loadSeq)
        msg.textContent = (e as Error)?.name === "AbortError" ? "載入照片逾時，請按 ← → 換一張再回來，或關閉後重新開啟" : `無法載入照片：${e}`;
    }
  }

  private draw() {
    this.checkMulti();
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

  private setUniforms(scaleX: number, scaleY: number, f: Crop, outside: boolean) {
    const gl = this.gl!;
    const u = (k: string) => gl.getUniformLocation(this.prog!, k);
    const p = this.p;
    const g = wbGains(p);
    gl.uniform2f(u("u_scale"), scaleX, scaleY);
    gl.uniform2f(u("u_fc"), f.cx, f.cy);
    gl.uniform2f(u("u_fs"), f.w, f.h);
    gl.uniform2f(u("u_img"), this.imgW, this.imgH);
    const ar = (f.a * Math.PI) / 180;
    gl.uniform2f(u("u_rot"), Math.cos(ar), Math.sin(ar));
    gl.uniform1f(u("u_outside"), outside ? 1 : 0);
    gl.uniform1f(u("u_viz"), this.vizOn() ? 4 + Number(this.q<HTMLInputElement>("#ed-viz-amt").value) * 0.6 : 0);
    gl.uniform2f(u("u_texel"), 1 / Math.max(1, this.imgW), 1 / Math.max(1, this.imgH));
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
    this.uploadBase();
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
    const f = this.viewFrame();
    const pad = 16 * dpr;
    const s = Math.min((cw - pad * 2) / f.w, (ch - pad * 2) / f.h);
    this.setUniforms((f.w * s) / cw, (f.h * s) / ch, f, this.cropping);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.drawOverlay();
  }

  /** 把調整後的影像縮小畫到離屏緩衝區，讀回像素算色階分布 */
  private computeHist() {
    const gl = this.gl;
    if (!gl || !this.prog || !this.imgW || !this.isOpen || !this.fbo || !this.fboTex) return;
    // 色階分布看裁切後的範圍
    const f = this.cropFrame();
    const long = 256;
    const sc = long / Math.max(f.w, f.h);
    const w = Math.max(1, Math.round(f.w * sc));
    const h = Math.max(1, Math.round(f.h * sc));
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
    this.setUniforms(1, 1, f, false);
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
    this.updateStripThumb(px, w, h);
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
  private tool: "wb" | "hsl" | "curve" | null = null;
  /** 縮小的原始影像（滴管取色用） */
  private sample: ImageData | null = null;
  private tdrag: { x: number; i: number; j: number; t: number; start: number[] } | null = null;
  /** 曲線目標調整：拖曳中的控制點（輸入值）與起始輸出值 */
  private cdragCurve: { y: number; px: number; py0: number } | null = null;
  /** 套用曲線之前的影像（小張），曲線目標調整取「輸入值」用；設定變了就重算 */
  private preCurve: { key: string; px: Uint8Array; w: number; h: number } | null = null;

  private toolCursor() {
    return this.tool === "wb" ? CUR_DROPPER : this.tool === "curve" ? CUR_UPDOWN : this.tool === "hsl" ? CUR_LEFTRIGHT : "";
  }

  /** 滑鼠位置在「套用曲線前」的亮度（0–255，近 3×3 平均）；不在照片上回傳 null */
  private curveInputAt(e: PointerEvent): number | null {
    const gl = this.gl;
    if (!gl || !this.prog || !this.fbo || !this.fboTex || !this.imgW) return null;
    const f = this.cropFrame();
    const { curve: _c, ...rest } = this.p;
    void _c;
    const key = JSON.stringify([rest, f, this.loadSeq]);
    if (!this.preCurve || this.preCurve.key !== key) {
      const long = 384;
      const sc = long / Math.max(f.w, f.h);
      const w = Math.max(1, Math.round(f.w * sc));
      const h = Math.max(1, Math.round(f.h * sc));
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.fboW = w;
      this.fboH = h;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
      gl.viewport(0, 0, w, h);
      this.setUniforms(1, 1, f, false);
      gl.uniform1f(gl.getUniformLocation(this.prog, "u_useLut"), 0);
      gl.uniform1f(gl.getUniformLocation(this.prog, "u_bypass"), 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.preCurve = { key, px, w, h };
      this.render();
    }
    const pc = this.preCurve;
    const [fx, fy] = this.screenToFrame(e.clientX, e.clientY);
    const u = fx / f.w + 0.5;
    const v = fy / f.h + 0.5;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const cx = Math.min(pc.w - 1, Math.floor(u * pc.w));
    const cy = Math.min(pc.h - 1, Math.floor((1 - v) * pc.h));
    let sum = 0;
    let n = 0;
    for (let y = Math.max(0, cy - 1); y <= Math.min(pc.h - 1, cy + 1); y++)
      for (let x = Math.max(0, cx - 1); x <= Math.min(pc.w - 1, cx + 1); x++) {
        const k = (y * pc.w + x) * 4;
        sum += (pc.px[k] + pc.px[k + 1] + pc.px[k + 2]) / 3;
        n++;
      }
    return Math.round(sum / n);
  }

  // ---------------------------------------------------------------- 裁切

  /** 裁切模式中 */
  private cropping = false;
  /** 裁切模式中正在調整的框（原圖像素；套用時才寫回 p.crop） */
  private draft: Crop | null = null;
  /** 進入裁切模式時的設定（Esc 取消時還原） */
  private cropEntry: number[] = [];
  /** 旋轉時以這個大小為準（轉回來時框會長回原本大小） */
  private rotBase = { w: 0, h: 0 };
  /** 鎖定比例時是直式 */
  private portrait = false;
  private leveling = false;
  private overlay!: HTMLCanvasElement;
  private cdrag:
    | { kind: "move" | "resize" | "rotate" | "level"; hx: number; hy: number; x: number; y: number; x2?: number; y2?: number; c0: Crop; ang0: number }
    | null = null;

  /** 目前畫面顯示的範圍：裁切模式中是整張照片（轉了角度的外框），否則是裁切後的範圍 */
  private viewFrame(): Crop {
    if (this.cropping && this.draft) return bboxFrame(this.imgW, this.imgH, this.draft.a);
    return this.cropFrame();
  }

  /** 裁切後的範圍（沒有裁切 = 整張） */
  private cropFrame(): Crop {
    if (this.cropping && this.draft) return this.draft;
    return fromNorm(this.p.crop, this.imgW, this.imgH) ?? fullCrop(this.imgW, this.imgH);
  }

  /** 畫面上的縮放比例與中心（CSS 像素） */
  private view() {
    const r = this.q("#ed-stage").getBoundingClientRect();
    const f = this.viewFrame();
    const s = Math.min((r.width - 32) / f.w, (r.height - 32) / f.h);
    return { r, f, s, ox: r.left + r.width / 2, oy: r.top + r.height / 2 };
  }

  /** 螢幕座標 → 顯示範圍的框座標（像素） */
  private screenToFrame(x: number, y: number): [number, number] {
    const v = this.view();
    return [(x - v.ox) / v.s, (y - v.oy) / v.s];
  }

  /** 裁切框在顯示範圍框座標中的上下左右 */
  private draftBox() {
    const d = this.draft!;
    const f = this.viewFrame();
    const [x, y] = toFrame(f, d.cx, d.cy);
    return { l: x - d.w / 2, r: x + d.w / 2, t: y - d.h / 2, b: y + d.h / 2 };
  }

  private boxToCrop(b: { l: number; r: number; t: number; b: number }, a: number): Crop {
    const f = this.viewFrame();
    const [cx, cy] = toImg(f, (b.l + b.r) / 2, (b.t + b.b) / 2);
    return { cx, cy, w: b.r - b.l, h: b.b - b.t, a };
  }

  enterCrop() {
    if (this.cropping || !this.imgW) return;
    if (this.tool) this.setTool(null);
    if (this.ptool !== null) this.setPatch(null);
    this.cropping = true;
    this.cropEntry = normCrop(this.p.crop);
    this.draft = fromNorm(this.p.crop, this.imgW, this.imgH) ?? fullCrop(this.imgW, this.imgH);
    this.rotBase = { w: this.draft.w, h: this.draft.h };
    this.portrait = this.draft.h > this.draft.w;
    this.overlay.classList.add("on");
    this.q("#ed-crop-tool").classList.add("active");
    const sec = this.q('[data-sec="crop"]');
    if (sec.classList.contains("collapsed")) (sec.querySelector(".ed-sec-head") as HTMLElement).click();
    this.hint("拖曳框角或邊調整 · 框內拖曳移動 · 框外拖曳旋轉 · 雙擊或 Enter 套用 · Esc 取消");
    if (this.bypass) this.setBefore(false);
    this.markChanged();
    this.draw();
  }

  /** 套用裁切（離開裁切模式） */
  commitCrop() {
    if (!this.cropping || !this.draft) return;
    this.p.crop = toNorm(this.draft, this.imgW, this.imgH);
    this.leaveCrop();
  }

  cancelCrop() {
    if (!this.cropping) return;
    this.p.crop = [...this.cropEntry];
    this.leaveCrop();
  }

  private leaveCrop() {
    this.cropping = false;
    this.draft = null;
    this.cdrag = null;
    this.setLeveling(false);
    this.overlay.classList.remove("on");
    this.q("#ed-crop-tool").classList.remove("active");
    this.hint("");
    this.markChanged();
    this.draw();
  }

  private setLeveling(on: boolean) {
    this.leveling = on;
    this.q("#ed-level-tool").classList.toggle("active", on);
    if (this.cropping) {
      this.hint(on ? "拉直：沿著照片中應該水平或垂直的線拖曳" : "拖曳框角或邊調整 · 框內拖曳移動 · 框外拖曳旋轉 · 雙擊或 Enter 套用 · Esc 取消");
    }
  }

  /** 目前的比例（寬 / 高）；不限制 = null */
  private lockedRatio(): number | null {
    const id = this.q<HTMLSelectElement>("#ed-ratio").value;
    const preset = RATIOS.find((r) => r.id === id);
    if (!preset || preset.r === null) return null;
    const long = preset.r === 0 ? Math.max(this.imgW, this.imgH) / Math.min(this.imgW, this.imgH) : preset.r;
    return this.portrait ? 1 / long : long;
  }

  /** 選了比例：在目前位置放最大的那個比例的框（放不太下時改放在照片中央） */
  private applyRatio() {
    const d = this.draft;
    if (!d) return;
    const r = this.lockedRatio();
    if (r === null) return this.draw();
    const here = largestAt(d.cx, d.cy, r, d.a, this.imgW, this.imgH);
    const mid = largestAt(this.imgW / 2, this.imgH / 2, r, d.a, this.imgW, this.imgH);
    this.draft = here.w * here.h < mid.w * mid.h * 0.6 ? mid : here;
    this.rotBase = { w: this.draft.w, h: this.draft.h };
    this.markChanged();
    this.draw();
  }

  /** 直式 / 橫式互換 */
  private swapOrient() {
    const d = this.draft;
    if (!d) return;
    this.portrait = !(d.h > d.w);
    if (this.lockedRatio() !== null) return this.applyRatio();
    this.draft = fitted({ ...d, w: d.h, h: d.w }, this.imgW, this.imgH);
    this.rotBase = { w: this.draft.w, h: this.draft.h };
    this.markChanged();
    this.draw();
  }

  /** 角度：以旋轉前的框大小為準，縮到放得下 */
  private setAngle(a: number, from?: HTMLInputElement) {
    const d = this.draft;
    if (!d) return;
    a = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, a));
    const base = { ...d, w: this.rotBase.w, h: this.rotBase.h, a };
    this.draft = fitted(base, this.imgW, this.imgH);
    this.syncCropInputs(from);
    this.markChanged();
    this.draw();
  }

  private syncCropInputs(except?: HTMLInputElement) {
    const a = this.cropping && this.draft ? this.draft.a : (normCrop(this.p.crop)[4] ?? 0);
    const txt = (Math.round(a * 10) / 10).toFixed(1);
    const num = this.q<HTMLInputElement>("#ed-angle-num");
    const rng = this.q<HTMLInputElement>("#ed-angle");
    if (num !== except) num.value = txt;
    if (rng !== except) rng.value = String(a);
    this.q("[data-crop-angle-reset]").classList.toggle("changed", Math.abs(a) > 0.005);
  }

  /** 滑鼠在裁切模式畫面上的位置對應到什麼：8 個控制點、框內（移動）、框外（旋轉） */
  private hitCrop(x: number, y: number): { kind: "move" | "resize" | "rotate"; hx: number; hy: number } {
    const v = this.view();
    const b = this.draftBox();
    const sx = (fx: number) => v.ox + fx * v.s;
    const sy = (fy: number) => v.oy + fy * v.s;
    const L = sx(b.l);
    const R = sx(b.r);
    const T = sy(b.t);
    const B = sy(b.b);
    const tol = 9;
    const nearX = Math.abs(x - L) < tol ? -1 : Math.abs(x - R) < tol ? 1 : 0;
    const nearY = Math.abs(y - T) < tol ? -1 : Math.abs(y - B) < tol ? 1 : 0;
    const inX = x > L - tol && x < R + tol;
    const inY = y > T - tol && y < B + tol;
    if (inX && inY && (nearX || nearY)) {
      // 邊的中段也可以拖（只動那一邊）
      return { kind: "resize", hx: nearX, hy: nearY };
    }
    if (x > L && x < R && y > T && y < B) return { kind: "move", hx: 0, hy: 0 };
    return { kind: "rotate", hx: 0, hy: 0 };
  }

  private cropCursor(h: { kind: string; hx: number; hy: number }) {
    if (this.leveling) return "crosshair";
    if (h.kind === "move") return "move";
    if (h.kind === "rotate") return "alias";
    if (h.hx && h.hy) return h.hx === h.hy ? "nwse-resize" : "nesw-resize";
    return h.hx ? "ew-resize" : "ns-resize";
  }

  private cropDown(e: PointerEvent) {
    if (!this.cropping || !this.draft || e.button !== 0) return;
    e.preventDefault();
    const d = this.draft;
    if (this.leveling) {
      this.cdrag = { kind: "level", hx: 0, hy: 0, x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY, c0: { ...d }, ang0: d.a };
    } else {
      const h = this.hitCrop(e.clientX, e.clientY);
      const v = this.view();
      const b = this.draftBox();
      const bx = v.ox + ((b.l + b.r) / 2) * v.s;
      const by = v.oy + ((b.t + b.b) / 2) * v.s;
      this.cdrag = { ...h, x: e.clientX, y: e.clientY, c0: { ...d }, ang0: Math.atan2(e.clientY - by, e.clientX - bx) };
    }
    this.overlay.setPointerCapture(e.pointerId);
  }

  private cropMove(e: PointerEvent) {
    if (!this.cropping || !this.draft) return;
    const g = this.cdrag;
    if (!g) {
      this.overlay.style.cursor = this.cropCursor(this.hitCrop(e.clientX, e.clientY));
      return;
    }
    const W = this.imgW;
    const H = this.imgH;
    const v = this.view();
    if (g.kind === "level") {
      g.x2 = e.clientX;
      g.y2 = e.clientY;
      return this.drawOverlay();
    }
    if (g.kind === "rotate") {
      const b = this.draftBox();
      const bx = v.ox + ((b.l + b.r) / 2) * v.s;
      const by = v.oy + ((b.t + b.b) / 2) * v.s;
      const ang = Math.atan2(e.clientY - by, e.clientX - bx);
      let da = ((ang - g.ang0) * 180) / Math.PI;
      if (da > 180) da -= 360;
      if (da < -180) da += 360;
      return this.setAngle(Math.round((g.c0.a + da) * 10) / 10);
    }
    const f = this.viewFrame();
    const dx = (e.clientX - g.x) / v.s;
    const dy = (e.clientY - g.y) / v.s;
    const [fx0, fy0] = toFrame(f, g.c0.cx, g.c0.cy);
    if (g.kind === "move") {
      const at = (mx: number, my: number): Crop => {
        const [cx, cy] = toImg(f, fx0 + mx, fy0 + my);
        return { ...g.c0, cx, cy };
      };
      // 整段移動放不下時，先移到能放的地方，再沿著邊滑動
      const t = bisect((t) => fits(at(dx * t, dy * t), W, H));
      let mx = dx * t;
      let my = dy * t;
      const tx = bisect((t) => fits(at(mx + (dx - mx) * t, my), W, H));
      mx += (dx - mx) * tx;
      const ty = bisect((t) => fits(at(mx, my + (dy - my) * t), W, H));
      my += (dy - my) * ty;
      this.draft = at(mx, my);
    } else {
      const b0 = { l: fx0 - g.c0.w / 2, r: fx0 + g.c0.w / 2, t: fy0 - g.c0.h / 2, b: fy0 + g.c0.h / 2 };
      const [qx, qy] = this.screenToFrame(e.clientX, e.clientY);
      const min = Math.max(4, 12 / v.s);
      const r = this.lockedRatio();
      const b1 = { ...b0 };
      if (g.hx === 1) b1.r = Math.max(b0.l + min, qx);
      if (g.hx === -1) b1.l = Math.min(b0.r - min, qx);
      if (g.hy === 1) b1.b = Math.max(b0.t + min, qy);
      if (g.hy === -1) b1.t = Math.min(b0.b - min, qy);
      if (r !== null) {
        let w = b1.r - b1.l;
        let h = b1.b - b1.t;
        if (g.hx && g.hy) {
          // 角：以對角為固定點，取變動較大的一邊決定大小
          if (w / h > r) h = w / r;
          else w = h * r;
          if (g.hx === 1) b1.r = b1.l + w;
          else b1.l = b1.r - w;
          if (g.hy === 1) b1.b = b1.t + h;
          else b1.t = b1.b - h;
        } else if (g.hx) {
          h = w / r;
          const cy = (b0.t + b0.b) / 2;
          b1.t = cy - h / 2;
          b1.b = cy + h / 2;
        } else {
          w = h * r;
          const cx = (b0.l + b0.r) / 2;
          b1.l = cx - w / 2;
          b1.r = cx + w / 2;
        }
      }
      const lerp = (t: number) => ({
        l: b0.l + (b1.l - b0.l) * t,
        r: b0.r + (b1.r - b0.r) * t,
        t: b0.t + (b1.t - b0.t) * t,
        b: b0.b + (b1.b - b0.b) * t,
      });
      const t = bisect((t) => fits(this.boxToCrop(lerp(t), g.c0.a), W, H));
      this.draft = this.boxToCrop(lerp(t), g.c0.a);
    }
    this.rotBase = { w: this.draft.w, h: this.draft.h };
    this.markChanged();
    this.draw();
  }

  private cropUp(e: PointerEvent) {
    const g = this.cdrag;
    if (!g) return;
    this.cdrag = null;
    try {
      this.overlay.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (g.kind === "level" && this.draft) {
      const vx = (g.x2 ?? g.x) - g.x;
      const vy = (g.y2 ?? g.y) - g.y;
      if (Math.hypot(vx, vy) >= 10) {
        // 線在畫面上的方向 → 原圖上的方向 → 讓它變成水平（或垂直）的角度
        const f = this.viewFrame();
        const [ix, iy] = toImg({ ...f, cx: 0, cy: 0 }, vx, vy);
        let al = (Math.atan2(iy, ix) * 180) / Math.PI;
        if (al > 90) al -= 180;
        if (al <= -90) al += 180;
        if (Math.abs(al) > 45) al = al > 0 ? al - 90 : al + 90;
        this.rotBase = { w: this.draft.w, h: this.draft.h };
        this.setAngle(Math.round(-al * 10) / 10);
      }
      this.setLeveling(false);
      this.drawOverlay();
    }
  }

  /** 裁切模式的框線、暗化、三分線、控制點 */
  private drawOverlay() {
    const cv = this.overlay;
    if (!cv) return;
    const stage = this.q("#ed-stage");
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(stage.clientWidth * dpr));
    const h = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const g = cv.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    if (!this.cropping && this.ptool !== null && this.imgW) return this.drawPatchOverlay(g, dpr);
    if (!this.cropping || !this.draft || !this.imgW) return;
    const v = this.view();
    const b = this.draftBox();
    const X = (fx: number) => (stage.clientWidth / 2 + fx * v.s) * dpr;
    const Y = (fy: number) => (stage.clientHeight / 2 + fy * v.s) * dpr;
    const L = X(b.l);
    const R = X(b.r);
    const T = Y(b.t);
    const B = Y(b.b);
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.beginPath();
    g.rect(0, 0, w, h);
    g.rect(L, T, R - L, B - T);
    g.fill("evenodd");
    g.strokeStyle = "rgba(255,255,255,0.35)";
    g.lineWidth = 1 * dpr;
    g.beginPath();
    for (const k of [1, 2]) {
      g.moveTo(L + ((R - L) * k) / 3, T);
      g.lineTo(L + ((R - L) * k) / 3, B);
      g.moveTo(L, T + ((B - T) * k) / 3);
      g.lineTo(R, T + ((B - T) * k) / 3);
    }
    g.stroke();
    g.strokeStyle = "#fff";
    g.lineWidth = 1.5 * dpr;
    g.strokeRect(L, T, R - L, B - T);
    // 控制點：角是 L 形，邊是短線
    g.lineWidth = 3 * dpr;
    const k = 14 * dpr;
    g.beginPath();
    for (const [x, y, sx, sy] of [
      [L, T, 1, 1],
      [R, T, -1, 1],
      [L, B, 1, -1],
      [R, B, -1, -1],
    ]) {
      g.moveTo(x, y + sy * k);
      g.lineTo(x, y);
      g.lineTo(x + sx * k, y);
    }
    const mx = (L + R) / 2;
    const my = (T + B) / 2;
    g.moveTo(mx - k / 2, T);
    g.lineTo(mx + k / 2, T);
    g.moveTo(mx - k / 2, B);
    g.lineTo(mx + k / 2, B);
    g.moveTo(L, my - k / 2);
    g.lineTo(L, my + k / 2);
    g.moveTo(R, my - k / 2);
    g.lineTo(R, my + k / 2);
    g.stroke();
    // 拉直線
    const d = this.cdrag;
    if (d?.kind === "level" && d.x2 !== undefined && d.y2 !== undefined) {
      const r = stage.getBoundingClientRect();
      g.strokeStyle = "#f5b33a";
      g.lineWidth = 2 * dpr;
      g.beginPath();
      g.moveTo((d.x - r.left) * dpr, (d.y - r.top) * dpr);
      g.lineTo((d.x2 - r.left) * dpr, (d.y2 - r.top) * dpr);
      g.stroke();
    }
  }

  // ---------------------------------------------------------------- 修補

  /** 修補工具（null = 沒有在修補） */
  private ptool: SpotMode | null = null;
  private selSpot = -1;
  private brush = { size: 20, feather: 25, opacity: 100 };
  private baseOrig: ImageData | null = null;
  /** 套用修補後的影像（建立新修補時，自動找來源要看前面修補完的樣子） */
  private baseWork: ImageData | null = null;
  private baseKey = "";
  private phover: { x: number; y: number } | null = null;
  private pdrag:
    | { kind: "paint"; pts: [number, number][] }
    | { kind: "src" | "dest" | "custom"; i: number; x: number; y: number; d0: [number, number]; p0: [number, number][] }
    | null = null;
  private lastPtool: SpotMode = 0;
  private ovTmp: HTMLCanvasElement | null = null;
  /** 修補結果快取（換照片時清掉） */
  /** 剛載入照片、修補還沒套用（先顯示原圖） */
  private healPending = false;
  private healCache = new Map<string, { b: [number, number, number, number]; px: Uint8ClampedArray }>();
  /** 修補標題的眼睛：暫時不套用修補（比較前後） */
  private spotsHidden = false;
  /** 「重新整理」換到第幾好的來源 */
  private refreshRank = 0;
  private hoverSpot = -1;

  private vizOn() {
    return this.ptool !== null && this.q<HTMLInputElement>("#ed-viz").checked;
  }

  /** 修補有變時重新計算並上傳貼圖（沒變就什麼都不做） */
  private uploadBase() {
    const gl = this.gl;
    const base = this.baseOrig;
    if (!gl || !base) return;
    const spots = this.spotsHidden || this.healPending ? [] : (this.p.spots ?? []);
    const key = JSON.stringify(spots);
    if (key === this.baseKey) return;
    this.baseKey = key;
    let img = base;
    if (spots.length) {
      img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
      applySpots(img, spots, this.healCache);
    }
    this.baseWork = img;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  }

  /** 開始 / 結束修補（再按一次同一個工具 = 結束） */
  setPatch(m: SpotMode | null) {
    if (m !== null) {
      if (this.cropping) this.commitCrop();
      if (this.tool) this.setTool(null);
      this.lastPtool = m;
    }
    this.ptool = m;
    this.pdrag = null;
    if (m === null) this.selSpot = -1;
    this.el.querySelectorAll<HTMLElement>("[data-ptool]").forEach((b) => b.classList.toggle("active", Number(b.dataset.ptool) === m));
    const shown = m ?? this.lastPtool;
    this.q(".ed-feather-row").classList.toggle("hidden", shown === 0);
    this.q("#ed-ptool-name").textContent = SPOT_TOOLS[shown].label;
    this.syncSpotSel();
    this.overlay.classList.toggle("on", m !== null || this.cropping);
    this.overlay.style.cursor = m !== null ? "none" : "";
    if (m !== null) {
      const sec = this.q('[data-sec="patch"]');
      if (sec.classList.contains("collapsed")) (sec.querySelector(".ed-sec-head") as HTMLElement).click();
      if (this.bypass) this.setBefore(false);
      this.hint(`${SPOT_TOOLS[m].label}：在照片上塗抹要處理的地方 · Esc 結束`);
    } else this.hint("");
    this.draw();
  }

  private setBrush(k: "size" | "feather" | "opacity", v: number, from?: HTMLInputElement) {
    const lim = { size: [1, 200], feather: [0, 100], opacity: [1, 100] }[k];
    v = Math.round(Math.max(lim[0], Math.min(lim[1], v)));
    this.brush[k] = v;
    saveBrush(this.brush);
    for (const sel of [`[data-brush="${k}"]`, `[data-brush-num="${k}"]`]) {
      const inp = this.q<HTMLInputElement>(sel);
      if (inp !== from) inp.value = String(v);
    }
    // 有選取的修補時，一起改那一筆（與 Camera Raw 相同）
    const s = this.p.spots?.[this.selSpot];
    if (s) {
      if (k === "size") s.r = v / 2000;
      if (k === "feather") s.f = v / 100;
      if (k === "opacity") s.o = v / 100;
      this.markChanged();
    }
    this.draw();
  }

  /** 筆刷半徑（原圖像素） */
  private brushR() {
    return (this.brush.size / 2000) * Math.max(this.imgW, this.imgH);
  }

  private screenToImg(x: number, y: number): [number, number] {
    const [fx, fy] = this.screenToFrame(x, y);
    return toImg(this.viewFrame(), fx, fy);
  }

  private spotPx(s: Spot, src: boolean): { pts: [number, number][]; r: number } {
    const W = this.imgW;
    const H = this.imgH;
    const ox = src ? Math.round(s.d[0] * W) : 0;
    const oy = src ? Math.round(s.d[1] * H) : 0;
    return { pts: s.p.map(([x, y]) => [x * W + ox, y * H + oy] as [number, number]), r: s.r * Math.max(W, H) };
  }

  private patchDown(e: PointerEvent) {
    if (this.ptool === null || e.button !== 0) return;
    e.preventDefault();
    const [x, y] = this.screenToImg(e.clientX, e.clientY);
    const spots = this.p.spots ?? [];
    const hitSpot = (i: number, src: boolean) => {
      const q = this.spotPx(spots[i], src);
      return distToStroke(q.pts, x, y) <= Math.max(q.r, 6 / this.view().s);
    };
    let drag: typeof this.pdrag = null;
    if (this.selSpot >= 0 && spots[this.selSpot] && spots[this.selSpot].m !== 0 && hitSpot(this.selSpot, true)) {
      const s = spots[this.selSpot];
      drag = { kind: "src", i: this.selSpot, x, y, d0: [...s.d], p0: s.p.map((q) => [...q] as [number, number]) };
    } else {
      for (let i = spots.length - 1; i >= 0; i--) {
        if (hitSpot(i, false)) {
          if (this.selSpot !== i) this.refreshRank = 0;
          this.selSpot = i;
          this.syncBrushFromSpot(spots[i]);
          const s = spots[i];
          drag = { kind: "dest", i, x, y, d0: [...s.d], p0: s.p.map((q) => [...q] as [number, number]) };
          break;
        }
      }
    }
    // ⌘ + 拖曳：替選取的修補指定自訂來源（移除也可以）
    if (!drag && (e.metaKey || e.ctrlKey) && this.selSpot >= 0 && spots[this.selSpot]) {
      const s = spots[this.selSpot];
      drag = { kind: "custom", i: this.selSpot, x, y, d0: [...s.d], p0: s.p.map((q) => [...q] as [number, number]) };
    }
    if (!drag) {
      this.selSpot = -1;
      drag = { kind: "paint", pts: [[x, y]] };
    }
    this.pdrag = drag;
    this.syncSpotSel();
    this.overlay.setPointerCapture(e.pointerId);
    this.drawOverlay();
  }

  /** 選取某筆修補時，滑桿顯示它的設定 */
  private syncBrushFromSpot(s: Spot) {
    const vals = { size: Math.round(s.r * 2000), feather: Math.round(s.f * 100), opacity: Math.round(s.o * 100) };
    for (const k of ["size", "feather"] as const) {
      for (const sel of [`[data-brush="${k}"]`, `[data-brush-num="${k}"]`]) this.q<HTMLInputElement>(sel).value = String(vals[k]);
    }
    void vals.opacity;
  }

  private patchMove(e: PointerEvent) {
    if (this.ptool === null) return;
    this.phover = { x: e.clientX, y: e.clientY };
    const g = this.pdrag;
    if (!g) return this.drawOverlay();
    const [x, y] = this.screenToImg(e.clientX, e.clientY);
    const W = this.imgW;
    const H = this.imgH;
    if (g.kind === "paint") {
      const last = g.pts[g.pts.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) >= Math.max(1, this.brushR() * 0.3) && g.pts.length < MAX_SPOT_POINTS) g.pts.push([x, y]);
      return this.drawOverlay();
    }
    const s = this.p.spots[g.i];
    if (!s) return;
    const dx = (x - g.x) / W;
    const dy = (y - g.y) / H;
    if (g.kind === "src") s.d = [g.d0[0] + dx, g.d0[1] + dy];
    else if (g.kind === "custom") {
      // 來源中心跟著滑鼠：offset = 滑鼠位置 − 修補範圍中心
      const xs = s.p.map((q) => q[0]);
      const ys = s.p.map((q) => q[1]);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      s.d = [x / W - cx, y / H - cy];
    } else {
      // 移動修補範圍，來源留在原地
      s.p = g.p0.map(([px, py]) => [px + dx, py + dy] as [number, number]);
      s.d = [g.d0[0] - dx, g.d0[1] - dy];
    }
    this.markChanged();
    this.draw();
  }

  private patchUp(e: PointerEvent) {
    const g = this.pdrag;
    if (!g) return;
    this.pdrag = null;
    try {
      this.overlay.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (g.kind === "paint" && this.ptool !== null) {
      const W = this.imgW;
      const H = this.imgH;
      const spot: Spot = {
        m: this.ptool,
        r: this.brush.size / 2000,
        // 移除沒有羽化設定（與 Camera Raw 相同），固定柔和邊緣
        f: this.ptool === 0 ? 0.3 : this.brush.feather / 100,
        o: 1,
        d: [0, 0],
        p: g.pts.map(([x, y]) => [Math.round((x / W) * 100000) / 100000, Math.round((y / H) * 100000) / 100000] as [number, number]),
      };
      this.uploadBase();
      // 移除：自動擴大到蓋住整個物體（花瓣、灰塵常比筆刷大一點）
      if (this.baseWork && spot.m === 0) spot.r = Math.round(autoRadius(this.baseWork, spot) * 100000) / 100000;
      // 修復 / 仿製：自動找來源（之後可拖曳換位置）；移除：內容感知合成，不需要來源
      if (this.baseWork && spot.m !== 0) spot.d = findSource(this.baseWork, spot);
      this.p.spots = [...(this.p.spots ?? []), spot];
      this.selSpot = this.p.spots.length - 1;
      this.refreshRank = 0;
      this.markChanged();
      this.syncSpotSel();
    }
    this.draw();
  }

  /** 重新替第 i 筆找來源（rank = 第幾好的；「重新整理」每按一次換下一個） */
  private resample(i: number, rank: number) {
    const s = this.p.spots?.[i];
    const base = this.baseOrig;
    if (!s || !base) return;
    // 用「這一筆之前的修補都做完」的影像來找
    const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
    applySpots(img, this.p.spots.slice(0, i));
    s.d = findSource(img, s, rank);
    this.markChanged();
    this.syncSpotSel();
    this.draw();
  }

  /** 「已選取」區塊：有選取的修補才顯示，內容是那一筆的填滿方式與不透明度 */
  private syncSpotSel() {
    const s = this.p.spots?.[this.selSpot];
    this.q("#ed-spot-sel").classList.toggle("hidden", !s);
    if (!s) return;
    this.q<HTMLSelectElement>("#ed-spot-mode").value = String(s.m);
    for (const sel of ['[data-brush="opacity"]', '[data-brush-num="opacity"]']) this.q<HTMLInputElement>(sel).value = String(Math.round(s.o * 100));
  }

  deleteSpot() {
    if (this.selSpot < 0 || !this.p.spots?.[this.selSpot]) return;
    this.p.spots = this.p.spots.filter((_, i) => i !== this.selSpot);
    this.selSpot = -1;
    this.markChanged();
    this.syncSpotSel();
    this.draw();
  }

  undoSpot() {
    if (!this.p.spots?.length) return;
    this.p.spots = this.p.spots.slice(0, -1);
    this.selSpot = -1;
    this.markChanged();
    this.syncSpotSel();
    this.draw();
  }

  private drawPatchOverlay(g: CanvasRenderingContext2D, dpr: number) {
    const v = this.view();
    const f = v.f;
    const stage = this.q("#ed-stage");
    const toS = (x: number, y: number): [number, number] => {
      const [fx, fy] = toFrame(f, x, y);
      return [(stage.clientWidth / 2 + fx * v.s) * dpr, (stage.clientHeight / 2 + fy * v.s) * dpr];
    };
    const W = g.canvas.width;
    const H = g.canvas.height;
    // 筆刷形狀的「外框線」（仿 Camera Raw：細白線，不填色）：先畫粗線再挖掉內部
    const tmp = (this.ovTmp ??= document.createElement("canvas"));
    if (tmp.width !== W || tmp.height !== H) {
      tmp.width = W;
      tmp.height = H;
    }
    const tg = tmp.getContext("2d")!;
    const path = (c: CanvasRenderingContext2D, sp: [number, number][], rw: number, width: number) => {
      c.lineCap = "round";
      c.lineJoin = "round";
      c.lineWidth = width;
      c.beginPath();
      if (sp.length === 1) {
        c.moveTo(sp[0][0] - 0.01, sp[0][1]);
        c.lineTo(sp[0][0] + 0.01, sp[0][1]);
      } else sp.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.stroke();
      void rw;
    };
    const outline = (pts: [number, number][], r: number, color: string, fill?: string) => {
      const sp = pts.map(([x, y]) => toS(x, y));
      const rw = Math.max(1, r * v.s * dpr);
      const lw = 1.5 * dpr;
      tg.clearRect(0, 0, W, H);
      tg.globalCompositeOperation = "source-over";
      tg.strokeStyle = "#000";
      path(tg, sp, rw, rw * 2 + lw * 3);
      tg.strokeStyle = color;
      path(tg, sp, rw, rw * 2 + lw * 2);
      tg.globalCompositeOperation = "destination-out";
      tg.strokeStyle = "#000";
      path(tg, sp, rw, rw * 2);
      tg.globalCompositeOperation = "source-over";
      if (fill) {
        tg.strokeStyle = fill;
        path(tg, sp, rw, rw * 2);
      }
      g.drawImage(tmp, 0, 0);
      return sp;
    };
    // 標記（仿 Camera Raw）：直接畫工具圖示，選取中的是藍色，其他是白色；加深色陰影在亮處也看得到
    const pin = (x: number, y: number, m: SpotMode, active: boolean) => {
      const img = spotIcon(m, active ? "#3d8bfd" : "#ffffff");
      if (!img.complete) {
        img.onload = () => this.drawOverlay();
        return;
      }
      const z = 18 * dpr;
      g.save();
      g.shadowColor = "rgba(0,0,0,0.75)";
      g.shadowBlur = 3 * dpr;
      g.shadowOffsetY = 0.5 * dpr;
      g.drawImage(img, x - z / 2, y - z / 2, z, z);
      g.restore();
    };
    /** 標記放在修補範圍的中心 */
    const pinAt = (sp: [number, number][]): [number, number] => {
      const xs = sp.map((q) => q[0]);
      const ys = sp.map((q) => q[1]);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    };
    const show = this.q<HTMLInputElement>("#ed-ov-show").checked;
    // 滑鼠下的修補（顯示外框）
    let hover = -1;
    if (this.phover && !this.pdrag) {
      const [hx, hy] = this.screenToImg(this.phover.x, this.phover.y);
      const spots = this.p.spots ?? [];
      for (let i = spots.length - 1; i >= 0; i--) {
        const q = this.spotPx(spots[i], false);
        if (distToStroke(q.pts, hx, hy) <= q.r) {
          hover = i;
          break;
        }
      }
    }
    this.hoverSpot = hover;
    // 滑到已有的修補上：顯示移動游標（可以點選 / 拖曳），否則顯示筆刷圈
    this.overlay.style.cursor = hover >= 0 ? "move" : "none";
    (this.p.spots ?? []).forEach((s, i) => {
      const sel = i === this.selSpot;
      if (!show && !sel) return;
      const dst = this.spotPx(s, false);
      const sp = dst.pts.map(([x, y]) => toS(x, y));
      if (sel || i === hover) outline(dst.pts, dst.r, "#fff");
      if (sel && (s.m !== 0 || this.pdrag?.kind === "custom")) {
        // 修復 / 仿製：來源外框（黃）與連線
        const src = this.spotPx(s, true);
        const ss = outline(src.pts, src.r, "#f5b33a");
        g.setLineDash([4 * dpr, 4 * dpr]);
        g.lineWidth = 1.2 * dpr;
        g.strokeStyle = "#f5b33a";
        g.beginPath();
        g.moveTo(sp[0][0], sp[0][1]);
        g.lineTo(ss[0][0], ss[0][1]);
        g.stroke();
        g.setLineDash([]);
      }
      const [px, py] = pinAt(sp);
      pin(px, py, s.m, sel);
    });
    const d = this.pdrag;
    if (d?.kind === "paint") outline(d.pts, this.brushR(), "#fff", "rgba(255,255,255,0.18)");
    // 筆刷游標（外圈 = 大小，內圈 = 羽化開始的地方）
    if (this.phover && (!d || d.kind === "paint") && (this.hoverSpot < 0 || d?.kind === "paint")) {
      const r = stage.getBoundingClientRect();
      const cx = (this.phover.x - r.left) * dpr;
      const cy = (this.phover.y - r.top) * dpr;
      const rw = this.brushR() * v.s * dpr;
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = "#fff";
      g.beginPath();
      g.arc(cx, cy, rw, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = "#0008";
      g.lineWidth = 1 * dpr;
      g.beginPath();
      g.arc(cx, cy, rw + 1.5 * dpr, 0, Math.PI * 2);
      g.stroke();
      // 仿 Camera Raw：圓上四個短刻度 + 中心十字
      g.lineWidth = 1.5 * dpr;
      g.strokeStyle = "#fff";
      g.beginPath();
      const tk = Math.min(6 * dpr, rw * 0.5);
      for (const [ux, uy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        g.moveTo(cx + ux * (rw - tk), cy + uy * (rw - tk));
        g.lineTo(cx + ux * (rw + tk), cy + uy * (rw + tk));
      }
      const cp = 4 * dpr;
      g.moveTo(cx - cp, cy);
      g.lineTo(cx + cp, cy);
      g.moveTo(cx, cy - cp);
      g.lineTo(cx, cy + cp);
      g.stroke();
      // 修復 / 仿製：羽化範圍（內圈開始變淡、外圈完全透明）
      const fe = this.brush.feather / 100;
      if (this.ptool !== 0 && fe > 0.01) {
        g.setLineDash([3 * dpr, 3 * dpr]);
        g.strokeStyle = "#ffffffaa";
        for (const rr of [rw * (1 - fe), outerR(rw, fe)]) {
          if (rr < 2 * dpr) continue;
          g.beginPath();
          g.arc(cx, cy, rr, 0, Math.PI * 2);
          g.stroke();
        }
        g.setLineDash([]);
      }
    }
  }

  /** 開關滴管（再按一次同一個 = 關閉） */
  setTool(t: "wb" | "hsl" | "curve" | null) {
    if (t && this.cropping) this.commitCrop();
    if (t && this.ptool !== null) this.setPatch(null);
    this.tool = this.tool === t ? null : t;
    this.tdrag = null;
    this.cdragCurve = null;
    this.q("#ed-wb-pick").classList.toggle("active", this.tool === "wb");
    this.q("#ed-hsl-pick").classList.toggle("active", this.tool === "hsl");
    this.q("#ed-curve-pick").classList.toggle("active", this.tool === "curve");
    this.syncTat();
    this.canvas.style.cursor = this.toolCursor();
    if (this.tool) {
      // 確認對應的區塊是展開的，看得到數值變化
      const sec = this.q(`[data-sec="${this.tool === "wb" ? "color" : this.tool}"]`);
      if (sec.classList.contains("collapsed")) (sec.querySelector(".ed-sec-head") as HTMLElement).click();
    }
    this.hint(
      this.tool === "wb"
        ? "白平衡滴管：點選照片中應該是白色或灰色的地方（Esc 結束）"
        : this.tool === "hsl"
          ? `目標調整（${HSL_TABS[this.hslTab]}）：在照片上按住某個顏色，往右拖增加、往左拖減少（Esc 結束）`
          : this.tool === "curve"
            ? "曲線目標調整：在照片上按住某個地方，往上拖變亮、往下拖變暗（Esc 結束）"
            : "",
    );
  }

  /** 浮動工具列：曲線 / HSL 目標調整時顯示，HSL 時才有色相 / 飽和度 / 明度分頁 */
  private syncTat() {
    const tat = this.q("#ed-tat");
    const on = this.tool === "curve" || this.tool === "hsl";
    tat.classList.toggle("hidden", !on);
    this.q("#ed-stage").classList.toggle("tat-on", on);
    tat.querySelectorAll<HTMLElement>("[data-tat]").forEach((b) => b.classList.toggle("active", b.dataset.tat === this.tool));
    tat.querySelector<HTMLElement>(".ed-tat-tabs")!.classList.toggle("hidden", this.tool !== "hsl");
    tat.querySelector<HTMLElement>(".ed-tat-sep")!.classList.toggle("hidden", this.tool !== "hsl");
    tat.querySelectorAll<HTMLElement>("[data-tat-tab]").forEach((b) => b.classList.toggle("active", Number(b.dataset.tatTab) === this.hslTab));
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
    const v0 = this.screenToFrame(e.clientX, e.clientY);
    const f = this.viewFrame();
    if (Math.abs(v0[0]) > f.w / 2 || Math.abs(v0[1]) > f.h / 2) return null;
    const [ix, iy] = toImg(f, v0[0], v0[1]);
    const u = ix / this.imgW;
    const v = iy / this.imgH;
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
    if (this.tool === "curve") {
      const x = this.curveInputAt(e);
      if (x === null) return;
      // 這個亮度附近已有控制點就拖那一點，沒有就在曲線上加一點
      let pts = (cleanCurve(this.p.curve).length ? this.p.curve : [[0, 0], [255, 255]]).map((q) => [...q] as Pt);
      let k = pts.findIndex((q) => Math.abs(q[0] - x) <= 6);
      if (k < 0) {
        const lut = curveLut(pts);
        const xx = Math.min(254, Math.max(1, x));
        pts.push([xx, lut ? Math.round(lut[xx] * 255) : xx]);
        pts.sort((a, b) => a[0] - b[0]);
        k = pts.findIndex((q) => q[0] === xx);
      }
      this.p.curve = pts;
      this.curveEd.set(pts);
      this.cdragCurve = { y: e.clientY, px: pts[k][0], py0: pts[k][1] };
      this.canvas.setPointerCapture(e.pointerId);
      return this.toolMove(e);
    }
    const { hue, sat } = hueOf(this.afterWb(c));
    if (sat < 0.08) return this.hint("這裡幾乎沒有顏色，請按住有顏色的地方拖曳");
    const b = bandsOf(hue);
    this.tdrag = { x: e.clientX, ...b, start: normHsl(this.p.hsl) };
    this.canvas.setPointerCapture(e.pointerId);
    this.toolMove(e);
  }

  private toolMove(e: PointerEvent) {
    if (this.tool === "curve") {
      const g = this.cdragCurve;
      if (!g) {
        const x = this.curveInputAt(e);
        return this.hint(x === null ? "曲線目標調整：在照片上按住某個地方上下拖曳" : `曲線目標調整：這裡的亮度 ${x}　按住上下拖曳`);
      }
      const pts = this.p.curve.map((q) => [...q] as Pt);
      const k = pts.findIndex((q) => q[0] === g.px);
      if (k < 0) return;
      pts[k][1] = Math.round(Math.max(0, Math.min(255, g.py0 + (g.y - e.clientY) * 0.5)));
      this.p.curve = pts;
      this.curveEd.set(pts);
      this.updateLut();
      this.markChanged();
      if (this.bypass) this.setBefore(false);
      this.draw();
      return this.hint(`曲線：輸入 ${pts[k][0]} · 輸出 ${pts[k][1]}`);
    }
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
      return this.hint(`目標調整（${HSL_TABS[this.hslTab]}）：${names}　按住左右拖曳`);
    }
    const delta = (e.clientX - d.x) * 0.5;
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
    if (!this.tdrag && !this.cdragCurve) return;
    this.tdrag = null;
    this.cdragCurve = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.canvas.style.cursor = this.toolCursor();
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
    if (this.tool) this.syncTat();
    if (this.tool === "hsl") this.hint(`目標調整（${HSL_TABS[t]}）：在照片上按住某個顏色，往右拖增加、往左拖減少（Esc 結束）`);
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
    const any = (keys: NumKey[]) => keys.some((k) => Math.abs(this.p[k]) > 1e-4);
    const state: Record<Sec, boolean> = {
      basic: any(GROUPS[0].items.map((s) => s.key)),
      color: any(GROUPS[1].items.map((s) => s.key)),
      hsl: hslActive(normHsl(this.p.hsl)),
      curve: cleanCurve(this.p.curve).length > 0,
      patch: (this.p.spots ?? []).length > 0,
      crop: this.cropping ? toNorm(this.draft!, this.imgW, this.imgH).length > 0 : normCrop(this.p.crop).length > 0,
    };
    this.syncCropInputs();
    for (const k of Object.keys(state) as Sec[]) this.q(`[data-sec="${k}"]`).classList.toggle("has-changes", state[k]);
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
    await this.refreshStrip(ids.filter((id) => id !== this.item.id || !this.isOpen));
  }

  /** 有改過才存 */
  private async saveCurrent() {
    if (this.cropping) this.commitCrop();
    if (same(this.p, this.saved)) return;
    const params = clone(this.p);
    await this.save([this.item.id], params);
    this.saved = params;
  }

  async goto(next: number) {
    if (next < 0 || next >= this.list.length || next === this.pos) return;
    if (this.multiFields.size) {
      clearTimeout(this.multiTimer);
      await this.flushMulti();
    }
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
    clearTimeout(this.multiTimer);
    if (save && this.multiFields.size) await this.flushMulti();
    this.multiFields.clear();
    if (!save && this.multiOrig.size) {
      // 取消：把同步改過的其他照片還原
      for (const [id, orig] of this.multiOrig) {
        if (id === this.item.id) continue;
        await this.save([id], orig).catch(() => {});
      }
    }
    this.multiOrig.clear();
    this.lastP = null;
    if (save) {
      try {
        await this.saveCurrent();
      } catch (e) {
        this.host.toast(`無法儲存調整：${e}`);
        return;
      }
    }
    if (this.tool) this.setTool(null);
    if (this.cropping) this.cancelCrop();
    if (this.ptool !== null) this.setPatch(null);
    this.baseOrig = null;
    this.baseWork = null;
    this.baseKey = "";
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
    if (ev.key === "Escape" && this.cropping) return this.cancelCrop(), true;
    if (ev.key === "Enter" && this.cropping && !typing) return this.commitCrop(), true;
    if (ev.key === "Escape" && this.ptool !== null) return (this.selSpot >= 0 ? ((this.selSpot = -1), this.drawOverlay()) : this.setPatch(null)), true;
    if (ev.key === "Escape" && this.tool) return this.setTool(null), true;
    if (ev.key === "Escape") {
      const box = this.q("#ed-syncbox");
      if (!box.classList.contains("hidden")) return box.classList.add("hidden"), true;
      return void this.close(false), true;
    }
    if (ev.key === "Enter" && !typing) return void this.close(true), true;
    if (typing) return false;
    if (ev.key === "\\") return this.toggleBefore(), true;
    if (!ev.metaKey && !ev.ctrlKey && ev.key.toLowerCase() === "b") return this.setPatch(this.ptool !== null ? null : this.lastPtool), true;
    if (this.ptool !== null) {
      if (ev.key === "Delete" || ev.key === "Backspace") return this.deleteSpot(), true;
      if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "z") return this.undoSpot(), true;
      if (ev.key === "[") return this.setBrush("size", this.brush.size * 0.85), true;
      if (ev.key === "]") return this.setBrush("size", Math.max(this.brush.size + 1, this.brush.size * 1.15)), true;
    }
    if (!ev.metaKey && !ev.ctrlKey && ev.key.toLowerCase() === "c") return (this.cropping ? this.commitCrop() : this.enterCrop()), true;
    if (!ev.metaKey && !ev.ctrlKey && ev.key.toLowerCase() === "x" && this.cropping) return this.swapOrient(), true;
    if (!ev.metaKey && !ev.ctrlKey && ev.key.toLowerCase() === "i") return this.setTool("wb"), true;
    if (!ev.metaKey && !ev.ctrlKey && ev.key.toLowerCase() === "t") return this.setTool("hsl"), true;
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "a") return this.selectAllStrip(), true;
    if (ev.key === "ArrowLeft") return void this.goto(this.pos - 1), true;
    if (ev.key === "ArrowRight") return void this.goto(this.pos + 1), true;
    return true; // 其他按鍵不傳到背後的主畫面（避免誤評分）
  }
}
