// 局部修補（仿 Camera Raw 的移除 / 修復 / 仿製）。與 src-tauri/src/heal.rs 的演算法相同：
// - 每個修補是一筆筆刷（點的折線 + 半徑），從「來源」位置（平移 offset）取像素
// - 仿製：直接把來源蓋上去（依羽化與不透明度混合）
// - 修復 / 移除：來源的紋理 + 平滑的修正量（在粗網格上解 Laplace 方程式，邊界 = 目的地與來源的差），
//   讓顏色與明暗跟周圍自然接上
// - 移除：自動在周圍找最吻合的區域（左右優先）補上並融合，不顯示來源；找不到時從兩側鏡射補
// - 修復與仿製在建立時自動找來源，之後可以拖曳換來源
// 座標存成相對值：點與 offset 相對原圖寬高，半徑相對長邊。

export type SpotMode = 0 | 1 | 2; // 0 移除、1 修復、2 仿製

export interface Spot {
  m: SpotMode;
  /** 半徑（相對長邊） */
  r: number;
  /** 羽化 0–1 */
  f: number;
  /** 不透明度 0–1 */
  o: number;
  /** 來源平移（相對寬高） */
  d: [number, number];
  /** 筆刷路徑（相對寬高） */
  p: [number, number][];
  /** 移除的合成亂數種子（「重新整理」每按一次 +1，換一種合成結果） */
  k?: number;
}

export const MAX_SPOT_POINTS = 400;

interface Px {
  r: number;
  /** 羽化後的外緣半徑（羽化會往外延伸一些，邊緣更柔） */
  ro: number;
  pts: [number, number][];
  ox: number;
  oy: number;
}

/** 羽化範圍：從 r·(1−f) 漸變到 r·(1+0.5f) */
export const outerR = (r: number, f: number) => r * (1 + 0.5 * f);

function toPx(s: Spot, W: number, H: number): Px {
  return {
    r: s.r * Math.max(W, H),
    ro: outerR(s.r * Math.max(W, H), s.f),
    pts: s.p.map(([x, y]) => [x * W, y * H] as [number, number]),
    ox: Math.round(s.d[0] * W),
    oy: Math.round(s.d[1] * H),
  };
}

/** 修補範圍（含外圍一圈用來比對 / 融合的邊）：[x0, y0, x1, y1)，已限制在圖內 */
function bounds(px: Px, W: number, H: number, extra: number): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of px.pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const m = px.ro + extra;
  return [Math.max(0, Math.floor(x0 - m)), Math.max(0, Math.floor(y0 - m)), Math.min(W, Math.ceil(x1 + m) + 1), Math.min(H, Math.ceil(y1 + m) + 1)];
}

export function margin(r: number) {
  return Math.max(2, r * 0.35);
}

/** 範圍內每個像素到筆刷路徑的距離（逐段只算各自的外框，長筆刷也快） */
function distances(px: Px, b: [number, number, number, number]): Float32Array {
  const [x0, y0, x1, y1] = b;
  const bw = x1 - x0;
  const bh = y1 - y0;
  const dist = new Float32Array(bw * bh).fill(1e9);
  const reach = px.ro + margin(px.r) + 1;
  const n = px.pts.length;
  for (let k = 0; k < Math.max(1, n - 1); k++) {
    const [ax, ay] = px.pts[k];
    const [bx, by] = px.pts[Math.min(k + 1, n - 1)];
    const sx0 = Math.max(x0, Math.floor(Math.min(ax, bx) - reach));
    const sy0 = Math.max(y0, Math.floor(Math.min(ay, by) - reach));
    const sx1 = Math.min(x1, Math.ceil(Math.max(ax, bx) + reach));
    const sy1 = Math.min(y1, Math.ceil(Math.max(ay, by) + reach));
    const vx = bx - ax;
    const vy = by - ay;
    const vv = vx * vx + vy * vy;
    for (let y = sy0; y < sy1; y++) {
      for (let x = sx0; x < sx1; x++) {
        const qx = x + 0.5 - ax;
        const qy = y + 0.5 - ay;
        const t = vv > 0 ? Math.min(1, Math.max(0, (qx * vx + qy * vy) / vv)) : 0;
        const dx = qx - t * vx;
        const dy = qy - t * vy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const i = (y - y0) * bw + (x - x0);
        if (d < dist[i]) dist[i] = d;
      }
    }
  }
  return dist;
}

function fadeOut(d: number, r: number, ro: number): number {
  if (d <= r) return 1;
  if (d >= ro) return 0;
  const t = (d - r) / (ro - r);
  return 1 - t * t * (3 - 2 * t);
}

function alphaOf(d: number, r: number, f: number): number {
  const inner = r * (1 - f);
  const outer = outerR(r, f);
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  const t = (d - inner) / (outer - inner);
  return 1 - t * t * (3 - 2 * t);
}

/** 在 RGBA 影像上依序套用所有修補（就地修改） */
export function applySpots(img: ImageData, spots: Spot[], cache?: Map<string, { b: [number, number, number, number]; px: Uint8ClampedArray }>) {
  // 快取：同一張圖、前面的修補都一樣時，這一筆的結果不必重算（內容感知合成比較花時間）
  let key = `${img.width}x${img.height}`;
  for (const s of spots) {
    key = hashStr(key + JSON.stringify(s));
    const hit = cache?.get(key);
    if (hit) {
      pasteRegion(img, hit.b, hit.px);
      continue;
    }
    const b = applySpot(img, s);
    if (cache && b) {
      if (cache.size > 300) cache.clear();
      cache.set(key, { b, px: copyRegion(img, b) });
    }
  }
}

function hashStr(t: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

function copyRegion(img: ImageData, b: [number, number, number, number]): Uint8ClampedArray {
  const [x0, y0, x1, y1] = b;
  const w = x1 - x0;
  const out = new Uint8ClampedArray(w * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) out.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x1) * 4), (y - y0) * w * 4);
  return out;
}

function pasteRegion(img: ImageData, b: [number, number, number, number], px: Uint8ClampedArray) {
  const [x0, y0, x1, y1] = b;
  const w = x1 - x0;
  for (let y = y0; y < y1; y++) img.data.set(px.subarray((y - y0) * w * 4, (y - y0 + 1) * w * 4), (y * img.width + x0) * 4);
}

function applySpot(img: ImageData, s: Spot): [number, number, number, number] | null {
  const W = img.width;
  const H = img.height;
  const px = toPx(s, W, H);
  if (px.r < 0.5 || !px.pts.length) return null;
  const mg = margin(px.r);
  // 移除（內容感知合成）需要比較大的周圍範圍當素材
  const synth = s.m === 0 && px.ox === 0 && px.oy === 0;
  const b = bounds(px, W, H, synth ? contextMargin(px.ro) : mg);
  const [x0, y0, x1, y1] = b;
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return null;
  const data = img.data;
  const dist = distances(px, b);
  const alpha = new Float32Array(bw * bh);
  // 移除（合成）：筆刷內完全替換，只在筆刷外圍漸變（物體邊緣才不會殘留）
  for (let i = 0; i < alpha.length; i++) alpha[i] = synth ? fadeOut(dist[i], px.r, px.ro) : alphaOf(dist[i], px.r, s.f);
  // 先複製來源與目的地（來源可能與目的地重疊）
  const dst = new Float32Array(bw * bh * 3);
  const src = new Float32Array(bw * bh * 3);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = (y * bw + x) * 3;
      const di = ((y + y0) * W + (x + x0)) * 4;
      const sx = Math.min(W - 1, Math.max(0, x + x0 + px.ox));
      const sy = Math.min(H - 1, Math.max(0, y + y0 + px.oy));
      const si = (sy * W + sx) * 4;
      for (let k = 0; k < 3; k++) {
        dst[i + k] = data[di + k];
        src[i + k] = data[si + k];
      }
    }
  }
  // 移除：內容感知合成（從周圍許多小區塊拼出與四周最融合的圖樣）；
  // 指定了自訂來源（⌘ + 拖曳）時改成從那裡取樣 + 融合；合成失敗（周圍沒有素材）時從兩側鏡射補
  if (synth) {
    const hole = new Uint8Array(bw * bh);
    for (let i = 0; i < hole.length; i++) hole[i] = alpha[i] > 0 ? 1 : 0;
    const fill = inpaint(dst, hole, bw, bh, s.k ?? 0);
    if (fill) for (let i = 0; i < src.length; i++) src[i] = fill[i];
    else mirrorFill(data, W, H, alpha, b, src, dst);
  }
  const corr = s.m !== 2 && !synth ? correction(dst, src, alpha, bw, bh) : null;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const j = y * bw + x;
      const a = alpha[j] * s.o;
      if (a <= 0) continue;
      const i = j * 3;
      const di = ((y + y0) * W + (x + x0)) * 4;
      const c = corr ? corr(x, y) : null;
      for (let k = 0; k < 3; k++) {
        const v = src[i + k] + (c ? c[k] : 0);
        const out = dst[i + k] + (v - dst[i + k]) * a;
        data[di + k] = Math.min(255, Math.max(0, Math.round(out)));
      }
    }
  }
  return b;
}

/**
 * 移除：不用指定來源，每個像素沿著修補範圍較窄的方向（左右或上下），
 * 取範圍兩側鏡射位置的像素，依離兩邊的距離混合 → 兩側的紋理與顏色自然接起來
 */
function mirrorFill(
  data: Uint8ClampedArray,
  W: number,
  H: number,
  alpha: Float32Array,
  b: [number, number, number, number],
  src: Float32Array,
  dst: Float32Array,
) {
  const [x0, y0, x1, y1] = b;
  const bw = x1 - x0;
  const bh = y1 - y0;
  const n = bw * bh;
  const ra = new Int32Array(n);
  const rb = new Int32Array(n);
  const ca = new Int32Array(n);
  const cb = new Int32Array(n);
  for (let y = 0; y < bh; y++) {
    let x = 0;
    while (x < bw) {
      if (alpha[y * bw + x] <= 0) {
        x++;
        continue;
      }
      let e = x;
      while (e + 1 < bw && alpha[y * bw + e + 1] > 0) e++;
      for (let k = x; k <= e; k++) {
        ra[y * bw + k] = x;
        rb[y * bw + k] = e;
      }
      x = e + 1;
    }
  }
  for (let x = 0; x < bw; x++) {
    let y = 0;
    while (y < bh) {
      if (alpha[y * bw + x] <= 0) {
        y++;
        continue;
      }
      let e = y;
      while (e + 1 < bh && alpha[(e + 1) * bw + x] > 0) e++;
      for (let k = y; k <= e; k++) {
        ca[k * bw + x] = y;
        cb[k * bw + x] = e;
      }
      y = e + 1;
    }
  }
  const at = (X: number, Y: number, k: number) => data[(Y * W + X) * 4 + k];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const j = y * bw + x;
      const i = j * 3;
      if (alpha[j] <= 0) {
        for (let k = 0; k < 3; k++) src[i + k] = dst[i + k];
        continue;
      }
      const horiz = rb[j] - ra[j] <= cb[j] - ca[j];
      const a = horiz ? ra[j] : ca[j];
      const e = horiz ? rb[j] : cb[j];
      const p = horiz ? x : y;
      const base = horiz ? x0 : y0;
      const lim = horiz ? W : H;
      const lo = base + a - 1 - (p - a);
      const hi = base + e + 1 + (e - p);
      let t = (p - a + 0.5) / (e - a + 1);
      const loOk = lo >= 0;
      const hiOk = hi < lim;
      if (!loOk && hiOk) t = 1;
      if (loOk && !hiOk) t = 0;
      const L = Math.min(lim - 1, Math.max(0, lo));
      const R = Math.min(lim - 1, Math.max(0, hi));
      for (let k = 0; k < 3; k++) {
        const vl = horiz ? at(L, y + y0, k) : at(x + x0, L, k);
        const vr = horiz ? at(R, y + y0, k) : at(x + x0, R, k);
        src[i + k] = vl * (1 - t) + vr * t;
      }
    }
  }
}

/** 修正量：粗網格上邊界固定為 (目的地 − 來源) 的平均，內部解 Laplace（SOR），再雙線性內插回每個像素 */
function correction(dst: Float32Array, src: Float32Array, alpha: Float32Array, bw: number, bh: number) {
  const cell = Math.max(1, Math.ceil(Math.max(bw, bh) / 48));
  const gw = Math.ceil(bw / cell);
  const gh = Math.ceil(bh / cell);
  const n = gw * gh;
  const sum = new Float64Array(n * 3);
  const cnt = new Float64Array(n);
  const inside = new Uint8Array(n);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const g = Math.floor(y / cell) * gw + Math.floor(x / cell);
      const j = y * bw + x;
      if (alpha[j] > 0) inside[g] = 1;
      for (let k = 0; k < 3; k++) sum[g * 3 + k] += dst[j * 3 + k] - src[j * 3 + k];
      cnt[g]++;
    }
  }
  const D = new Float64Array(n * 3);
  const fixed = new Uint8Array(n);
  const mean = [0, 0, 0];
  let nb = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const g = gy * gw + gx;
      const edge = gx === 0 || gy === 0 || gx === gw - 1 || gy === gh - 1;
      if (!inside[g] || edge) {
        fixed[g] = 1;
        for (let k = 0; k < 3; k++) {
          D[g * 3 + k] = sum[g * 3 + k] / Math.max(1, cnt[g]);
          mean[k] += D[g * 3 + k];
        }
        nb++;
      }
    }
  }
  for (let k = 0; k < 3; k++) mean[k] /= Math.max(1, nb);
  for (let g = 0; g < n; g++) if (!fixed[g]) for (let k = 0; k < 3; k++) D[g * 3 + k] = mean[k];
  const w = 1.8;
  for (let it = 0; it < 150; it++) {
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const g = gy * gw + gx;
        if (fixed[g]) continue;
        for (let k = 0; k < 3; k++) {
          let s = 0;
          let m = 0;
          if (gx > 0) (s += D[(g - 1) * 3 + k]), m++;
          if (gx < gw - 1) (s += D[(g + 1) * 3 + k]), m++;
          if (gy > 0) (s += D[(g - gw) * 3 + k]), m++;
          if (gy < gh - 1) (s += D[(g + gw) * 3 + k]), m++;
          const v = D[g * 3 + k];
          D[g * 3 + k] = v + w * (s / m - v);
        }
      }
    }
  }
  const out = [0, 0, 0];
  return (x: number, y: number) => {
    const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / cell - 0.5));
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const ax = Math.floor(fx);
    const ay = Math.floor(fy);
    const bx = Math.min(gw - 1, ax + 1);
    const by = Math.min(gh - 1, ay + 1);
    const tx = fx - ax;
    const ty = fy - ay;
    for (let k = 0; k < 3; k++) {
      const a = D[(ay * gw + ax) * 3 + k] * (1 - tx) + D[(ay * gw + bx) * 3 + k] * tx;
      const b2 = D[(by * gw + ax) * 3 + k] * (1 - tx) + D[(by * gw + bx) * 3 + k] * tx;
      out[k] = a * (1 - ty) + b2 * ty;
    }
    return out;
  };
}

/**
 * 自動找來源：在筆刷周圍試不同方向與距離，比較外圍一圈像素與來源對應位置的差異，挑最像的。
 * 移除找得比較廣（4 種距離 × 16 方向），修復 / 仿製只在旁邊找（8 方向）。回傳相對值 offset
 */
export function findSource(img: ImageData, s: Spot, rank = 0): [number, number] {
  const W = img.width;
  const H = img.height;
  const px = toPx({ ...s, d: [0, 0] }, W, H);
  const mg = margin(px.r);
  const b = bounds(px, W, H, mg);
  const [x0, y0, x1, y1] = b;
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return [0, 0];
  const dist = distances(px, b);
  // 外圍一圈（筆刷外、邊界內）的像素
  const ring: number[] = [];
  for (let i = 0; i < dist.length; i++) if (dist[i] > px.ro && dist[i] <= px.ro + mg) ring.push(i);
  const step = Math.max(1, Math.floor(ring.length / 1500));
  const ext = Math.max(bw, bh) / 2;
  // 候選距離：貼著筆刷旁邊（細長筆刷往側面找）到整個範圍外
  const near = 2 * px.ro + mg + 2;
  const dists = s.m === 0 ? [near, near * 1.4, near * 2, ext * 1.1, ext * 1.6] : [near, near * 1.5, ext * 1.15];
  const dirs = s.m === 0 ? 16 : 8;
  // 來源不能壓到要修補的地方（否則會把瑕疵本身複製過來）
  const overlaps = (ox: number, oy: number) => px.pts.some(([x, y]) => distToStroke(px.pts, x + ox, y + oy) < near - 1);
  const found: { o: [number, number]; score: number }[] = [];
  const data = img.data;
  for (const dd of dists) {
    for (let a = 0; a < dirs; a++) {
      const ang = (a / dirs) * Math.PI * 2;
      const ox = Math.round(Math.cos(ang) * dd);
      const oy = Math.round(Math.sin(ang) * dd);
      // 來源範圍要整個在圖內，且不壓到修補的地方
      if (x0 + ox < 0 || y0 + oy < 0 || x1 + ox > W || y1 + oy > H) continue;
      if (overlaps(ox, oy)) continue;
      let sc = 0;
      let n = 0;
      for (let q = 0; q < ring.length; q += step) {
        const i = ring[q];
        const x = (i % bw) + x0;
        const y = Math.floor(i / bw) + y0;
        const di = (y * W + x) * 4;
        const si = ((y + oy) * W + (x + ox)) * 4;
        for (let c = 0; c < 3; c++) {
          const e = data[di + c] - data[si + c];
          sc += e * e;
        }
        n++;
      }
      // 距離越遠稍微扣分（同樣像時取近的）；移除時左右優先於上下
      const score = sc / Math.max(1, n) + (dd / Math.max(1, px.r)) * 2 + (s.m === 0 ? Math.abs(Math.sin(ang)) * 6 : 0);
      found.push({ o: [ox, oy], score });
    }
  }
  // 「重新整理」：依分數排序，rank = 第幾好的來源（輪流換）
  found.sort((a, b) => a.score - b.score);
  let best: [number, number] = [0, 0];
  if (found.length) best = found[rank % found.length].o;
  else if (s.m === 0) return [0, 0];
  else {
    // 都放不下（筆刷太大）：往圖中央的方向移
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const dx = cx < W / 2 ? bw : -bw;
    const dy = cy < H / 2 ? 0 : 0;
    best = [dx, dy];
  }
  return [best[0] / W, best[1] / H];
}

/** 點到筆刷路徑的距離（像素；給點選判斷用） */
export function distToStroke(pts: [number, number][], x: number, y: number): number {
  let best = Infinity;
  const n = pts.length;
  for (let k = 0; k < Math.max(1, n - 1); k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[Math.min(k + 1, n - 1)];
    const vx = bx - ax;
    const vy = by - ay;
    const vv = vx * vx + vy * vy;
    const qx = x - ax;
    const qy = y - ay;
    const t = vv > 0 ? Math.min(1, Math.max(0, (qx * vx + qy * vy) / vv)) : 0;
    best = Math.min(best, Math.hypot(qx - t * vx, qy - t * vy));
  }
  return best;
}

/** 整理（與 edit.rs clean_spots 相同） */
export function cleanSpots(v: unknown): Spot[] {
  if (!Array.isArray(v)) return [];
  const out: Spot[] = [];
  for (const s of v) {
    if (!s || !Array.isArray(s.p) || !s.p.length || !Array.isArray(s.d)) continue;
    const num = (x: unknown, lo: number, hi: number, def: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, Number(x))) : def);
    const p = (s.p as unknown[][])
      .filter((q) => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))
      .slice(0, MAX_SPOT_POINTS)
      .map((q) => [num(q[0], -1, 2, 0), num(q[1], -1, 2, 0)] as [number, number]);
    if (!p.length) continue;
    out.push({
      m: ([0, 1, 2].includes(s.m) ? s.m : 1) as SpotMode,
      r: num(s.r, 0.0005, 0.5, 0.01),
      f: num(s.f, 0, 1, 0.5),
      o: num(s.o, 0, 1, 1),
      d: [num(s.d[0], -2, 2, 0), num(s.d[1], -2, 2, 0)],
      p,
      ...(Number.isFinite(s.k) && s.k > 0 ? { k: Math.min(1_000_000, Math.floor(s.k)) } : {}),
    });
  }
  return out;
}

/**
 * 移除時自動擴大範圍（仿 Camera Raw）：點在花瓣、灰塵上時，筆刷常常沒有完全蓋住。
 * 從筆刷半徑往外試，直到那一圈的顏色和更外圍的背景差不多為止（最多擴大到 2 倍），回傳新的半徑（相對長邊）
 */
export function autoRadius(img: ImageData, s: Spot): number {
  const W = img.width;
  const H = img.height;
  const L = Math.max(W, H);
  const r0 = s.r * L;
  if (r0 < 1) return s.r;
  const pts = s.p.map(([x, y]) => [x * W, y * H] as [number, number]);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  const reach = r0 * 2.8 + 3;
  const bx0 = Math.max(0, Math.floor(x0 - reach));
  const by0 = Math.max(0, Math.floor(y0 - reach));
  const bx1 = Math.min(W, Math.ceil(x1 + reach));
  const by1 = Math.min(H, Math.ceil(y1 + reach));
  const step = Math.max(1, Math.floor(Math.sqrt(((bx1 - bx0) * (by1 - by0)) / 40000)));
  // 每個取樣點：到筆刷路徑的距離與顏色
  const ds: number[] = [];
  const cs: number[] = [];
  for (let y = by0; y < by1; y += step) {
    for (let x = bx0; x < bx1; x += step) {
      const d = distToStroke(pts, x + 0.5, y + 0.5);
      if (d > reach) continue;
      const k = (y * W + x) * 4;
      ds.push(d);
      cs.push(img.data[k], img.data[k + 1], img.data[k + 2]);
    }
  }
  const ringMean = (a: number, b: number) => {
    const m = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < ds.length; i++) {
      if (ds[i] < a || ds[i] >= b) continue;
      m[0] += cs[i * 3];
      m[1] += cs[i * 3 + 1];
      m[2] += cs[i * 3 + 2];
      n++;
    }
    return n ? m.map((v) => v / n) : null;
  };
  const bg = ringMean(r0 * 2.3, r0 * 2.8 + 3);
  if (!bg) return s.r;
  const band = Math.max(1.5, r0 * 0.12);
  // 這一圈裡「和背景差很多」的點佔多少（細長的花瓣尖端只佔一小部分，用比例而不是平均才抓得到）
  const off = (a: number, b: number) => {
    let n = 0;
    let bad = 0;
    for (let i = 0; i < ds.length; i++) {
      if (ds[i] < a || ds[i] >= b) continue;
      n++;
      if (Math.hypot(cs[i * 3] - bg[0], cs[i * 3 + 1] - bg[1], cs[i * 3 + 2] - bg[2]) > 38) bad++;
    }
    return n ? bad / n : 0;
  };
  // 背景本身的雜訊程度（顆粒多的背景，門檻跟著放寬）
  const noise = off(r0 * 2.3, r0 * 2.8 + 3);
  const clean = (a: number, b: number) => off(a, b) <= noise + 0.02;
  // 移除固定羽化 0.3：物體要完全落在不透明的內圈裡 → 半徑 = 物體半徑 / 0.7
  // 移除時筆刷內完全替換、外圍才漸變 → 半徑 = 物體半徑 + 一點餘裕
  const fit = (R: number) => Math.min(0.5, Math.min(r0 * 2.6, Math.max(r0, R + band * 1.5)) / L);
  for (let R = r0 * 0.6; R <= r0 * 2; R += band) {
    if (clean(R, R + band) && clean(R + band, R + band * 2)) return fit(R);
  }
  return fit(r0 * 2);
}

// ---------------------------------------------------------------- 內容感知合成（PatchMatch）
// 與 src-tauri/src/heal.rs 的 inpaint 逐步相同（同樣的亂數、同樣的運算順序）。
// 做法：把範圍縮成多層金字塔，從最粗的一層開始，為洞裡每個 7×7 小區塊在周圍找最像的小區塊（PatchMatch：
// 鄰居傳遞 + 隨機搜尋），再用這些小區塊「投票」出洞裡每個像素的顏色；反覆幾次後放大到下一層繼續修，
// 最後在原解析度得到與四周圖樣最融合的內容。

const PH = 3; // 小區塊半徑（7×7）

/** 合成用的周圍素材範圍：洞外圍再加這麼多像素 */
export function contextMargin(ro: number) {
  return Math.max(18, Math.round(ro * 2.5));
}

function xorshift(seed: number) {
  let st = (Math.imul(seed + 1, 2654435761) ^ 0x9e3779b9) >>> 0;
  if (st === 0) st = 1;
  return () => {
    st ^= st << 13;
    st >>>= 0;
    st ^= st >>> 17;
    st ^= st << 5;
    st >>>= 0;
    return st;
  };
}

interface Lv {
  w: number;
  h: number;
  img: Float64Array;
  hole: Uint8Array;
}

/** 回傳填好的影像（RGB，與 dst 同大小）；周圍沒有可用素材時回傳 null */
export function inpaint(dst: Float32Array, hole0: Uint8Array, bw: number, bh: number, seed: number): Float64Array | null {
  let any = false;
  for (let i = 0; i < hole0.length; i++) if (hole0[i]) any = true;
  if (!any) return null;
  // 金字塔
  const lvs: Lv[] = [{ w: bw, h: bh, img: Float64Array.from(dst), hole: hole0 }];
  while (lvs.length < 6) {
    const c = lvs[lvs.length - 1];
    if (Math.max(c.w, c.h) <= 40 || Math.min(c.w, c.h) < 4 * (2 * PH + 1)) break;
    const w = Math.ceil(c.w / 2);
    const h = Math.ceil(c.h / 2);
    const img = new Float64Array(w * h * 3);
    const hole = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let n = 0;
        const sum = [0, 0, 0];
        let ho = 0;
        for (let j = 0; j < 2; j++) {
          for (let i = 0; i < 2; i++) {
            const xx = x * 2 + i;
            const yy = y * 2 + j;
            if (xx >= c.w || yy >= c.h) continue;
            const q = yy * c.w + xx;
            for (let k = 0; k < 3; k++) sum[k] += c.img[q * 3 + k];
            if (c.hole[q]) ho = 1;
            n++;
          }
        }
        const p = y * w + x;
        for (let k = 0; k < 3; k++) img[p * 3 + k] = sum[k] / n;
        hole[p] = ho;
      }
    }
    lvs.push({ w, h, img, hole });
  }
  const info = lvs.map(levelInfo);
  // 洞很大時不在原解析度合成（太慢）：只做到「要填的小區塊數 ≤ MAX_TARGETS」的那一層，再放大回原尺寸
  let bottom = 0;
  while (bottom < lvs.length - 1 && info[bottom].targets.length > MAX_TARGETS) bottom++;
  // 從最粗、且有素材的那一層開始
  let top = lvs.length - 1;
  while (top >= 0 && info[top].valid.length === 0) top--;
  if (top < 0) return null;
  const rnd = xorshift(seed);
  let ns: Int32Array | null = null;
  if (bottom > top) bottom = top;
  for (let l = top; l >= bottom; l--) {
    const lv = lvs[l];
    const inf = info[l];
    const n = lv.w * lv.h;
    const next = new Int32Array(n).fill(-1);
    if (!ns) {
      for (const p of inf.targets) next[p] = inf.valid[rnd() % inf.valid.length];
      diffuseInit(lv);
    } else {
      const c = lvs[l + 1];
      for (const p of inf.targets) {
        const px = p % lv.w;
        const py = (p - px) / lv.w;
        const cx = Math.min(px >> 1, c.w - 1);
        const cy = Math.min(py >> 1, c.h - 1);
        const cs = ns[cy * c.w + cx];
        let cand = -1;
        if (cs >= 0) {
          const sx = px + ((cs % c.w) - cx) * 2;
          const sy = py + (Math.floor(cs / c.w) - cy) * 2;
          if (sx >= 0 && sy >= 0 && sx < lv.w && sy < lv.h && inf.isValid[sy * lv.w + sx]) cand = sy * lv.w + sx;
        }
        next[p] = cand >= 0 ? cand : inf.valid[rnd() % inf.valid.length];
      }
      vote(lv, inf.targets, next);
    }
    ns = next;
    const em = l === top ? 6 : l === bottom ? 3 : 4;
    const pmi = l === top ? 4 : 3;
    const nd = new Float64Array(n);
    for (let e = 0; e < em; e++) {
      for (const p of inf.targets) nd[p] = patchDist(lv, p, ns[p], Infinity);
      for (let it = 0; it < pmi; it++) {
        const fwd = it % 2 === 0;
        const T = inf.targets.length;
        for (let ti = 0; ti < T; ti++) {
          const p = inf.targets[fwd ? ti : T - 1 - ti];
          const px = p % lv.w;
          const py = (p - px) / lv.w;
          // 鄰居傳遞
          for (let pass = 0; pass < 2; pass++) {
            const dx = pass === 0 ? (fwd ? -1 : 1) : 0;
            const dy = pass === 1 ? (fwd ? -1 : 1) : 0;
            const qx = px + dx;
            const qy = py + dy;
            if (qx < 0 || qy < 0 || qx >= lv.w || qy >= lv.h) continue;
            const q = qy * lv.w + qx;
            if (!inf.isTarget[q]) continue;
            const sq = ns[q];
            const sx = (sq % lv.w) - dx;
            const sy = Math.floor(sq / lv.w) - dy;
            if (sx < 0 || sy < 0 || sx >= lv.w || sy >= lv.h) continue;
            const cand = sy * lv.w + sx;
            if (!inf.isValid[cand] || cand === ns[p]) continue;
            const d = patchDist(lv, p, cand, nd[p]);
            if (d < nd[p]) {
              nd[p] = d;
              ns[p] = cand;
            }
          }
          // 隨機搜尋（半徑每次減半）
          let rad = Math.max(lv.w, lv.h);
          while (rad >= 1) {
            const bx = ns[p] % lv.w;
            const by = Math.floor(ns[p] / lv.w);
            const sx = bx + (rnd() % (2 * rad + 1)) - rad;
            const sy = by + (rnd() % (2 * rad + 1)) - rad;
            if (sx >= 0 && sy >= 0 && sx < lv.w && sy < lv.h) {
              const cand = sy * lv.w + sx;
              if (inf.isValid[cand] && cand !== ns[p]) {
                const d = patchDist(lv, p, cand, nd[p]);
                if (d < nd[p]) {
                  nd[p] = d;
                  ns[p] = cand;
                }
              }
            }
            rad = Math.floor(rad / 2);
          }
        }
      }
      vote(lv, inf.targets, ns, nd);
    }
    if (l === 0 && bottom === 0) {
      // 最後一步：每個像素直接取最像的小區塊中心的顏色（不平均），保留原解析度的顆粒與細節
      const { img, hole } = lv;
      for (const q of inf.targets) {
        if (!hole[q]) continue;
        const src = ns[q];
        for (let k = 0; k < 3; k++) img[q * 3 + k] = img[src * 3 + k];
      }
    }
  }
  if (bottom > 0) upsampleInto(lvs[0], lvs[bottom], bottom);
  return lvs[0].img;
}

const MAX_TARGETS = 40000;

/** 用粗層的合成結果（雙線性放大）填原尺寸的洞 */
function upsampleInto(dst: Lv, src: Lv, levels: number) {
  const f = 2 ** levels;
  for (let y = 0; y < dst.h; y++) {
    for (let x = 0; x < dst.w; x++) {
      const q = y * dst.w + x;
      if (!dst.hole[q]) continue;
      const fx = Math.min(src.w - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const fy = Math.min(src.h - 1, Math.max(0, (y + 0.5) / f - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(src.w - 1, x0 + 1);
      const y1 = Math.min(src.h - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      for (let k = 0; k < 3; k++) {
        const a = src.img[(y0 * src.w + x0) * 3 + k] * (1 - tx) + src.img[(y0 * src.w + x1) * 3 + k] * tx;
        const b = src.img[(y1 * src.w + x0) * 3 + k] * (1 - tx) + src.img[(y1 * src.w + x1) * 3 + k] * tx;
        dst.img[q * 3 + k] = a * (1 - ty) + b * ty;
      }
    }
  }
}

/** 每層的：可當素材的小區塊中心（整塊在範圍內且不碰到洞）、要填的小區塊中心（碰到洞的） */
function levelInfo(lv: Lv) {
  const { w, h, hole } = lv;
  // 洞的積分圖
  const ii = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += hole[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const count = (xa: number, ya: number, xb: number, yb: number) => {
    xa = Math.max(0, xa);
    ya = Math.max(0, ya);
    xb = Math.min(w - 1, xb);
    yb = Math.min(h - 1, yb);
    if (xa > xb || ya > yb) return 0;
    return ii[(yb + 1) * (w + 1) + xb + 1] - ii[ya * (w + 1) + xb + 1] - ii[(yb + 1) * (w + 1) + xa] + ii[ya * (w + 1) + xa];
  };
  const isValid = new Uint8Array(w * h);
  const isTarget = new Uint8Array(w * h);
  const valid: number[] = [];
  const targets: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const c = count(x - PH, y - PH, x + PH, y + PH);
      if (c > 0) {
        isTarget[p] = 1;
        targets.push(p);
      } else if (x >= PH && y >= PH && x < w - PH && y < h - PH) {
        isValid[p] = 1;
        valid.push(p);
      }
    }
  }
  return { isValid, isTarget, valid, targets };
}

/** 兩個 7×7 小區塊的差異（平方和）；超過 cutoff 就提早停 */
function patchDist(lv: Lv, p: number, s: number, cutoff: number): number {
  const w = lv.w;
  const px = p % w;
  const py = (p - px) / w;
  const sx = s % w;
  const sy = (s - sx) / w;
  const img = lv.img;
  let acc = 0;
  for (let dy = -PH; dy <= PH; dy++) {
    const ty = py + dy;
    if (ty < 0 || ty >= lv.h) continue;
    for (let dx = -PH; dx <= PH; dx++) {
      const tx = px + dx;
      if (tx < 0 || tx >= w) continue;
      const t = (ty * w + tx) * 3;
      const u = ((sy + dy) * w + sx + dx) * 3;
      const d0 = img[t] - img[u];
      const d1 = img[t + 1] - img[u + 1];
      const d2 = img[t + 2] - img[u + 2];
      acc += d0 * d0 + d1 * d1 + d2 * d2;
    }
    if (acc >= cutoff) return acc;
  }
  return acc;
}

/** 投票：洞裡每個像素 = 所有蓋到它的小區塊、對應位置顏色的平均 */
function vote(lv: Lv, targets: number[], ns: Int32Array, nd?: Float64Array) {
  const { w, h, img, hole } = lv;
  const acc = new Float64Array(w * h * 3);
  const wt = new Float64Array(w * h);
  // 權重：越像的小區塊說話越大聲（1 / (1 + 差異 / 中位數)），避免不像的區塊把結果平均糊掉
  let med = 0;
  if (nd && targets.length) {
    const arr = new Float64Array(targets.length);
    targets.forEach((p, i) => (arr[i] = nd[p]));
    arr.sort();
    med = arr[arr.length >> 1];
  }
  for (const p of targets) {
    const s = ns[p];
    const wp = nd && med > 0 ? 1 / (1 + nd[p] / med) : 1;
    const px = p % w;
    const py = (p - px) / w;
    const sx = s % w;
    const sy = (s - sx) / w;
    for (let dy = -PH; dy <= PH; dy++) {
      const ty = py + dy;
      if (ty < 0 || ty >= h) continue;
      for (let dx = -PH; dx <= PH; dx++) {
        const tx = px + dx;
        if (tx < 0 || tx >= w) continue;
        const t = ty * w + tx;
        if (!hole[t]) continue;
        const u = ((sy + dy) * w + sx + dx) * 3;
        acc[t * 3] += img[u] * wp;
        acc[t * 3 + 1] += img[u + 1] * wp;
        acc[t * 3 + 2] += img[u + 2] * wp;
        wt[t] += wp;
      }
    }
  }
  for (let t = 0; t < w * h; t++) {
    if (!hole[t] || wt[t] <= 0) continue;
    for (let k = 0; k < 3; k++) img[t * 3 + k] = acc[t * 3 + k] / wt[t];
  }
}

/** 最粗一層的起始值：洞先填周圍平均色，再往內擴散幾十次（平滑的底色） */
function diffuseInit(lv: Lv) {
  const { w, h, img, hole } = lv;
  const mean = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (hole[i]) continue;
    for (let k = 0; k < 3; k++) mean[k] += img[i * 3 + k];
    n++;
  }
  for (let k = 0; k < 3; k++) mean[k] /= Math.max(1, n);
  for (let i = 0; i < w * h; i++) if (hole[i]) for (let k = 0; k < 3; k++) img[i * 3 + k] = mean[k];
  for (let it = 0; it < 60; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!hole[i]) continue;
        for (let k = 0; k < 3; k++) {
          let sum = 0;
          let m = 0;
          if (x > 0) (sum += img[(i - 1) * 3 + k]), m++;
          if (x < w - 1) (sum += img[(i + 1) * 3 + k]), m++;
          if (y > 0) (sum += img[(i - w) * 3 + k]), m++;
          if (y < h - 1) (sum += img[(i + w) * 3 + k]), m++;
          img[i * 3 + k] = sum / m;
        }
      }
    }
  }
}
