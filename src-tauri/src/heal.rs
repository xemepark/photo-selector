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
            format!("{},{},{},{},{},{}:{}", s.m, n(s.r), n(s.f), n(s.o), n(s.d[0]), n(s.d[1]), pts)
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
            if h.len() != 6 {
                return None;
            }
            let p = pts
                .split(';')
                .filter_map(|q| {
                    let (a, b) = q.split_once(',')?;
                    Some([a.trim().parse().ok()?, b.trim().parse().ok()?])
                })
                .collect();
            Some(Spot { m: h[0] as u8, r: h[1], f: h[2], o: h[3], d: [h[4], h[5]], p })
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
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for q in &px.pts {
        x0 = x0.min(q[0]);
        y0 = y0.min(q[1]);
        x1 = x1.max(q[0]);
        y1 = y1.max(q[1]);
    }
    let m = ro + mg;
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
    let alpha: Vec<f32> = dist.iter().map(|d| alpha_of(*d, px.r, s.f)).collect();
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
    // 移除：平常和修復一樣（自動來源 + 融合）；offset 為 0（找不到來源）時從兩側鏡射補
    let mirror = s.m == 0 && px.ox == 0 && px.oy == 0;
    if mirror {
        mirror_fill(img, &alpha, (bx0, by0, bwu, bhu), &mut src, &dst);
    }
    let corr = if s.m != 2 && !mirror { Some(Correction::new(&dst, &src, &alpha, bwu, bhu)) } else { None };
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

#[cfg(test)]
mod tests {
    use super::*;

    fn spot(m: u8) -> Spot {
        Spot { m, r: 0.05, f: 0.3, o: 1.0, d: [0.3, 0.0], p: vec![[0.3, 0.5]] }
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
        // 左邊紅、右邊藍，中間一條黑色直線 → 移除後中線附近是紅藍之間的顏色，不再是黑色
        let mut img = RgbImage::from_fn(200, 100, |x, _| {
            if (98..=102).contains(&x) {
                image::Rgb([0, 0, 0])
            } else if x < 100 {
                image::Rgb([200, 0, 0])
            } else {
                image::Rgb([0, 0, 200])
            }
        });
        let s = Spot { m: 0, r: 0.02, f: 0.0, o: 1.0, d: [0.0, 0.0], p: vec![[0.5, 0.1], [0.5, 0.9]] };
        apply_spots(&mut img, &[s]);
        let c = img.get_pixel(100, 50);
        assert!(c[0] > 50 && c[2] > 50, "{c:?}");
        let l = img.get_pixel(97, 50);
        assert!(l[0] > 150 && l[2] < 60, "{l:?}");
    }

    #[test]
    fn text_roundtrip_and_rotate() {
        let v = vec![Spot { m: 0, r: 0.0123, f: 0.5, o: 0.8, d: [0.1, -0.05], p: vec![[0.2, 0.3], [0.25, 0.35]] }, spot(2)];
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
