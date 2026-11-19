// 裁切的幾何計算（與 src-tauri/src/edit.rs 的 CropPx 相同）。
// 座標：原圖像素，x 向右、y 向下。裁切框以中心、寬高、角度表示；角度正 = 照片順時針轉。
// 「框座標」= 以框中心為原點、沿著框的方向（框永遠是正的，照片在下面轉）。

export interface Crop {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** 度，−45…45 */
  a: number;
}

export const MAX_ANGLE = 45;

/** 框座標 → 原圖座標 */
export function toImg(c: Crop, dx: number, dy: number): [number, number] {
  const r = (c.a * Math.PI) / 180;
  const s = Math.sin(r);
  const k = Math.cos(r);
  return [c.cx + k * dx + s * dy, c.cy - s * dx + k * dy];
}

/** 原圖座標 → 框座標 */
export function toFrame(c: Crop, x: number, y: number): [number, number] {
  const r = (c.a * Math.PI) / 180;
  const s = Math.sin(r);
  const k = Math.cos(r);
  const qx = x - c.cx;
  const qy = y - c.cy;
  return [k * qx - s * qy, s * qx + k * qy];
}

/** 四個角都在原圖裡 */
export function fits(c: Crop, W: number, H: number): boolean {
  const e = 0.01;
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    const [x, y] = toImg(c, (sx * c.w) / 2, (sy * c.h) / 2);
    if (x < -e || x > W + e || y < -e || y > H + e) return false;
  }
  return true;
}

/** ok(0) 為真時，找出 ok 仍為真的最大 t（0–1） */
export function bisect(ok: (t: number) => boolean): number {
  if (ok(1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2;
    if (ok(m)) lo = m;
    else hi = m;
  }
  return lo;
}

/** 放不下時以中心縮小到剛好放得下（與 edit.rs CropPx::fitted 相同） */
export function fitted(c: Crop, W: number, H: number): Crop {
  const b = { ...c, cx: Math.min(W, Math.max(0, c.cx)), cy: Math.min(H, Math.max(0, c.cy)) };
  if (fits(b, W, H)) return b;
  const t = bisect((t) => t > 0 && fits({ ...b, w: b.w * t, h: b.h * t }, W, H));
  return { ...b, w: b.w * t, h: b.h * t };
}

export function fullCrop(W: number, H: number): Crop {
  return { cx: W / 2, cy: H / 2, w: W, h: H, a: 0 };
}

/** 存檔用的比例格式 [cx, cy, w, h, 角度] ↔ 像素 */
export function fromNorm(n: number[] | undefined, W: number, H: number): Crop | null {
  if (!n || n.length !== 5 || n.some((x) => !Number.isFinite(x))) return null;
  return fitted({ cx: n[0] * W, cy: n[1] * H, w: n[2] * W, h: n[3] * H, a: n[4] }, W, H);
}

export function toNorm(c: Crop, W: number, H: number): number[] {
  const n = [c.cx / W, c.cy / H, c.w / W, c.h / H, c.a];
  const full = n[2] > 0.9995 && n[3] > 0.9995 && Math.abs(n[4]) < 0.005 && Math.abs(n[0] - 0.5) < 0.0005 && Math.abs(n[1] - 0.5) < 0.0005;
  return full ? [] : n.map((v) => Math.round(v * 100000) / 100000);
}

/** 照片轉了 a 度之後的外框（裁切模式中顯示整張照片用） */
export function bboxFrame(W: number, H: number, a: number): Crop {
  const r = (a * Math.PI) / 180;
  const s = Math.abs(Math.sin(r));
  const k = Math.abs(Math.cos(r));
  return { cx: W / 2, cy: H / 2, w: W * k + H * s, h: W * s + H * k, a };
}

/** 在 (cx, cy) 放得下、比例 r（寬 / 高）的最大裁切框 */
export function largestAt(cx: number, cy: number, r: number, a: number, W: number, H: number): Crop {
  const w0 = (W + H) * 2;
  const base = { cx, cy, w: w0, h: w0 / r, a };
  const t = bisect((t) => t > 0 && fits({ ...base, w: base.w * t, h: base.h * t }, W, H));
  return { ...base, w: base.w * t, h: base.h * t };
}

/** 長寬比預設（r = 長邊 / 短邊；null = 不限制；orig = 原始比例） */
export const RATIOS: { id: string; label: string; r: number | null }[] = [
  { id: "orig", label: "原始比例", r: 0 },
  { id: "free", label: "不限制", r: null },
  { id: "1:1", label: "1 : 1", r: 1 },
  { id: "4:5", label: "4 : 5（8 : 10）", r: 5 / 4 },
  { id: "5:7", label: "5 : 7", r: 7 / 5 },
  { id: "2:3", label: "2 : 3（4 : 6）", r: 3 / 2 },
  { id: "3:4", label: "3 : 4", r: 4 / 3 },
  { id: "16:9", label: "16 : 9", r: 16 / 9 },
];
