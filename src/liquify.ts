// 液化（仿 Photoshop 液化濾鏡的向前彎曲 / 膨脹 / 縮攏 / 重建）。與 src-tauri/src/liquify.rs 的演算法相同。
// - 每一筆是筆刷路徑（點相對原圖寬高）＋半徑（相對長邊）＋強度
// - 依序重播所有筆刷，算出一張「位移場」（在固定格點上，與解析度無關），
//   輸出的每個像素到原圖「位置 + 位移」取樣；所以縮圖、預覽、原尺寸轉存結果都一樣
// - 按住不動時會持續加入同一點（膨脹 / 縮攏 / 重建越按越多）

export type LiqMode = 0 | 1 | 2 | 3; // 0 推移、1 膨脹、2 縮攏、3 重建

export interface LiqStroke {
  m: LiqMode;
  /** 半徑（相對長邊） */
  r: number;
  /** 強度 0–1 */
  s: number;
  /** 路徑（相對寬高） */
  p: [number, number][];
}

export const MAX_LIQ_POINTS = 3000;
export const MAX_LIQ_STROKES = 300;
/** 長邊的格數 */
const G = 400;

export function cleanLiquify(v: unknown): LiqStroke[] {
  if (!Array.isArray(v)) return [];
  const out: LiqStroke[] = [];
  for (const s of v) {
    if (!s || typeof s !== "object") continue;
    const m = Number((s as LiqStroke).m);
    const r = Number((s as LiqStroke).r);
    const st = Number((s as LiqStroke).s);
    const p = Array.isArray((s as LiqStroke).p) ? (s as LiqStroke).p : [];
    if (![0, 1, 2, 3].includes(m) || !(r > 0) || !(st > 0)) continue;
    const pts = p
      .filter((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))
      .slice(0, MAX_LIQ_POINTS)
      .map((q) => [Math.min(2, Math.max(-1, q[0])), Math.min(2, Math.max(-1, q[1]))] as [number, number]);
    if (!pts.length) continue;
    out.push({ m: m as LiqMode, r: Math.min(0.5, Math.max(0.001, r)), s: Math.min(1, Math.max(0.01, st)), p: pts });
    if (out.length >= MAX_LIQ_STROKES) break;
  }
  return out;
}

/** 位移場：格點 (i, j) 在長邊單位的 (i/G, j/G)，值也是長邊單位 */
export class LiqField {
  readonly gw: number;
  readonly gh: number;
  readonly dx: Float32Array;
  readonly dy: Float32Array;
  /** 圖的寬高（長邊單位） */
  readonly aw: number;
  readonly ah: number;
  constructor(W: number, H: number) {
    const L = Math.max(W, H);
    this.aw = W / L;
    this.ah = H / L;
    this.gw = Math.ceil(this.aw * G) + 2;
    this.gh = Math.ceil(this.ah * G) + 2;
    this.dx = new Float32Array(this.gw * this.gh);
    this.dy = new Float32Array(this.gw * this.gh);
  }

  /** 雙線性取樣位移（長邊單位座標） */
  sample(u: number, v: number, dx = this.dx, dy = this.dy): [number, number] {
    const gx = Math.min(this.gw - 1.001, Math.max(0, u * G));
    const gy = Math.min(this.gh - 1.001, Math.max(0, v * G));
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const tx = gx - i;
    const ty = gy - j;
    const k = j * this.gw + i;
    const g = this.gw;
    const a = dx[k] * (1 - tx) + dx[k + 1] * tx;
    const b = dx[k + g] * (1 - tx) + dx[k + g + 1] * tx;
    const c = dy[k] * (1 - tx) + dy[k + 1] * tx;
    const d = dy[k + g] * (1 - tx) + dy[k + g + 1] * tx;
    return [a * (1 - ty) + b * ty, c * (1 - ty) + d * ty];
  }

  /** 一個筆觸點。回傳影響範圍（長邊單位）[u0, v0, u1, v1] */
  dab(mode: LiqMode, cu: number, cv: number, r: number, k: number, vu: number, vv: number): [number, number, number, number] {
    const i0 = Math.max(0, Math.floor((cu - r) * G));
    const i1 = Math.min(this.gw - 1, Math.ceil((cu + r) * G));
    const j0 = Math.max(0, Math.floor((cv - r) * G));
    const j1 = Math.min(this.gh - 1, Math.ceil((cv + r) * G));
    if (i1 < i0 || j1 < j0) return [cu, cv, cu, cv];
    const bw = i1 - i0 + 1;
    const nx = new Float32Array(bw * (j1 - j0 + 1));
    const ny = new Float32Array(bw * (j1 - j0 + 1));
    // 先算新值（從舊的場取樣），再一次寫回
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * this.gw + i;
        const o = (j - j0) * bw + (i - i0);
        const u = i / G;
        const v = j / G;
        const t = Math.hypot(u - cu, v - cv) / r;
        if (t >= 1) {
          nx[o] = this.dx[idx];
          ny[o] = this.dy[idx];
          continue;
        }
        const w = k * (1 - t * t) * (1 - t * t);
        if (mode === 3) {
          const f = 1 - 0.25 * w;
          nx[o] = this.dx[idx] * f;
          ny[o] = this.dy[idx] * f;
          continue;
        }
        let su: number;
        let sv: number;
        if (mode === 0) {
          su = u - w * vu;
          sv = v - w * vv;
        } else {
          const f = mode === 1 ? 1 - 0.12 * w : 1 + 0.12 * w;
          su = cu + (u - cu) * f;
          sv = cv + (v - cv) * f;
        }
        const [ox, oy] = this.sample(su, sv);
        nx[o] = ox + su - u;
        ny[o] = oy + sv - v;
      }
    }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const o = (j - j0) * bw + (i - i0);
        this.dx[j * this.gw + i] = nx[o];
        this.dy[j * this.gw + i] = ny[o];
      }
    }
    const m = r + 1.5 / G;
    return [cu - m, cv - m, cu + m, cv + m];
  }

  /** 套用一筆的第 from 點之後（from = 0 從頭）。回傳影響範圍（長邊單位），沒有則 null */
  applyStroke(s: LiqStroke, from = 0): [number, number, number, number] | null {
    const pts = s.p.map(([x, y]) => [x * this.aw, y * this.ah] as [number, number]);
    let box: [number, number, number, number] | null = null;
    const grow = (b: [number, number, number, number]) => {
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
    };
    if (from === 0 && pts.length && s.m !== 0) grow(this.dab(s.m, pts[0][0], pts[0][1], s.r, s.s, 0, 0));
    for (let i = Math.max(1, from); i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      const len = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(len / (s.r * 0.25)));
      for (let q = 1; q <= n; q++) {
        const cx = ax + ((bx - ax) * q) / n;
        const cy = ay + ((by - ay) * q) / n;
        if (s.m === 0) {
          if (len > 0) grow(this.dab(0, cx - (bx - ax) / n, cy - (by - ay) / n, s.r, s.s, (bx - ax) / n, (by - ay) / n));
        } else grow(this.dab(s.m, cx, cy, s.r, s.s, 0, 0));
      }
    }
    return box;
  }

  static build(strokes: LiqStroke[], W: number, H: number): LiqField {
    const f = new LiqField(W, H);
    for (const s of strokes) f.applyStroke(s);
    return f;
  }
}

/**
 * 依位移場把 src 變形寫到 dst（同尺寸 RGBA）。rect = 只處理這個範圍（像素 [x0, y0, x1, y1)），預設整張
 */
export function warpImage(src: ImageData, dst: ImageData, f: LiqField, rect?: [number, number, number, number]) {
  const W = src.width;
  const H = src.height;
  const L = Math.max(W, H);
  const [x0, y0, x1, y1] = rect ?? [0, 0, W, H];
  const s = src.data;
  const d = dst.data;
  for (let y = y0; y < y1; y++) {
    const v = (y + 0.5) / L;
    for (let x = x0; x < x1; x++) {
      const u = (x + 0.5) / L;
      const [du, dv] = f.sample(u, v);
      const o = (y * W + x) * 4;
      if (du === 0 && dv === 0) {
        d[o] = s[o];
        d[o + 1] = s[o + 1];
        d[o + 2] = s[o + 2];
        d[o + 3] = s[o + 3];
        continue;
      }
      const sx = Math.min(W - 1, Math.max(0, (u + du) * L - 0.5));
      const sy = Math.min(H - 1, Math.max(0, (v + dv) * L - 0.5));
      const ix = Math.min(W - 2, Math.floor(sx));
      const iy = Math.min(H - 2, Math.floor(sy));
      const tx = Math.max(0, sx - ix);
      const ty = Math.max(0, sy - iy);
      const a = (iy * W + ix) * 4;
      const b = a + 4;
      const c = a + W * 4;
      const e = c + 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = s[a + ch] * (1 - tx) + s[b + ch] * tx;
        const bot = s[c + ch] * (1 - tx) + s[e + ch] * tx;
        d[o + ch] = top * (1 - ty) + bot * ty + 0.5;
      }
    }
  }
}

/** 長邊單位的範圍 → 像素範圍（多留 2px，限制在圖內） */
export function boxToPx(b: [number, number, number, number], W: number, H: number): [number, number, number, number] {
  const L = Math.max(W, H);
  return [
    Math.max(0, Math.floor(b[0] * L) - 2),
    Math.max(0, Math.floor(b[1] * L) - 2),
    Math.min(W, Math.ceil(b[2] * L) + 2),
    Math.min(H, Math.ceil(b[3] * L) + 2),
  ];
}

/** 存檔文字的長度（與 liquify.rs 的 to_text 相同編碼；JPEG 內嵌 XMP 有大小上限） */
export function liqTextLen(v: LiqStroke[]): number {
  let n = 0;
  for (const s of v) {
    n += 24;
    let px = 0;
    let py = 0;
    s.p.forEach(([x, y], i) => {
      const cx = Math.round(x * 20000);
      const cy = Math.round(y * 20000);
      n += (i ? `${cx - px},${cy - py};` : `${cx},${cy};`).length;
      px = cx;
      py = cy;
    });
  }
  return n;
}
