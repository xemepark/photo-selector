//! 液化（仿 Photoshop 液化濾鏡的向前彎曲 / 膨脹 / 縮攏 / 重建）。與 src/liquify.ts 的演算法相同，改公式時兩邊要一起改。
//!
//! 依序重播所有筆刷，算出固定格點上的位移場（與解析度無關），輸出的每個像素到「位置 + 位移」取樣，
//! 所以縮圖、預覽、原尺寸轉存的結果都一樣。

use image::RgbImage;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

pub const MAX_POINTS: usize = 3000;
pub const MAX_STROKES: usize = 300;
/// 長邊的格數
const G: f32 = 400.0;
/// 存檔時路徑座標的單位（1/Q）
const Q: f32 = 20000.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Stroke {
    /// 0 推移、1 膨脹、2 縮攏、3 重建
    pub m: u8,
    /// 半徑（相對長邊）
    pub r: f32,
    /// 強度 0–1
    pub s: f32,
    /// 路徑（相對寬高）
    pub p: Vec<[f32; 2]>,
}

pub fn clean(v: &[Stroke]) -> Vec<Stroke> {
    v.iter()
        .filter(|s| s.m <= 3 && s.r.is_finite() && s.r > 0.0 && s.s.is_finite() && s.s > 0.0)
        .filter_map(|s| {
            let p: Vec<[f32; 2]> = s
                .p
                .iter()
                .filter(|q| q[0].is_finite() && q[1].is_finite())
                .take(MAX_POINTS)
                .map(|q| [q[0].clamp(-1.0, 2.0), q[1].clamp(-1.0, 2.0)])
                .collect();
            (!p.is_empty()).then(|| Stroke { m: s.m, r: s.r.clamp(0.001, 0.5), s: s.s.clamp(0.01, 1.0), p })
        })
        .take(MAX_STROKES)
        .collect()
}

/// 存進 XMP 的文字：`m,r,s:x0,y0;dx,dy;…|…`（路徑以 1/20000 為單位、差分編碼，JPEG 內嵌 XMP 有大小上限）
pub fn to_text(v: &[Stroke]) -> String {
    let n = |x: f32| format!("{}", (x * 100000.0).round() / 100000.0);
    v.iter()
        .map(|s| {
            let mut prev = (0i64, 0i64);
            let pts = s
                .p
                .iter()
                .enumerate()
                .map(|(i, q)| {
                    let cur = ((q[0] * Q).round() as i64, (q[1] * Q).round() as i64);
                    let t = if i == 0 { format!("{},{}", cur.0, cur.1) } else { format!("{},{}", cur.0 - prev.0, cur.1 - prev.1) };
                    prev = cur;
                    t
                })
                .collect::<Vec<_>>()
                .join(";");
            format!("{},{},{}:{}", s.m, n(s.r), n(s.s), pts)
        })
        .collect::<Vec<_>>()
        .join("|")
}

pub fn from_text(t: &str) -> Vec<Stroke> {
    let v: Vec<Stroke> = t
        .split('|')
        .filter_map(|one| {
            let (head, pts) = one.split_once(':')?;
            let h: Vec<f32> = head.split(',').map(|x| x.trim().parse().unwrap_or(f32::NAN)).collect();
            if h.len() != 3 {
                return None;
            }
            let mut acc = (0i64, 0i64);
            let p = pts
                .split(';')
                .filter_map(|q| {
                    let (a, b) = q.split_once(',')?;
                    acc.0 += a.trim().parse::<i64>().ok()?;
                    acc.1 += b.trim().parse::<i64>().ok()?;
                    Some([acc.0 as f32 / Q, acc.1 as f32 / Q])
                })
                .collect();
            Some(Stroke { m: h[0] as u8, r: h[1], s: h[2], p })
        })
        .collect();
    clean(&v)
}

/// 位移場：格點 (i, j) 在長邊單位的 (i/G, j/G)，值也是長邊單位
pub struct Field {
    gw: usize,
    gh: usize,
    dx: Vec<f32>,
    dy: Vec<f32>,
    aw: f32,
    ah: f32,
}

impl Field {
    pub fn new(w: u32, h: u32) -> Self {
        let l = w.max(h) as f32;
        let aw = w as f32 / l;
        let ah = h as f32 / l;
        let gw = (aw * G).ceil() as usize + 2;
        let gh = (ah * G).ceil() as usize + 2;
        Field { gw, gh, dx: vec![0.0; gw * gh], dy: vec![0.0; gw * gh], aw, ah }
    }

    fn sample(&self, u: f32, v: f32) -> (f32, f32) {
        let gx = (u * G).clamp(0.0, self.gw as f32 - 1.001);
        let gy = (v * G).clamp(0.0, self.gh as f32 - 1.001);
        let i = gx.floor() as usize;
        let j = gy.floor() as usize;
        let tx = gx - i as f32;
        let ty = gy - j as f32;
        let k = j * self.gw + i;
        let g = self.gw;
        let (dx, dy) = (&self.dx, &self.dy);
        let a = dx[k] * (1.0 - tx) + dx[k + 1] * tx;
        let b = dx[k + g] * (1.0 - tx) + dx[k + g + 1] * tx;
        let c = dy[k] * (1.0 - tx) + dy[k + 1] * tx;
        let d = dy[k + g] * (1.0 - tx) + dy[k + g + 1] * tx;
        (a * (1.0 - ty) + b * ty, c * (1.0 - ty) + d * ty)
    }

    #[allow(clippy::too_many_arguments)]
    fn dab(&mut self, mode: u8, cu: f32, cv: f32, r: f32, k: f32, vu: f32, vv: f32) {
        let i0 = ((cu - r) * G).floor().max(0.0) as i64;
        let i1 = (((cu + r) * G).ceil() as i64).min(self.gw as i64 - 1);
        let j0 = ((cv - r) * G).floor().max(0.0) as i64;
        let j1 = (((cv + r) * G).ceil() as i64).min(self.gh as i64 - 1);
        if i1 < i0 || j1 < j0 {
            return;
        }
        let bw = (i1 - i0 + 1) as usize;
        let mut nx = vec![0f32; bw * (j1 - j0 + 1) as usize];
        let mut ny = nx.clone();
        for j in j0..=j1 {
            for i in i0..=i1 {
                let idx = j as usize * self.gw + i as usize;
                let o = (j - j0) as usize * bw + (i - i0) as usize;
                let u = i as f32 / G;
                let v = j as f32 / G;
                let t = ((u - cu) * (u - cu) + (v - cv) * (v - cv)).sqrt() / r;
                if t >= 1.0 {
                    nx[o] = self.dx[idx];
                    ny[o] = self.dy[idx];
                    continue;
                }
                let w = k * (1.0 - t * t) * (1.0 - t * t);
                if mode == 3 {
                    let f = 1.0 - 0.25 * w;
                    nx[o] = self.dx[idx] * f;
                    ny[o] = self.dy[idx] * f;
                    continue;
                }
                let (su, sv) = if mode == 0 {
                    (u - w * vu, v - w * vv)
                } else {
                    let f = if mode == 1 { 1.0 - 0.12 * w } else { 1.0 + 0.12 * w };
                    (cu + (u - cu) * f, cv + (v - cv) * f)
                };
                let (ox, oy) = self.sample(su, sv);
                nx[o] = ox + su - u;
                ny[o] = oy + sv - v;
            }
        }
        for j in j0..=j1 {
            for i in i0..=i1 {
                let o = (j - j0) as usize * bw + (i - i0) as usize;
                let idx = j as usize * self.gw + i as usize;
                self.dx[idx] = nx[o];
                self.dy[idx] = ny[o];
            }
        }
    }

    pub fn apply_stroke(&mut self, s: &Stroke) {
        let pts: Vec<(f32, f32)> = s.p.iter().map(|q| (q[0] * self.aw, q[1] * self.ah)).collect();
        if s.m != 0 {
            if let Some(&(x, y)) = pts.first() {
                self.dab(s.m, x, y, s.r, s.s, 0.0, 0.0);
            }
        }
        for i in 1..pts.len() {
            let (ax, ay) = pts[i - 1];
            let (bx, by) = pts[i];
            let len = ((bx - ax) * (bx - ax) + (by - ay) * (by - ay)).sqrt();
            let n = ((len / (s.r * 0.25)).ceil() as usize).max(1);
            let (sx, sy) = ((bx - ax) / n as f32, (by - ay) / n as f32);
            for q in 1..=n {
                let cx = ax + (bx - ax) * q as f32 / n as f32;
                let cy = ay + (by - ay) * q as f32 / n as f32;
                if s.m == 0 {
                    if len > 0.0 {
                        self.dab(0, cx - sx, cy - sy, s.r, s.s, sx, sy);
                    }
                } else {
                    self.dab(s.m, cx, cy, s.r, s.s, 0.0, 0.0);
                }
            }
        }
    }

    pub fn build(strokes: &[Stroke], w: u32, h: u32) -> Self {
        let mut f = Field::new(w, h);
        for s in strokes {
            f.apply_stroke(s);
        }
        f
    }
}

/// 依筆刷變形整張影像
pub fn apply(img: &mut RgbImage, strokes: &[Stroke]) {
    if strokes.is_empty() {
        return;
    }
    let (w, h) = img.dimensions();
    if w < 2 || h < 2 {
        return;
    }
    let f = Field::build(strokes, w, h);
    let src = img.clone();
    let s = src.as_raw();
    let l = w.max(h) as f32;
    let (wu, hu) = (w as usize, h as usize);
    img.as_mut().par_chunks_mut(wu * 3).enumerate().for_each(|(y, row)| {
        let v = (y as f32 + 0.5) / l;
        for x in 0..wu {
            let u = (x as f32 + 0.5) / l;
            let (du, dv) = f.sample(u, v);
            if du == 0.0 && dv == 0.0 {
                continue;
            }
            let sx = ((u + du) * l - 0.5).clamp(0.0, (wu - 1) as f32);
            let sy = ((v + dv) * l - 0.5).clamp(0.0, (hu - 1) as f32);
            let ix = (sx.floor() as usize).min(wu - 2);
            let iy = (sy.floor() as usize).min(hu - 2);
            let tx = (sx - ix as f32).max(0.0);
            let ty = (sy - iy as f32).max(0.0);
            let a = (iy * wu + ix) * 3;
            let b = a + 3;
            let c = a + wu * 3;
            let e = c + 3;
            for ch in 0..3 {
                let top = s[a + ch] as f32 * (1.0 - tx) + s[b + ch] as f32 * tx;
                let bot = s[c + ch] as f32 * (1.0 - tx) + s[e + ch] as f32 * tx;
                row[x * 3 + ch] = (top * (1.0 - ty) + bot * ty + 0.5).min(255.0) as u8;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_round_trip() {
        let v = vec![
            Stroke { m: 0, r: 0.05, s: 0.5, p: vec![[0.25, 0.5], [0.3, 0.52], [0.31, 0.53]] },
            Stroke { m: 2, r: 0.1, s: 1.0, p: vec![[0.5, 0.5], [0.5, 0.5]] },
        ];
        let back = from_text(&to_text(&v));
        assert_eq!(back.len(), 2);
        assert_eq!(back[1].m, 2);
        for (a, b) in v[0].p.iter().zip(&back[0].p) {
            assert!((a[0] - b[0]).abs() < 1e-4 && (a[1] - b[1]).abs() < 1e-4);
        }
    }

    #[test]
    fn push_moves_content_along_stroke() {
        // 中間一條白色直線，往右推之後白線應該往右移
        let (w, h) = (200u32, 100u32);
        let mut img = RgbImage::new(w, h);
        for y in 0..h {
            for x in 98..102 {
                img.put_pixel(x, y, image::Rgb([255, 255, 255]));
            }
        }
        let s = Stroke { m: 0, r: 0.1, s: 1.0, p: vec![[0.5, 0.5], [0.55, 0.5]] };
        apply(&mut img, &[s]);
        let row: Vec<u8> = (0..w).map(|x| img.get_pixel(x, 50)[0]).collect();
        let peak = row.iter().enumerate().max_by_key(|(_, v)| **v).unwrap().0;
        assert!(peak > 102 && peak < 115, "peak at {peak}");
        // 遠處不受影響
        assert_eq!(img.get_pixel(100, 2)[0], 255);
    }

    #[test]
    fn restore_undoes_push() {
        let mut f = Field::new(100, 100);
        f.apply_stroke(&Stroke { m: 0, r: 0.2, s: 1.0, p: vec![[0.5, 0.5], [0.6, 0.5]] });
        let before = f.sample(0.55, 0.5).0.abs();
        for _ in 0..30 {
            f.apply_stroke(&Stroke { m: 3, r: 0.4, s: 1.0, p: vec![[0.5, 0.5]] });
        }
        assert!(f.sample(0.55, 0.5).0.abs() < before * 0.05);
    }
}
