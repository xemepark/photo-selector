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

function alphaOf(d: number, r: number, f: number): number {
  const inner = r * (1 - f);
  const outer = outerR(r, f);
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  const t = (d - inner) / (outer - inner);
  return 1 - t * t * (3 - 2 * t);
}

/** 在 RGBA 影像上依序套用所有修補（就地修改） */
export function applySpots(img: ImageData, spots: Spot[]) {
  for (const s of spots) applySpot(img, s);
}

function applySpot(img: ImageData, s: Spot) {
  const W = img.width;
  const H = img.height;
  const px = toPx(s, W, H);
  if (px.r < 0.5 || !px.pts.length) return;
  const mg = margin(px.r);
  const b = bounds(px, W, H, mg);
  const [x0, y0, x1, y1] = b;
  const bw = x1 - x0;
  const bh = y1 - y0;
  if (bw <= 0 || bh <= 0) return;
  const data = img.data;
  const dist = distances(px, b);
  const alpha = new Float32Array(bw * bh);
  for (let i = 0; i < alpha.length; i++) alpha[i] = alphaOf(dist[i], px.r, s.f);
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
  // 移除：平常和修復一樣（自動找到的來源 + 融合，只是不顯示來源）；
  // 找不到可用的來源時 offset 為 0，改用兩側鏡射補
  const mirror = s.m === 0 && px.ox === 0 && px.oy === 0;
  if (mirror) mirrorFill(data, W, H, alpha, b, src, dst);
  const corr = s.m !== 2 && !mirror ? correction(dst, src, alpha, bw, bh) : null;
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
  const fit = (R: number) => Math.min(0.5, Math.min(r0 * 2.6, Math.max(r0, (R + band) / 0.7)) / L);
  for (let R = r0 * 0.6; R <= r0 * 2; R += band) {
    if (clean(R, R + band) && clean(R + band, R + band * 2)) return fit(R);
  }
  return fit(r0 * 2);
}
