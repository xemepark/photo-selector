// 點曲線（RGB）：控制點整理、查表計算（與 src-tauri/src/edit.rs 的 clean_curve / curve_lut 相同演算法），
// 以及曲線編輯器（加點、拖曳、拖出框外或雙擊刪除）。

export type Pt = [number, number];

export const MAX_POINTS = 16;
export const DEFAULT_CURVE: Pt[] = [
  [0, 0],
  [255, 255],
];

/** 與 edit.rs clean_curve 相同：限制在 0–255、排序、去重；直線回傳空陣列 */
export function cleanCurve(c: Pt[]): Pt[] {
  let v = c
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [Math.round(Math.min(255, Math.max(0, p[0]))), Math.round(Math.min(255, Math.max(0, p[1])))] as Pt)
    .sort((a, b) => a[0] - b[0]);
  v = v.filter((p, i) => i === 0 || p[0] !== v[i - 1][0]).slice(0, MAX_POINTS);
  if (v.length < 2) return [];
  if (v.every((p) => Math.abs(p[0] - p[1]) < 0.5) && v[0][0] === 0 && v[v.length - 1][0] === 255) return [];
  return v;
}

/** 與 edit.rs curve_lut 相同：單調三次插值（Fritsch–Carlson），回傳 256 格 0–1 的查表 */
export function curveLut(c: Pt[]): Float32Array | null {
  if (c.length < 2) return null;
  const n = c.length;
  const xs = c.map((p) => p[0]);
  const ys = c.map((p) => p[1]);
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = new Array<number>(n).fill(0);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const h = a * a + b * b;
      if (h > 9) {
        const t = 3 / Math.sqrt(h);
        m[i] = t * a * d[i];
        m[i + 1] = t * b * d[i];
      }
    }
  }
  const lut = new Float32Array(256);
  let k = 0;
  for (let x = 0; x < 256; x++) {
    let y: number;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      while (k < n - 2 && x > xs[k + 1]) k++;
      const h = xs[k + 1] - xs[k];
      const t = (x - xs[k]) / h;
      const t2 = t * t;
      const t3 = t2 * t;
      y = (2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1];
    }
    lut[x] = Math.min(1, Math.max(0, y / 255));
  }
  return lut;
}

export function sameCurve(a: Pt[], b: Pt[]) {
  const x = cleanCurve(a);
  const y = cleanCurve(b);
  return x.length === y.length && x.every((p, i) => p[0] === y[i][0] && p[1] === y[i][1]);
}

/** 曲線編輯器：畫在 canvas 上，背景淡淡顯示亮度分布 */
export class CurveEditor {
  private pts: Pt[] = DEFAULT_CURVE.map((p) => [...p] as Pt);
  private active = -1;
  private dragging = false;
  private outside = false;
  private hist: Float32Array | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private readout: HTMLElement,
    private onChange: (pts: Pt[]) => void,
  ) {
    canvas.addEventListener("pointerdown", (e) => this.down(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.up(e));
    canvas.addEventListener("pointercancel", (e) => this.up(e));
    canvas.addEventListener("dblclick", (e) => this.dbl(e));
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set(pts: Pt[]) {
    this.pts = (pts.length >= 2 ? pts : DEFAULT_CURVE).map((p) => [...p] as Pt);
    this.active = -1;
    this.draw();
  }

  get points(): Pt[] {
    return this.pts.map((p) => [...p] as Pt);
  }

  setHistogram(h: Float32Array | null) {
    this.hist = h;
    this.draw();
  }

  /** 滑鼠座標 → 曲線座標（0–255；y 向上） */
  private toCurve(e: PointerEvent | MouseEvent): Pt {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 255, (1 - (e.clientY - r.top) / r.height) * 255];
  }

  private hit(c: Pt): number {
    const r = this.canvas.getBoundingClientRect();
    const tol = (10 / r.width) * 255;
    let best = -1;
    let bd = Infinity;
    this.pts.forEach((p, i) => {
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (d < tol && d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  private down(e: PointerEvent) {
    e.preventDefault();
    const c = this.toCurve(e);
    let i = this.hit(c);
    if (i < 0) {
      if (this.pts.length >= MAX_POINTS) return;
      // 在滑鼠的輸入位置加一點，輸出取目前曲線的值（曲線不會跳動），接著拖曳調整
      const x = Math.round(Math.min(254, Math.max(1, c[0])));
      if (this.pts.some((p) => p[0] === x)) return;
      const lut = curveLut(this.pts);
      const y = lut ? Math.round(lut[x] * 255) : x;
      this.pts.push([x, y]);
      this.pts.sort((a, b) => a[0] - b[0]);
      i = this.pts.findIndex((p) => p[0] === x);
      this.onChange(this.points);
    }
    this.active = i;
    this.dragging = true;
    this.outside = false;
    this.canvas.setPointerCapture(e.pointerId);
    this.draw();
  }

  private move(e: PointerEvent) {
    if (!this.dragging) {
      this.canvas.style.cursor = this.hit(this.toCurve(e)) >= 0 ? "grab" : "crosshair";
      return;
    }
    const i = this.active;
    if (i < 0) return;
    const c = this.toCurve(e);
    const last = this.pts.length - 1;
    const lo = i === 0 ? 0 : this.pts[i - 1][0] + 1;
    const hi = i === last ? 255 : this.pts[i + 1][0] - 1;
    // 中間的點拖出框外 → 放開時刪除（與 Photoshop 相同）
    const margin = 24;
    const r = this.canvas.getBoundingClientRect();
    this.outside =
      i > 0 && i < last && (e.clientY < r.top - margin || e.clientY > r.bottom + margin || e.clientX < r.left - margin || e.clientX > r.right + margin);
    this.pts[i] = [Math.round(Math.min(hi, Math.max(lo, c[0]))), Math.round(Math.min(255, Math.max(0, c[1])))];
    this.onChange(this.outside ? this.pts.filter((_, k) => k !== i) : this.points);
    this.draw();
  }

  private up(e: PointerEvent) {
    if (!this.dragging) return;
    this.dragging = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (this.outside && this.active > 0 && this.active < this.pts.length - 1) {
      this.pts.splice(this.active, 1);
      this.active = -1;
      this.onChange(this.points);
    }
    this.outside = false;
    this.draw();
  }

  private dbl(e: MouseEvent) {
    const i = this.hit(this.toCurve(e));
    if (i > 0 && i < this.pts.length - 1) {
      this.pts.splice(i, 1);
      this.active = -1;
      this.onChange(this.points);
      this.draw();
    }
  }

  draw() {
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(cv.clientWidth * dpr));
    const h = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const g = cv.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "#1b1b1f";
    g.fillRect(0, 0, w, h);
    // 亮度分布（淡）
    if (this.hist) {
      let mx = 0;
      for (let i = 1; i < 255; i++) mx = Math.max(mx, this.hist[i]);
      if (mx > 0) {
        g.fillStyle = "#ffffff14";
        g.beginPath();
        g.moveTo(0, h);
        for (let i = 0; i < 256; i++) g.lineTo((i / 255) * w, h - Math.min(1, this.hist[i] / mx) * h * 0.9);
        g.lineTo(w, h);
        g.fill();
      }
    }
    // 格線
    g.strokeStyle = "#ffffff1f";
    g.lineWidth = 1;
    for (let k = 1; k < 4; k++) {
      g.beginPath();
      g.moveTo((k / 4) * w, 0);
      g.lineTo((k / 4) * w, h);
      g.moveTo(0, (k / 4) * h);
      g.lineTo(w, (k / 4) * h);
      g.stroke();
    }
    // 基準對角線
    g.setLineDash([4 * dpr, 4 * dpr]);
    g.strokeStyle = "#ffffff33";
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(w, 0);
    g.stroke();
    g.setLineDash([]);
    // 曲線
    const shown = this.outside ? this.pts.filter((_, k) => k !== this.active) : this.pts;
    const lut = curveLut(shown);
    if (lut) {
      g.strokeStyle = "#e8e8ea";
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      for (let i = 0; i < 256; i++) {
        const x = (i / 255) * w;
        const y = (1 - lut[i]) * h;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    // 控制點
    this.pts.forEach((p, i) => {
      if (this.outside && i === this.active) return;
      const x = (p[0] / 255) * w;
      const y = (1 - p[1] / 255) * h;
      g.beginPath();
      g.arc(x, y, 4.5 * dpr, 0, Math.PI * 2);
      g.fillStyle = i === this.active ? "#f5b33a" : "#1b1b1f";
      g.fill();
      g.strokeStyle = "#e8e8ea";
      g.lineWidth = 1.5 * dpr;
      g.stroke();
    });
    const a = this.active >= 0 && !this.outside ? this.pts[this.active] : null;
    this.readout.textContent = a ? `輸入 ${a[0]} · 輸出 ${a[1]}` : this.outside ? "放開以刪除這個點" : "點一下曲線加點，拖曳調整；雙擊或拖出框外刪除";
  }
}
