//! 局部修補（移除 / 修復 / 仿製），演算法與 src/heal.ts 相同（前端即時預覽用同一套）。
//! 每筆修補是一段筆刷（折線 + 半徑），從平移 offset 的來源位置取像素；
//! 仿製直接混合，修復 / 移除再加上平滑修正量（粗網格解 Laplace，邊界 = 目的地 − 來源），顏色明暗自然接上。

use image::RgbImage;
use serde::{Deserialize, Serialize};

pub const MAX_SPOT_POINTS: usize = 400;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Spot {
    /// 0 移除、1 修復、2 仿製
    pub m: u8,
    /// 半徑（相對長邊）
    pub r: f32,
    /// 羽化 0–1
    pub f: f32,
    /// 不透明度 0–1
    pub o: f32,
    /// 來源平移（相對寬高）
    pub d: [f32; 2],
    /// 筆刷路徑（相對寬高）
    pub p: Vec<[f32; 2]>,
    /// 移除的合成亂數種子（「重新整理」+1）
    #[serde(default, skip_serializing_if = "is_zero")]
    pub k: u32,
}

fn is_zero(k: &u32) -> bool {
    *k == 0
}

/// 整理：去掉無效的、數值限制在合理範圍（與 heal.ts cleanSpots 相同）
pub fn clean_spots(v: &[Spot]) -> Vec<Spot> {
    let num = |x: f32, lo: f32, hi: f32, def: f32| if x.is_finite() { x.clamp(lo, hi) } else { def };
    v.iter()
        .filter_map(|s| {
            let p: Vec<[f32; 2]> = s
                .p
                .iter()
                .filter(|q| q[0].is_finite() && q[1].is_finite())
                .take(MAX_SPOT_POINTS)
                .map(|q| [num(q[0], -1.0, 2.0, 0.0), num(q[1], -1.0, 2.0, 0.0)])
                .collect();
            (!p.is_empty()).then(|| Spot {
                m: if s.m <= 2 { s.m } else { 1 },
                r: num(s.r, 0.0005, 0.5, 0.01),
                f: num(s.f, 0.0, 1.0, 0.5),
                o: num(s.o, 0.0, 1.0, 1.0),
                d: [num(s.d[0], -2.0, 2.0, 0.0), num(s.d[1], -2.0, 2.0, 0.0)],
                p,
                k: s.k.min(1_000_000),
            })
        })
        .collect()
}

/// XMP 用的文字格式：每筆「m,r,f,o,dx,dy:x,y;x,y;…」，筆與筆之間用 |
pub fn to_text(v: &[Spot]) -> String {
    let n = |x: f32| format!("{}", (x * 100000.0).round() / 100000.0);
    v.iter()
        .map(|s| {
            let pts = s.p.iter().map(|q| format!("{},{}", n(q[0]), n(q[1]))).collect::<Vec<_>>().join(";");
            let k = if s.k > 0 { format!(",{}", s.k) } else { String::new() };
            format!("{},{},{},{},{},{}{}:{}", s.m, n(s.r), n(s.f), n(s.o), n(s.d[0]), n(s.d[1]), k, pts)
        })
        .collect::<Vec<_>>()
        .join("|")
}

pub fn from_text(t: &str) -> Vec<Spot> {
    let v: Vec<Spot> = t
        .split('|')
        .filter_map(|one| {
            let (head, pts) = one.split_once(':')?;
            let h: Vec<f32> = head.split(',').map(|x| x.trim().parse().unwrap_or(f32::NAN)).collect();
            if h.len() != 6 && h.len() != 7 {
                return None;
            }
            let p = pts
                .split(';')
                .filter_map(|q| {
                    let (a, b) = q.split_once(',')?;
                    Some([a.trim().parse().ok()?, b.trim().parse().ok()?])
                })
                .collect();
            let k = h.get(6).filter(|v| v.is_finite() && **v > 0.0).map(|v| *v as u32).unwrap_or(0);
            Some(Spot { m: h[0] as u8, r: h[1], f: h[2], o: h[3], d: [h[4], h[5]], p, k })
        })
        .collect();
    clean_spots(&v)
}

/// 照片旋轉 90° 時修補位置跟著轉
pub fn rotate_spots(v: &[Spot], clockwise: bool) -> Vec<Spot> {
    v.iter()
        .map(|s| {
            let rot = |q: [f32; 2]| if clockwise { [1.0 - q[1], q[0]] } else { [q[1], 1.0 - q[0]] };
            let d = if clockwise { [-s.d[1], s.d[0]] } else { [s.d[1], -s.d[0]] };
            Spot { p: s.p.iter().map(|q| rot(*q)).collect(), d, ..s.clone() }
        })
        .collect()
}

pub fn apply_spots(img: &mut RgbImage, spots: &[Spot]) {
    for s in spots {
        apply_spot(img, s);
    }
}

struct Px {
    r: f32,
    pts: Vec<[f32; 2]>,
    ox: i64,
    oy: i64,
}

fn margin(r: f32) -> f32 {
    (r * 0.35).max(2.0)
}

fn round_js(x: f32) -> i64 {
    // 與 JavaScript Math.round 相同（.5 往正無窮）
    (x + 0.5).floor() as i64
}

/// 羽化範圍：從 r·(1−f) 漸變到 r·(1+0.5f)（與 heal.ts outerR 相同）
fn outer_r(r: f32, f: f32) -> f32 {
    r * (1.0 + 0.5 * f)
}

fn fade_out(d: f32, r: f32, ro: f32) -> f32 {
    if d <= r {
        return 1.0;
    }
    if d >= ro {
        return 0.0;
    }
    let t = (d - r) / (ro - r);
    1.0 - t * t * (3.0 - 2.0 * t)
}

fn alpha_of(d: f32, r: f32, f: f32) -> f32 {
    let inner = r * (1.0 - f);
    let outer = outer_r(r, f);
    if d <= inner {
        return 1.0;
    }
    if d >= outer {
        return 0.0;
    }
    let t = (d - inner) / (outer - inner);
    1.0 - t * t * (3.0 - 2.0 * t)
}

fn apply_spot(img: &mut RgbImage, s: &Spot) {
    let (w, h) = (img.width() as i64, img.height() as i64);
    let (wf, hf) = (w as f32, h as f32);
    let px = Px {
        r: s.r * wf.max(hf),
        pts: s.p.iter().map(|q| [q[0] * wf, q[1] * hf]).collect(),
        ox: round_js(s.d[0] * wf),
        oy: round_js(s.d[1] * hf),
    };
    if px.r < 0.5 || px.pts.is_empty() {
        return;
    }
    let mg = margin(px.r);
    let ro = outer_r(px.r, s.f);
    // 移除（內容感知合成）需要比較大的周圍範圍當素材
    let synth = s.m == 0 && px.ox == 0 && px.oy == 0;
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for q in &px.pts {
        x0 = x0.min(q[0]);
        y0 = y0.min(q[1]);
        x1 = x1.max(q[0]);
        y1 = y1.max(q[1]);
    }
    let m = ro + if synth { context_margin(ro) } else { mg };
    let bx0 = ((x0 - m).floor() as i64).max(0);
    let by0 = ((y0 - m).floor() as i64).max(0);
    let bx1 = ((x1 + m).ceil() as i64 + 1).min(w);
    let by1 = ((y1 + m).ceil() as i64 + 1).min(h);
    let bw = bx1 - bx0;
    let bh = by1 - by0;
    if bw <= 0 || bh <= 0 {
        return;
    }
    let (bwu, bhu) = (bw as usize, bh as usize);
    // 每個像素到路徑的距離（逐段只算各自的外框）
    let mut dist = vec![1e9f32; bwu * bhu];
    let reach = ro + mg + 1.0;
    let n = px.pts.len();
    for k in 0..(n.max(2) - 1) {
        let a = px.pts[k.min(n - 1)];
        let b = px.pts[(k + 1).min(n - 1)];
        let sx0 = ((a[0].min(b[0]) - reach).floor() as i64).max(bx0);
        let sy0 = ((a[1].min(b[1]) - reach).floor() as i64).max(by0);
        let sx1 = ((a[0].max(b[0]) + reach).ceil() as i64).min(bx1);
        let sy1 = ((a[1].max(b[1]) + reach).ceil() as i64).min(by1);
        let (vx, vy) = (b[0] - a[0], b[1] - a[1]);
        let vv = vx * vx + vy * vy;
        for y in sy0..sy1 {
            for x in sx0..sx1 {
                let qx = x as f32 + 0.5 - a[0];
                let qy = y as f32 + 0.5 - a[1];
                let t = if vv > 0.0 { ((qx * vx + qy * vy) / vv).clamp(0.0, 1.0) } else { 0.0 };
                let dx = qx - t * vx;
                let dy = qy - t * vy;
                let d = (dx * dx + dy * dy).sqrt();
                let i = ((y - by0) * bw + (x - bx0)) as usize;
                if d < dist[i] {
                    dist[i] = d;
                }
            }
        }
    }
    // 移除（合成）：筆刷內完全替換，只在筆刷外圍漸變
    let alpha: Vec<f32> = dist.iter().map(|d| if synth { fade_out(*d, px.r, ro) } else { alpha_of(*d, px.r, s.f) }).collect();
    let mut dst = vec![0f32; bwu * bhu * 3];
    let mut src = vec![0f32; bwu * bhu * 3];
    for y in 0..bh {
        for x in 0..bw {
            let i = ((y * bw + x) * 3) as usize;
            let dp = img.get_pixel((x + bx0) as u32, (y + by0) as u32);
            let sx = (x + bx0 + px.ox).clamp(0, w - 1);
            let sy = (y + by0 + px.oy).clamp(0, h - 1);
            let sp = img.get_pixel(sx as u32, sy as u32);
            for k in 0..3 {
                dst[i + k] = dp[k] as f32;
                src[i + k] = sp[k] as f32;
            }
        }
    }
    // 移除：內容感知合成；有自訂來源時改成取樣 + 融合；周圍沒有素材時從兩側鏡射補
    if synth {
        let hole: Vec<u8> = alpha.iter().map(|a| u8::from(*a > 0.0)).collect();
        match inpaint(&dst, &hole, bwu, bhu, s.k) {
            Some(fill) => {
                for (o, v) in src.iter_mut().zip(fill) {
                    *o = v as f32;
                }
            }
            None => mirror_fill(img, &alpha, (bx0, by0, bwu, bhu), &mut src, &dst),
        }
    }
    let corr = if s.m != 2 && !synth { Some(Correction::new(&dst, &src, &alpha, bwu, bhu)) } else { None };
    for y in 0..bhu {
        for x in 0..bwu {
            let j = y * bwu + x;
            let a = alpha[j] * s.o;
            if a <= 0.0 {
                continue;
            }
            let c = corr.as_ref().map(|c| c.at(x, y)).unwrap_or([0.0; 3]);
            let p = img.get_pixel_mut((x as i64 + bx0) as u32, (y as i64 + by0) as u32);
            for k in 0..3 {
                let v = src[j * 3 + k] + c[k];
                let out = dst[j * 3 + k] + (v - dst[j * 3 + k]) * a;
                p[k] = round_js(out).clamp(0, 255) as u8;
            }
        }
    }
}

/// 移除：沿著修補範圍較窄的方向（左右或上下），取兩側鏡射位置的像素依距離混合（與 heal.ts mirrorFill 相同）
fn mirror_fill(img: &RgbImage, alpha: &[f32], b: (i64, i64, usize, usize), src: &mut [f32], dst: &[f32]) {
    let (x0, y0, bw, bh) = b;
    let (w, h) = (img.width() as i64, img.height() as i64);
    let n = bw * bh;
    let (mut ra, mut rb, mut ca, mut cb) = (vec![0usize; n], vec![0usize; n], vec![0usize; n], vec![0usize; n]);
    for y in 0..bh {
        let mut x = 0;
        while x < bw {
            if alpha[y * bw + x] <= 0.0 {
                x += 1;
                continue;
            }
            let mut e = x;
            while e + 1 < bw && alpha[y * bw + e + 1] > 0.0 {
                e += 1;
            }
            for k in x..=e {
                ra[y * bw + k] = x;
                rb[y * bw + k] = e;
            }
            x = e + 1;
        }
    }
    for x in 0..bw {
        let mut y = 0;
        while y < bh {
            if alpha[y * bw + x] <= 0.0 {
                y += 1;
                continue;
            }
            let mut e = y;
            while e + 1 < bh && alpha[(e + 1) * bw + x] > 0.0 {
                e += 1;
            }
            for k in y..=e {
                ca[k * bw + x] = y;
                cb[k * bw + x] = e;
            }
            y = e + 1;
        }
    }
    for y in 0..bh {
        for x in 0..bw {
            let j = y * bw + x;
            let i = j * 3;
            if alpha[j] <= 0.0 {
                src[i..i + 3].copy_from_slice(&dst[i..i + 3]);
                continue;
            }
            let horiz = rb[j] - ra[j] <= cb[j] - ca[j];
            let (a, e, p) = if horiz { (ra[j] as i64, rb[j] as i64, x as i64) } else { (ca[j] as i64, cb[j] as i64, y as i64) };
            let (base, lim) = if horiz { (x0, w) } else { (y0, h) };
            let lo = base + a - 1 - (p - a);
            let hi = base + e + 1 + (e - p);
            let mut t = (p - a) as f32 + 0.5;
            t /= (e - a + 1) as f32;
            let (lo_ok, hi_ok) = (lo >= 0, hi < lim);
            if !lo_ok && hi_ok {
                t = 1.0;
            }
            if lo_ok && !hi_ok {
                t = 0.0;
            }
            let l = lo.clamp(0, lim - 1) as u32;
            let r = hi.clamp(0, lim - 1) as u32;
            let (px, py) = ((x as i64 + x0) as u32, (y as i64 + y0) as u32);
            let (vl, vr) = if horiz { (img.get_pixel(l, py), img.get_pixel(r, py)) } else { (img.get_pixel(px, l), img.get_pixel(px, r)) };
            for k in 0..3 {
                src[i + k] = vl[k] as f32 * (1.0 - t) + vr[k] as f32 * t;
            }
        }
    }
}

struct Correction {
    d: Vec<f64>,
    gw: usize,
    gh: usize,
    cell: usize,
}

impl Correction {
    fn new(dst: &[f32], src: &[f32], alpha: &[f32], bw: usize, bh: usize) -> Self {
        let cell = bw.max(bh).div_ceil(48).max(1);
        let gw = bw.div_ceil(cell);
        let gh = bh.div_ceil(cell);
        let n = gw * gh;
        let mut sum = vec![0f64; n * 3];
        let mut cnt = vec![0f64; n];
        let mut inside = vec![false; n];
        for y in 0..bh {
            for x in 0..bw {
                let g = (y / cell) * gw + x / cell;
                let j = y * bw + x;
                if alpha[j] > 0.0 {
                    inside[g] = true;
                }
                for k in 0..3 {
                    sum[g * 3 + k] += (dst[j * 3 + k] - src[j * 3 + k]) as f64;
                }
                cnt[g] += 1.0;
            }
        }
        let mut d = vec![0f64; n * 3];
        let mut fixed = vec![false; n];
        let mut mean = [0f64; 3];
        let mut nb = 0f64;
        for gy in 0..gh {
            for gx in 0..gw {
                let g = gy * gw + gx;
                let edge = gx == 0 || gy == 0 || gx == gw - 1 || gy == gh - 1;
                if !inside[g] || edge {
                    fixed[g] = true;
                    for k in 0..3 {
                        d[g * 3 + k] = sum[g * 3 + k] / cnt[g].max(1.0);
                        mean[k] += d[g * 3 + k];
                    }
                    nb += 1.0;
                }
            }
        }
        for m in mean.iter_mut() {
            *m /= nb.max(1.0);
        }
        for g in 0..n {
            if !fixed[g] {
                d[g * 3..g * 3 + 3].copy_from_slice(&mean);
            }
        }
        let w = 1.8;
        for _ in 0..150 {
            for gy in 0..gh {
                for gx in 0..gw {
                    let g = gy * gw + gx;
                    if fixed[g] {
                        continue;
                    }
                    for k in 0..3 {
                        let (mut s, mut m) = (0f64, 0f64);
                        if gx > 0 {
                            s += d[(g - 1) * 3 + k];
                            m += 1.0;
                        }
                        if gx < gw - 1 {
                            s += d[(g + 1) * 3 + k];
                            m += 1.0;
                        }
                        if gy > 0 {
                            s += d[(g - gw) * 3 + k];
                            m += 1.0;
                        }
                        if gy < gh - 1 {
                            s += d[(g + gw) * 3 + k];
                            m += 1.0;
                        }
                        let v = d[g * 3 + k];
                        d[g * 3 + k] = v + w * (s / m - v);
                    }
                }
            }
        }
        Correction { d, gw, gh, cell }
    }

    fn at(&self, x: usize, y: usize) -> [f32; 3] {
        let (gw, gh, cell) = (self.gw, self.gh, self.cell as f64);
        let fx = ((x as f64 + 0.5) / cell - 0.5).clamp(0.0, (gw - 1) as f64);
        let fy = ((y as f64 + 0.5) / cell - 0.5).clamp(0.0, (gh - 1) as f64);
        let ax = fx.floor() as usize;
        let ay = fy.floor() as usize;
        let bx = (ax + 1).min(gw - 1);
        let by = (ay + 1).min(gh - 1);
        let tx = fx - ax as f64;
        let ty = fy - ay as f64;
        let mut out = [0f32; 3];
        for (k, o) in out.iter_mut().enumerate() {
            let d = &self.d;
            let a = d[(ay * gw + ax) * 3 + k] * (1.0 - tx) + d[(ay * gw + bx) * 3 + k] * tx;
            let b = d[(by * gw + ax) * 3 + k] * (1.0 - tx) + d[(by * gw + bx) * 3 + k] * tx;
            *o = (a * (1.0 - ty) + b * ty) as f32;
        }
        out
    }
}

// ---------------------------------------------------------------- 內容感知合成（PatchMatch）
// 與 src/heal.ts 的 inpaint 逐步相同（同樣的亂數、同樣的運算順序、f64）。
// 金字塔由粗到細：洞裡每個 7×7 小區塊在周圍找最像的小區塊（鄰居傳遞 + 隨機搜尋），再投票出顏色，反覆修正。

const PH: i64 = 3;

/// 合成用的周圍素材範圍：洞外圍再加這麼多像素（與 heal.ts contextMargin 相同）
fn context_margin(ro: f32) -> f32 {
    (ro * 2.5).round().max(18.0)
}

struct XorShift(u32);

impl XorShift {
    fn new(seed: u32) -> Self {
        let mut st = (seed.wrapping_add(1).wrapping_mul(2654435761)) ^ 0x9e37_79b9;
        if st == 0 {
            st = 1;
        }
        XorShift(st)
    }
    fn next(&mut self) -> u32 {
        let mut s = self.0;
        s ^= s << 13;
        s ^= s >> 17;
        s ^= s << 5;
        self.0 = s;
        s
    }
}

struct Lv {
    w: usize,
    h: usize,
    img: Vec<f64>,
    hole: Vec<u8>,
}

struct LvInfo {
    is_valid: Vec<u8>,
    is_target: Vec<u8>,
    valid: Vec<usize>,
    targets: Vec<usize>,
}

fn level_info(lv: &Lv) -> LvInfo {
    let (w, h) = (lv.w, lv.h);
    let mut ii = vec![0i64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0i64;
        for x in 0..w {
            row += lv.hole[y * w + x] as i64;
            ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
        }
    }
    let count = |xa: i64, ya: i64, xb: i64, yb: i64| -> i64 {
        let (xa, ya) = (xa.max(0), ya.max(0));
        let (xb, yb) = (xb.min(w as i64 - 1), yb.min(h as i64 - 1));
        if xa > xb || ya > yb {
            return 0;
        }
        let (xa, ya, xb, yb) = (xa as usize, ya as usize, xb as usize, yb as usize);
        ii[(yb + 1) * (w + 1) + xb + 1] - ii[ya * (w + 1) + xb + 1] - ii[(yb + 1) * (w + 1) + xa] + ii[ya * (w + 1) + xa]
    };
    let mut info = LvInfo { is_valid: vec![0; w * h], is_target: vec![0; w * h], valid: vec![], targets: vec![] };
    for y in 0..h as i64 {
        for x in 0..w as i64 {
            let p = (y as usize) * w + x as usize;
            if count(x - PH, y - PH, x + PH, y + PH) > 0 {
                info.is_target[p] = 1;
                info.targets.push(p);
            } else if x >= PH && y >= PH && x < w as i64 - PH && y < h as i64 - PH {
                info.is_valid[p] = 1;
                info.valid.push(p);
            }
        }
    }
    info
}

fn patch_dist(lv: &Lv, p: usize, s: usize, cutoff: f64) -> f64 {
    let w = lv.w as i64;
    let (px, py) = ((p % lv.w) as i64, (p / lv.w) as i64);
    let (sx, sy) = ((s % lv.w) as i64, (s / lv.w) as i64);
    let img = &lv.img;
    let mut acc = 0f64;
    for dy in -PH..=PH {
        let ty = py + dy;
        if ty < 0 || ty >= lv.h as i64 {
            continue;
        }
        for dx in -PH..=PH {
            let tx = px + dx;
            if tx < 0 || tx >= w {
                continue;
            }
            let t = ((ty * w + tx) * 3) as usize;
            let u = (((sy + dy) * w + sx + dx) * 3) as usize;
            let d0 = img[t] - img[u];
            let d1 = img[t + 1] - img[u + 1];
            let d2 = img[t + 2] - img[u + 2];
            acc += d0 * d0 + d1 * d1 + d2 * d2;
        }
        if acc >= cutoff {
            return acc;
        }
    }
    acc
}

fn vote(lv: &mut Lv, targets: &[usize], ns: &[i64], nd: Option<&[f64]>) {
    let (w, h) = (lv.w as i64, lv.h as i64);
    let n = lv.w * lv.h;
    let mut acc = vec![0f64; n * 3];
    let mut wt = vec![0f64; n];
    // 權重：越像的小區塊說話越大聲（1 / (1 + 差異 / 中位數)）
    let mut med = 0f64;
    if let Some(nd) = nd {
        if !targets.is_empty() {
            let mut arr: Vec<f64> = targets.iter().map(|p| nd[*p]).collect();
            arr.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            med = arr[arr.len() >> 1];
        }
    }
    for &p in targets {
        let s = ns[p] as usize;
        let wp = match nd {
            Some(nd) if med > 0.0 => 1.0 / (1.0 + nd[p] / med),
            _ => 1.0,
        };
        let (px, py) = ((p % lv.w) as i64, (p / lv.w) as i64);
        let (sx, sy) = ((s % lv.w) as i64, (s / lv.w) as i64);
        for dy in -PH..=PH {
            let ty = py + dy;
            if ty < 0 || ty >= h {
                continue;
            }
            for dx in -PH..=PH {
                let tx = px + dx;
                if tx < 0 || tx >= w {
                    continue;
                }
                let t = (ty * w + tx) as usize;
                if lv.hole[t] == 0 {
                    continue;
                }
                let u = (((sy + dy) * w + sx + dx) * 3) as usize;
                acc[t * 3] += lv.img[u] * wp;
                acc[t * 3 + 1] += lv.img[u + 1] * wp;
                acc[t * 3 + 2] += lv.img[u + 2] * wp;
                wt[t] += wp;
            }
        }
    }
    for t in 0..n {
        if lv.hole[t] == 0 || wt[t] <= 0.0 {
            continue;
        }
        for k in 0..3 {
            lv.img[t * 3 + k] = acc[t * 3 + k] / wt[t];
        }
    }
}

fn diffuse_init(lv: &mut Lv) {
    let (w, h) = (lv.w, lv.h);
    let mut mean = [0f64; 3];
    let mut n = 0f64;
    for i in 0..w * h {
        if lv.hole[i] != 0 {
            continue;
        }
        for (k, m) in mean.iter_mut().enumerate() {
            *m += lv.img[i * 3 + k];
        }
        n += 1.0;
    }
    for m in mean.iter_mut() {
        *m /= n.max(1.0);
    }
    for i in 0..w * h {
        if lv.hole[i] != 0 {
            lv.img[i * 3..i * 3 + 3].copy_from_slice(&mean);
        }
    }
    for _ in 0..60 {
        for y in 0..h {
            for x in 0..w {
                let i = y * w + x;
                if lv.hole[i] == 0 {
                    continue;
                }
                for k in 0..3 {
                    let (mut sum, mut m) = (0f64, 0f64);
                    if x > 0 {
                        sum += lv.img[(i - 1) * 3 + k];
                        m += 1.0;
                    }
                    if x < w - 1 {
                        sum += lv.img[(i + 1) * 3 + k];
                        m += 1.0;
                    }
                    if y > 0 {
                        sum += lv.img[(i - w) * 3 + k];
                        m += 1.0;
                    }
                    if y < h - 1 {
                        sum += lv.img[(i + w) * 3 + k];
                        m += 1.0;
                    }
                    lv.img[i * 3 + k] = sum / m;
                }
            }
        }
    }
}

/// 回傳填好的影像（RGB，與 dst 同大小）；周圍沒有可用素材時回傳 None
fn inpaint(dst: &[f32], hole0: &[u8], bw: usize, bh: usize, seed: u32) -> Option<Vec<f64>> {
    if !hole0.iter().any(|h| *h != 0) {
        return None;
    }
    let side = (2 * PH + 1) as usize;
    let mut lvs = vec![Lv { w: bw, h: bh, img: dst.iter().map(|v| *v as f64).collect(), hole: hole0.to_vec() }];
    while lvs.len() < 6 {
        let c = lvs.last().unwrap();
        if c.w.max(c.h) <= 40 || c.w.min(c.h) < 4 * side {
            break;
        }
        let (w, h) = (c.w.div_ceil(2), c.h.div_ceil(2));
        let mut img = vec![0f64; w * h * 3];
        let mut hole = vec![0u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut n = 0f64;
                let mut sum = [0f64; 3];
                let mut ho = 0u8;
                for j in 0..2 {
                    for i in 0..2 {
                        let (xx, yy) = (x * 2 + i, y * 2 + j);
                        if xx >= c.w || yy >= c.h {
                            continue;
                        }
                        let q = yy * c.w + xx;
                        for (k, sv) in sum.iter_mut().enumerate() {
                            *sv += c.img[q * 3 + k];
                        }
                        if c.hole[q] != 0 {
                            ho = 1;
                        }
                        n += 1.0;
                    }
                }
                let p = y * w + x;
                for k in 0..3 {
                    img[p * 3 + k] = sum[k] / n;
                }
                hole[p] = ho;
            }
        }
        lvs.push(Lv { w, h, img, hole });
    }
    let info: Vec<LvInfo> = lvs.iter().map(level_info).collect();
    // 洞很大時只做到「要填的小區塊數 ≤ MAX_TARGETS」的那一層，再放大回原尺寸（與 heal.ts 相同）
    let mut bottom = 0usize;
    while bottom < lvs.len() - 1 && info[bottom].targets.len() > MAX_TARGETS {
        bottom += 1;
    }
    let mut top = lvs.len() as i64 - 1;
    while top >= 0 && info[top as usize].valid.is_empty() {
        top -= 1;
    }
    if top < 0 {
        return None;
    }
    let top = top as usize;
    let mut rnd = XorShift::new(seed);
    let mut ns: Option<Vec<i64>> = None;
    if bottom > top {
        bottom = top;
    }
    for l in (bottom..=top).rev() {
        let (lw, lh) = (lvs[l].w, lvs[l].h);
        let inf = &info[l];
        let n = lw * lh;
        let mut next = vec![-1i64; n];
        match &ns {
            None => {
                for &p in &inf.targets {
                    next[p] = inf.valid[(rnd.next() % inf.valid.len() as u32) as usize] as i64;
                }
                diffuse_init(&mut lvs[l]);
            }
            Some(prev) => {
                let (cw, ch) = (lvs[l + 1].w, lvs[l + 1].h);
                for &p in &inf.targets {
                    let (px, py) = ((p % lw) as i64, (p / lw) as i64);
                    let cx = (px >> 1).min(cw as i64 - 1);
                    let cy = (py >> 1).min(ch as i64 - 1);
                    let cs = prev[(cy as usize) * cw + cx as usize];
                    let mut cand = -1i64;
                    if cs >= 0 {
                        let sx = px + ((cs % cw as i64) - cx) * 2;
                        let sy = py + ((cs / cw as i64) - cy) * 2;
                        if sx >= 0 && sy >= 0 && sx < lw as i64 && sy < lh as i64 && inf.is_valid[(sy as usize) * lw + sx as usize] != 0 {
                            cand = sy * lw as i64 + sx;
                        }
                    }
                    next[p] = if cand >= 0 { cand } else { inf.valid[(rnd.next() % inf.valid.len() as u32) as usize] as i64 };
                }
                vote(&mut lvs[l], &inf.targets, &next, None);
            }
        }
        let em = if l == top { 6 } else if l == bottom { 3 } else { 4 };
        let pmi = if l == top { 4 } else { 3 };
        let mut nd = vec![0f64; n];
        for _ in 0..em {
            for &p in &inf.targets {
                nd[p] = patch_dist(&lvs[l], p, next[p] as usize, f64::INFINITY);
            }
            for it in 0..pmi {
                let fwd = it % 2 == 0;
                let t_len = inf.targets.len();
                for ti in 0..t_len {
                    let p = inf.targets[if fwd { ti } else { t_len - 1 - ti }];
                    let (px, py) = ((p % lw) as i64, (p / lw) as i64);
                    for pass in 0..2 {
                        let dx: i64 = if pass == 0 { if fwd { -1 } else { 1 } } else { 0 };
                        let dy: i64 = if pass == 1 { if fwd { -1 } else { 1 } } else { 0 };
                        let (qx, qy) = (px + dx, py + dy);
                        if qx < 0 || qy < 0 || qx >= lw as i64 || qy >= lh as i64 {
                            continue;
                        }
                        let q = (qy as usize) * lw + qx as usize;
                        if inf.is_target[q] == 0 {
                            continue;
                        }
                        let sq = next[q];
                        let sx = (sq % lw as i64) - dx;
                        let sy = (sq / lw as i64) - dy;
                        if sx < 0 || sy < 0 || sx >= lw as i64 || sy >= lh as i64 {
                            continue;
                        }
                        let cand = sy * lw as i64 + sx;
                        if inf.is_valid[cand as usize] == 0 || cand == next[p] {
                            continue;
                        }
                        let d = patch_dist(&lvs[l], p, cand as usize, nd[p]);
                        if d < nd[p] {
                            nd[p] = d;
                            next[p] = cand;
                        }
                    }
                    let mut rad = lw.max(lh) as i64;
                    while rad >= 1 {
                        let bx = next[p] % lw as i64;
                        let by = next[p] / lw as i64;
                        let span = (2 * rad + 1) as u32;
                        let sx = bx + (rnd.next() % span) as i64 - rad;
                        let sy = by + (rnd.next() % span) as i64 - rad;
                        if sx >= 0 && sy >= 0 && sx < lw as i64 && sy < lh as i64 {
                            let cand = sy * lw as i64 + sx;
                            if inf.is_valid[cand as usize] != 0 && cand != next[p] {
                                let d = patch_dist(&lvs[l], p, cand as usize, nd[p]);
                                if d < nd[p] {
                                    nd[p] = d;
                                    next[p] = cand;
                                }
                            }
                        }
                        rad /= 2;
                    }
                }
            }
            vote(&mut lvs[l], &inf.targets, &next, Some(&nd));
        }
        if l == 0 && bottom == 0 {
            // 最後一步：每個像素直接取最像的小區塊中心的顏色（不平均），保留顆粒與細節
            let lv = &mut lvs[0];
            for &q in &inf.targets {
                if lv.hole[q] == 0 {
                    continue;
                }
                let src = next[q] as usize;
                for k in 0..3 {
                    lv.img[q * 3 + k] = lv.img[src * 3 + k];
                }
            }
        }
        ns = Some(next);
    }
    if bottom > 0 {
        let src = lvs.remove(bottom);
        upsample_into(&mut lvs[0], &src, bottom);
    }
    Some(lvs.swap_remove(0).img)
}

const MAX_TARGETS: usize = 40000;

fn upsample_into(dst: &mut Lv, src: &Lv, levels: usize) {
    let f = (1u32 << levels) as f64;
    for y in 0..dst.h {
        for x in 0..dst.w {
            let q = y * dst.w + x;
            if dst.hole[q] == 0 {
                continue;
            }
            let fx = ((x as f64 + 0.5) / f - 0.5).clamp(0.0, (src.w - 1) as f64);
            let fy = ((y as f64 + 0.5) / f - 0.5).clamp(0.0, (src.h - 1) as f64);
            let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
            let (x1, y1) = ((x0 + 1).min(src.w - 1), (y0 + 1).min(src.h - 1));
            let (tx, ty) = (fx - x0 as f64, fy - y0 as f64);
            for k in 0..3 {
                let a = src.img[(y0 * src.w + x0) * 3 + k] * (1.0 - tx) + src.img[(y0 * src.w + x1) * 3 + k] * tx;
                let b = src.img[(y1 * src.w + x0) * 3 + k] * (1.0 - tx) + src.img[(y1 * src.w + x1) * 3 + k] * tx;
                dst.img[q * 3 + k] = a * (1.0 - ty) + b * ty;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spot(m: u8) -> Spot {
        Spot { m, r: 0.05, f: 0.3, o: 1.0, d: [0.3, 0.0], p: vec![[0.3, 0.5]], k: 0 }
    }

    #[test]
    fn clone_copies_source() {
        // 左半黑、右半白；在左邊點一下，來源在右邊 → 仿製後中心變白
        let mut img = RgbImage::from_fn(200, 100, |x, _| if x < 100 { image::Rgb([0, 0, 0]) } else { image::Rgb([255, 255, 255]) });
        apply_spots(&mut img, &[spot(2)]);
        assert_eq!(img.get_pixel(60, 50)[0], 255);
        // 筆刷外不變
        assert_eq!(img.get_pixel(5, 5)[0], 0);
    }

    #[test]
    fn heal_matches_surroundings() {
        // 灰底上的黑點，從亮很多的區域取紋理 → 修復後的顏色接近周圍的灰，而不是來源的亮度
        let mut img = RgbImage::from_fn(200, 100, |x, y| {
            if x >= 100 {
                image::Rgb([230, 230, 230])
            } else if (x as i32 - 60).pow(2) + (y as i32 - 50).pow(2) < 16 {
                image::Rgb([0, 0, 0])
            } else {
                image::Rgb([120, 120, 120])
            }
        });
        apply_spots(&mut img, &[spot(1)]);
        let c = img.get_pixel(60, 50)[0] as i32;
        assert!((c - 120).abs() < 12, "healed {c}");
    }

    #[test]
    fn remove_fills_from_both_sides() {
        // 左邊紅、右邊藍，中間一條黑色直線 → 移除後黑線消失：中線處變成紅或藍（交界延續），兩側維持原色
        let mut img = RgbImage::from_fn(200, 100, |x, _| {
            if (98..=102).contains(&x) {
                image::Rgb([0, 0, 0])
            } else if x < 100 {
                image::Rgb([200, 0, 0])
            } else {
                image::Rgb([0, 0, 200])
            }
        });
        let s = Spot { m: 0, r: 0.02, f: 0.0, o: 1.0, d: [0.0, 0.0], p: vec![[0.5, 0.1], [0.5, 0.9]], k: 0 };
        apply_spots(&mut img, &[s]);
        for y in 20..80 {
            let c = img.get_pixel(100, y);
            assert!(c[0].max(c[2]) > 150, "y={y} {c:?}");
        }
        let l = img.get_pixel(94, 50);
        assert!(l[0] > 150 && l[2] < 60, "{l:?}");
        let r = img.get_pixel(106, 50);
        assert!(r[2] > 150 && r[0] < 60, "{r:?}");
    }

    /// 與前端比對：HEAL_CMP_DIR=資料夾 cargo test heal_cmp -- --ignored（讀 in.rgb、spots.json，寫 rs.rgb）
    #[test]
    #[ignore]
    fn heal_cmp() {
        let dir = std::path::PathBuf::from(std::env::var("HEAL_CMP_DIR").unwrap());
        let raw = std::fs::read(dir.join("in.rgb")).unwrap();
        let mut img = RgbImage::from_raw(300, 200, raw).unwrap();
        let spots: Vec<Spot> = serde_json::from_str(&std::fs::read_to_string(dir.join("spots.json")).unwrap()).unwrap();
        apply_spots(&mut img, &spots);
        std::fs::write(dir.join("rs.rgb"), img.as_raw()).unwrap();
    }

    #[test]
    fn synth_continues_stripes() {
        // 直條紋背景上的一個黑點 → 合成後中心附近仍是條紋（不是平均灰色），而且沒有黑色
        let mut img = RgbImage::from_fn(240, 160, |x, y| {
            if (x as i32 - 120).pow(2) + (y as i32 - 80).pow(2) < 64 {
                image::Rgb([0, 0, 0])
            } else if (x / 6) % 2 == 0 {
                image::Rgb([220, 220, 220])
            } else {
                image::Rgb([60, 60, 60])
            }
        });
        let s = Spot { m: 0, r: 0.05, f: 0.2, o: 1.0, d: [0.0, 0.0], p: vec![[0.5, 0.5]], k: 0 };
        apply_spots(&mut img, &[s]);
        let row: Vec<u8> = (108..132).map(|x| img.get_pixel(x, 80)[0]).collect();
        let hi = row.iter().filter(|v| **v > 170).count();
        let lo = row.iter().filter(|v| **v < 110).count();
        assert!(hi >= 6 && lo >= 6, "{row:?}");
        assert!(row.iter().all(|v| *v > 25), "{row:?}");
    }

    #[test]
    fn text_roundtrip_and_rotate() {
        let v = vec![Spot { m: 0, r: 0.0123, f: 0.5, o: 0.8, d: [0.1, -0.05], p: vec![[0.2, 0.3], [0.25, 0.35]], k: 3 }, spot(2)];
        let back = from_text(&to_text(&v));
        assert_eq!(back.len(), 2);
        assert!((back[0].p[1][1] - 0.35).abs() < 1e-6 && back[0].m == 0 && back[1].m == 2);
        let mut r = v.clone();
        for _ in 0..4 {
            r = rotate_spots(&r, true);
        }
        for (a, b) in r.iter().zip(&v) {
            for (p, q) in a.p.iter().zip(&b.p) {
                assert!((p[0] - q[0]).abs() < 1e-6 && (p[1] - q[1]).abs() < 1e-6);
            }
            assert!((a.d[0] - b.d[0]).abs() < 1e-6 && (a.d[1] - b.d[1]).abs() < 1e-6);
        }
        let close = |a: &[Spot], b: &[Spot]| {
            a.len() == b.len()
                && a.iter().zip(b).all(|(x, y)| {
                    x.m == y.m
                        && (x.r - y.r).abs() < 1e-6
                        && (x.d[0] - y.d[0]).abs() < 1e-6
                        && (x.d[1] - y.d[1]).abs() < 1e-6
                        && x.p.iter().zip(&y.p).all(|(p, q)| (p[0] - q[0]).abs() < 1e-6 && (p[1] - q[1]).abs() < 1e-6)
                })
        };
        assert!(close(&rotate_spots(&rotate_spots(&v, true), false), &v));
    }
}
