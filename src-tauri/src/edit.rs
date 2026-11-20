//! 簡易照片調整（仿 Camera Raw「基本」面板）：白平衡、曝光、對比、亮部、陰影、白色、黑色、
//! 自然飽和度、飽和度、HSL（8 個色相區段的色相 / 飽和度 / 明亮度），以及點曲線（RGB）。
//!
//! - 非破壞性：設定存在 XMP（自訂命名空間 sd:），原始影像不動；RAW 寫附屬檔、JPEG 寫檔案內嵌 XMP，
//!   RAW+JPEG 兩邊都寫（與評等相同）。
//! - 縮圖、預覽、100% 檢視與影像轉存都會套用。
//! - 前端調整時用 WebGL 即時預覽，公式與這裡一模一樣（src/editor.ts 的 shader）；改公式時兩邊要一起改。

use crate::scan::{Class, Item};
use crate::xmp;
use image::{DynamicImage, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Params {
    /// 色溫 −100…100（負 = 偏藍、正 = 偏黃）
    pub temp: f32,
    /// 色調 −100…100（負 = 偏綠、正 = 偏洋紅）
    pub tint: f32,
    /// 曝光 −5…+5 EV
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub vibrance: f32,
    pub saturation: f32,
    /// 點曲線（RGB，0–255 的 [輸入, 輸出]，依輸入排序）。空的 = 不套用
    #[serde(default)]
    pub curve: Vec<[f32; 2]>,
    /// HSL（8 個色相區段 × 色相 / 飽和度 / 明亮度，各 −100…100），順序：色相 8 格、飽和度 8 格、明亮度 8 格。
    /// 區段依序為紅、橙、黃、綠、水綠、藍、紫、洋紅。空的 = 不套用
    #[serde(default)]
    pub hsl: Vec<f32>,
    /// 裁切：[中心 x, 中心 y, 寬, 高, 角度]。中心與寬高是相對於（轉正後）原圖寬高的比例 0–1，
    /// 角度 −45…45 度（正 = 照片順時針轉）。空的 = 不裁切
    #[serde(default)]
    pub crop: Vec<f32>,
    /// 局部修補（移除 / 修復 / 仿製），依序套用
    #[serde(default)]
    pub spots: Vec<crate::heal::Spot>,
}

/// 整理裁切：5 個數字、數值合理；等於整張不裁切時回傳空的
pub fn clean_crop(c: &[f32]) -> Vec<f32> {
    if c.len() != 5 || c.iter().any(|x| !x.is_finite()) {
        return Vec::new();
    }
    let v = vec![
        c[0].clamp(0.0, 1.0),
        c[1].clamp(0.0, 1.0),
        c[2].clamp(0.001, 1.0),
        c[3].clamp(0.001, 1.0),
        c[4].clamp(-45.0, 45.0),
    ];
    let full = v[2] > 0.9995 && v[3] > 0.9995 && v[4].abs() < 0.005 && (v[0] - 0.5).abs() < 0.0005 && (v[1] - 0.5).abs() < 0.0005;
    if full {
        Vec::new()
    } else {
        v
    }
}

/// 裁切框（像素）：中心、寬高、角度（度）。與 editor.ts 的 Crop 相同
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CropPx {
    pub cx: f32,
    pub cy: f32,
    pub w: f32,
    pub h: f32,
    pub a: f32,
}

impl CropPx {
    pub fn from_norm(c: &[f32], w: f32, h: f32) -> Self {
        CropPx { cx: c[0] * w, cy: c[1] * h, w: c[2] * w, h: c[3] * h, a: c[4] }
    }

    /// 裁切框內的位移 d（以裁切框中心為原點，x 向右、y 向下）→ 原圖座標
    pub fn to_img(&self, dx: f32, dy: f32) -> (f32, f32) {
        let (s, c) = self.a.to_radians().sin_cos();
        (self.cx + c * dx + s * dy, self.cy - s * dx + c * dy)
    }

    /// 四個角都在原圖範圍內
    pub fn fits(&self, iw: f32, ih: f32) -> bool {
        let e = 0.01;
        [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)].iter().all(|(sx, sy)| {
            let (x, y) = self.to_img(sx * self.w / 2.0, sy * self.h / 2.0);
            x >= -e && x <= iw + e && y >= -e && y <= ih + e
        })
    }

    /// 超出原圖時（例如同步到比例不同的照片）以中心縮小到剛好放得下；與 editor.ts fitCrop 相同
    pub fn fitted(mut self, iw: f32, ih: f32) -> Self {
        self.cx = self.cx.clamp(0.0, iw);
        self.cy = self.cy.clamp(0.0, ih);
        if self.fits(iw, ih) {
            return self;
        }
        let (mut lo, mut hi) = (0f32, 1f32);
        for _ in 0..30 {
            let mid = (lo + hi) / 2.0;
            if (CropPx { w: self.w * mid, h: self.h * mid, ..self }).fits(iw, ih) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        CropPx { w: self.w * lo, h: self.h * lo, ..self }
    }
}

/// 裁切（含旋轉）。角度為 0 時直接切；有角度時雙線性取樣
pub fn crop_rgb(img: &RgbImage, crop: &[f32]) -> RgbImage {
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    let c = CropPx::from_norm(crop, iw, ih).fitted(iw, ih);
    let ow = (c.w.round() as u32).max(1);
    let oh = (c.h.round() as u32).max(1);
    if c.a.abs() < 0.005 {
        let x = ((c.cx - c.w / 2.0).round().max(0.0) as u32).min(img.width() - 1);
        let y = ((c.cy - c.h / 2.0).round().max(0.0) as u32).min(img.height() - 1);
        let ow = ow.min(img.width() - x);
        let oh = oh.min(img.height() - y);
        return image::imageops::crop_imm(img, x, y, ow, oh).to_image();
    }
    let mut out = RgbImage::new(ow, oh);
    let src = img.as_raw();
    let (w, h) = (img.width() as usize, img.height() as usize);
    let px = |x: usize, y: usize, k: usize| src[(y * w + x) * 3 + k] as f32;
    out.as_mut().par_chunks_mut(ow as usize * 3).enumerate().for_each(|(oy, row)| {
        for ox in 0..ow as usize {
            let dx = (ox as f32 + 0.5) / ow as f32 * c.w - c.w / 2.0;
            let dy = (oy as f32 + 0.5) / oh as f32 * c.h - c.h / 2.0;
            let (x, y) = c.to_img(dx, dy);
            let fx = (x - 0.5).clamp(0.0, (w - 1) as f32);
            let fy = (y - 0.5).clamp(0.0, (h - 1) as f32);
            let x0 = fx.floor() as usize;
            let y0 = fy.floor() as usize;
            let x1 = (x0 + 1).min(w - 1);
            let y1 = (y0 + 1).min(h - 1);
            let tx = fx - x0 as f32;
            let ty = fy - y0 as f32;
            for k in 0..3 {
                let top = px(x0, y0, k) * (1.0 - tx) + px(x1, y0, k) * tx;
                let bot = px(x0, y1, k) * (1.0 - tx) + px(x1, y1, k) * tx;
                row[ox * 3 + k] = (top * (1.0 - ty) + bot * ty + 0.5) as u8;
            }
        }
    });
    out
}

/// 旋轉 90° 後裁切框跟著轉（順時針：新中心 = (1 − cy, cx)、寬高對調；角度不變）
pub fn rotate_crop(c: &[f32], clockwise: bool) -> Vec<f32> {
    if c.len() != 5 {
        return Vec::new();
    }
    if clockwise {
        vec![1.0 - c[1], c[0], c[3], c[2], c[4]]
    } else {
        vec![c[1], 1.0 - c[0], c[3], c[2], c[4]]
    }
}

pub const HSL_LEN: usize = 24;
/// HSL 各區段的中心色相（度），最後一格 360 = 回到紅色
const HUE_CENTERS: [f32; 9] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0];

/// 整理 HSL：補滿 24 格、限制在 ±100；全部為 0 回傳空的
pub fn clean_hsl(h: &[f32]) -> Vec<f32> {
    let mut v = vec![0f32; HSL_LEN];
    for (i, x) in h.iter().take(HSL_LEN).enumerate() {
        v[i] = if x.is_finite() { x.clamp(-100.0, 100.0) } else { 0.0 };
    }
    if v.iter().all(|x| x.abs() < 1e-4) {
        Vec::new()
    } else {
        v
    }
}

/// 曲線最多幾個點（與前端相同）
const MAX_CURVE_POINTS: usize = 16;

/// 整理曲線：數值限制在 0–255、依輸入排序、去掉重複；直線（沒有作用）回傳空的
pub fn clean_curve(c: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let mut v: Vec<[f32; 2]> = c
        .iter()
        .filter(|p| p[0].is_finite() && p[1].is_finite())
        .map(|p| [p[0].clamp(0.0, 255.0).round(), p[1].clamp(0.0, 255.0).round()])
        .collect();
    v.sort_by(|a, b| a[0].total_cmp(&b[0]));
    v.dedup_by(|b, a| a[0] == b[0]);
    v.truncate(MAX_CURVE_POINTS);
    if v.len() < 2 || v.iter().all(|p| (p[0] - p[1]).abs() < 0.5) && v[0][0] == 0.0 && v[v.len() - 1][0] == 255.0 {
        return vec![];
    }
    v
}

/// 由曲線控制點算出 256 格查表（單調三次插值 Fritsch–Carlson；前端 editor.ts 用同一個演算法）
pub fn curve_lut(c: &[[f32; 2]]) -> Option<[f32; 256]> {
    if c.len() < 2 {
        return None;
    }
    let n = c.len();
    let xs: Vec<f32> = c.iter().map(|p| p[0]).collect();
    let ys: Vec<f32> = c.iter().map(|p| p[1]).collect();
    let mut d = vec![0f32; n - 1];
    for i in 0..n - 1 {
        d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    }
    let mut m = vec![0f32; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        m[i] = if d[i - 1] * d[i] <= 0.0 { 0.0 } else { (d[i - 1] + d[i]) / 2.0 };
    }
    for i in 0..n - 1 {
        if d[i] == 0.0 {
            m[i] = 0.0;
            m[i + 1] = 0.0;
        } else {
            let a = m[i] / d[i];
            let b = m[i + 1] / d[i];
            let h = a * a + b * b;
            if h > 9.0 {
                let t = 3.0 / h.sqrt();
                m[i] = t * a * d[i];
                m[i + 1] = t * b * d[i];
            }
        }
    }
    let mut lut = [0f32; 256];
    let mut k = 0;
    for (x, out) in lut.iter_mut().enumerate() {
        let x = x as f32;
        let y = if x <= xs[0] {
            ys[0]
        } else if x >= xs[n - 1] {
            ys[n - 1]
        } else {
            while k < n - 2 && x > xs[k + 1] {
                k += 1;
            }
            let h = xs[k + 1] - xs[k];
            let t = (x - xs[k]) / h;
            let (t2, t3) = (t * t, t * t * t);
            (2.0 * t3 - 3.0 * t2 + 1.0) * ys[k] + (t3 - 2.0 * t2 + t) * h * m[k] + (-2.0 * t3 + 3.0 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1]
        };
        *out = (y / 255.0).clamp(0.0, 1.0);
    }
    Some(lut)
}

fn lut_apply(lut: &[f32; 256], v: f32) -> f32 {
    let x = v.clamp(0.0, 1.0) * 255.0;
    let i = (x.floor() as usize).min(254);
    let f = x - i as f32;
    lut[i] * (1.0 - f) + lut[i + 1] * f
}

/// XMP 屬性名，順序與 Params::values() 相同
const FIELDS: [&str; 10] = [
    "sd:Temperature",
    "sd:Tint",
    "sd:Exposure",
    "sd:Contrast",
    "sd:Highlights",
    "sd:Shadows",
    "sd:Whites",
    "sd:Blacks",
    "sd:Vibrance",
    "sd:Saturation",
];

impl Params {
    fn values(&self) -> [f32; 10] {
        [
            self.temp,
            self.tint,
            self.exposure,
            self.contrast,
            self.highlights,
            self.shadows,
            self.whites,
            self.blacks,
            self.vibrance,
            self.saturation,
        ]
    }

    fn from_values(v: [f32; 10], curve: Vec<[f32; 2]>, hsl: Vec<f32>, crop: Vec<f32>, spots: Vec<crate::heal::Spot>) -> Self {
        Params {
            spots,
            curve,
            hsl,
            crop,
            temp: v[0],
            tint: v[1],
            exposure: v[2],
            contrast: v[3],
            highlights: v[4],
            shadows: v[5],
            whites: v[6],
            blacks: v[7],
            vibrance: v[8],
            saturation: v[9],
        }
    }

    /// 把數值限制在合理範圍（也擋掉 NaN），曲線整理過
    pub fn clamped(&self) -> Self {
        let mut v = self.values();
        for (i, x) in v.iter_mut().enumerate() {
            let lim = if i == 2 { 5.0 } else { 100.0 };
            *x = if x.is_finite() { x.clamp(-lim, lim) } else { 0.0 };
        }
        Params::from_values(v, clean_curve(&self.curve), clean_hsl(&self.hsl), clean_crop(&self.crop), crate::heal::clean_spots(&self.spots))
    }

    /// 欄位名稱（與前端 / serde 相同），順序與 values() 相同
    pub const KEYS: [&'static str; 14] = [
        "temp", "tint", "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation", "curve", "hsl", "crop",
        "spots",
    ];

    /// 只把 `fields` 列出的項目換成 `src` 的值，其餘保留自己的
    pub fn merged(&self, src: &Params, fields: &[String]) -> Params {
        let mut v = self.values();
        let s = src.values();
        for (i, k) in Self::KEYS.iter().take(10).enumerate() {
            if fields.iter().any(|f| f == k) {
                v[i] = s[i];
            }
        }
        let has = |k: &str| fields.iter().any(|f| f == k);
        let curve = if has("curve") { src.curve.clone() } else { self.curve.clone() };
        let hsl = if has("hsl") { src.hsl.clone() } else { self.hsl.clone() };
        let crop = if has("crop") { src.crop.clone() } else { self.crop.clone() };
        let spots = if has("spots") { src.spots.clone() } else { self.spots.clone() };
        Params::from_values(v, curve, hsl, crop, spots).clamped()
    }

    pub fn is_identity(&self) -> bool {
        self.is_color_identity() && clean_crop(&self.crop).is_empty() && self.spots.is_empty()
    }

    /// 只看色彩相關的項目（不含裁切）
    pub fn is_color_identity(&self) -> bool {
        self.values().iter().all(|v| v.abs() < 1e-4) && clean_curve(&self.curve).is_empty() && clean_hsl(&self.hsl).is_empty()
    }

    /// 要寫進 XMP 的屬性（0 的項目移除；全部 0 時連 sd:Version 一起移除）
    pub fn xmp_props(&self) -> Vec<(&'static str, Option<String>)> {
        let p = self.clamped();
        let mut out: Vec<(&'static str, Option<String>)> = FIELDS
            .iter()
            .zip(p.values())
            .map(|(k, v)| (*k, (v.abs() >= 1e-4).then(|| format!("{}", (v * 100.0).round() / 100.0))))
            .collect();
        let curve = (!p.curve.is_empty())
            .then(|| p.curve.iter().map(|q| format!("{},{}", q[0], q[1])).collect::<Vec<_>>().join(";"));
        out.push(("sd:ToneCurve", curve));
        let hsl = (!p.hsl.is_empty())
            .then(|| p.hsl.iter().map(|v| format!("{}", (v * 100.0).round() / 100.0)).collect::<Vec<_>>().join(","));
        out.push(("sd:HSL", hsl));
        let crop = (!p.crop.is_empty())
            .then(|| p.crop.iter().map(|v| format!("{}", (v * 100000.0).round() / 100000.0)).collect::<Vec<_>>().join(","));
        out.push(("sd:Crop", crop));
        out.push(("sd:Spots", (!p.spots.is_empty()).then(|| crate::heal::to_text(&p.spots))));
        out.push(("sd:Version", (!p.is_identity()).then(|| "1".to_string())));
        out
    }

    pub fn from_xmp(xml: &str) -> Option<Self> {
        xmp::get_prop(xml, "sd:Version")?;
        let mut v = [0f32; 10];
        for (i, k) in FIELDS.iter().enumerate() {
            v[i] = xmp::get_prop(xml, k).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        }
        let curve: Vec<[f32; 2]> = xmp::get_prop(xml, "sd:ToneCurve")
            .map(|s| {
                s.split(';')
                    .filter_map(|pt| {
                        let (a, b) = pt.split_once(',')?;
                        Some([a.trim().parse().ok()?, b.trim().parse().ok()?])
                    })
                    .collect()
            })
            .unwrap_or_default();
        let hsl: Vec<f32> = xmp::get_prop(xml, "sd:HSL")
            .map(|s| s.split(',').map(|x| x.trim().parse().unwrap_or(0.0)).collect())
            .unwrap_or_default();
        let crop: Vec<f32> = xmp::get_prop(xml, "sd:Crop")
            .map(|s| s.split(',').map(|x| x.trim().parse().unwrap_or(f32::NAN)).collect())
            .unwrap_or_default();
        let spots = xmp::get_prop(xml, "sd:Spots").map(|t| crate::heal::from_text(&t)).unwrap_or_default();
        let p = Params::from_values(v, curve, hsl, crop, spots).clamped();
        (!p.is_identity()).then_some(p)
    }
}

/// 讀取一個項目目前的調整（沒有 = None）。讀取順序與寫入一致：顯示用的檔案是 JPEG 就讀它內嵌的 XMP，否則讀附屬檔
pub fn load(item: &Item) -> Option<Params> {
    let f = item.display();
    let xml = if f.class == Class::Jpeg {
        xmp::read_jpeg_xml(&f.path)
    } else {
        std::fs::read_to_string(item.sidecar_path()).ok()
    }?;
    Params::from_xmp(&xml)
}

// ---------------------------------------------------------------- 公式（與 editor.ts shader 相同）

const LUM: [f32; 3] = [0.2126, 0.7152, 0.0722];

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(c: f32) -> f32 {
    let c = c.clamp(0.0, 1.0);
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// 白平衡增益（已正規化，亮度不變）
fn wb_gains(p: &Params) -> [f32; 3] {
    let k = p.temp / 100.0;
    let t = p.tint / 100.0;
    // 色溫：中間段與原本相近，兩端加大（±100 時紅藍各 ±0.75 EV，可修正鎢絲燈等強烈色偏）
    let kk = 0.35 * k + 0.4 * k * k * k;
    let g = [(kk + 0.1 * t).exp2(), (-0.2 * t).exp2(), (-kk + 0.1 * t).exp2()];
    let l = g[0] * LUM[0] + g[1] * LUM[1] + g[2] * LUM[2];
    [g[0] / l, g[1] / l, g[2] / l]
}

/// 亮度（線性）→ 調整後的亮度。在感知空間（約 gamma 2.2）裡做黑白點、陰影、亮部、對比
pub fn tone(l: f32, p: &Params) -> f32 {
    let (c, h, s, w, b) = (p.contrast / 100.0, p.highlights / 100.0, p.shadows / 100.0, p.whites / 100.0, p.blacks / 100.0);
    let mut v = l.max(0.0).powf(1.0 / 2.2);
    // 白色 / 黑色：移動白點與黑點
    let lo = -0.08 * b;
    let hi = 1.0 - 0.15 * w;
    v = (v - lo) / (hi - lo);
    // 陰影：只影響暗部（最黑處不動）
    let ws = smoothstep(0.0, 0.15, v) * (1.0 - smoothstep(0.15, 0.65, v));
    v += 0.2 * s * ws;
    // 亮部：影響亮部，負值可以把超過 1 的部分拉回來
    let wh = smoothstep(0.45, 0.85, v);
    v += 0.25 * h * wh;
    // 對比：以中間調為中心的 S 曲線（|c| ≤ 1 時保持單調）
    let q = v.clamp(0.0, 1.0);
    v -= c * 0.8 * (std::f32::consts::TAU * q).sin() / std::f32::consts::TAU;
    v.max(0.0).powf(2.2)
}

/// 調整一個像素（輸入輸出都是 0–1 的 sRGB 編碼值）
pub fn pixel(rgb: [f32; 3], p: &Params, gains: &[f32; 3], lut: Option<&[f32; 256]>) -> [f32; 3] {
    let ev = p.exposure.exp2();
    let mut c = [0f32; 3];
    for i in 0..3 {
        c[i] = srgb_to_linear(rgb[i]) * gains[i] * ev;
    }
    let l = c[0] * LUM[0] + c[1] * LUM[1] + c[2] * LUM[2];
    let l2 = tone(l, p);
    let ratio = if l > 1e-6 { l2 / l } else { 0.0 };
    for x in c.iter_mut() {
        *x = if l > 1e-6 { *x * ratio } else { l2 };
    }
    // 飽和度 / 自然飽和度（自然飽和度對原本就飽和的顏色作用較小）
    let y = c[0] * LUM[0] + c[1] * LUM[1] + c[2] * LUM[2];
    let mx = c[0].max(c[1]).max(c[2]);
    let mn = c[0].min(c[1]).min(c[2]);
    let s0 = if mx > 1e-6 { (mx - mn) / mx } else { 0.0 };
    let k = (1.0 + p.saturation / 100.0) * (1.0 + p.vibrance / 100.0 * (1.0 - s0));
    let mut out = [0f32; 3];
    for i in 0..3 {
        out[i] = linear_to_srgb((y + (c[i] - y) * k).max(0.0));
    }
    // HSL：在 sRGB 數值上依色相區段調整
    if p.hsl.len() == HSL_LEN {
        out = hsl_adjust(out, &p.hsl);
    }
    // 點曲線：在顯示用的 sRGB 數值上套用（與 Camera Raw / Photoshop 的 RGB 曲線相同）
    if let Some(l) = lut {
        for v in out.iter_mut() {
            *v = lut_apply(l, *v);
        }
    }
    out
}

/// HSL 調整（輸入輸出 0–1 的 sRGB 數值；與 editor.ts shader 的 hslAdjust 相同）。
/// 色相落在兩個區段中心之間時，兩邊的設定依距離線性混合；灰色（沒有彩度）不受影響。
fn hsl_adjust(o: [f32; 3], h: &[f32]) -> [f32; 3] {
    let mx = o[0].max(o[1]).max(o[2]);
    let mn = o[0].min(o[1]).min(o[2]);
    let c = mx - mn;
    if c < 1e-5 || mx < 1e-6 {
        return o;
    }
    let mut hue = if mx == o[0] {
        60.0 * ((o[1] - o[2]) / c)
    } else if mx == o[1] {
        60.0 * ((o[2] - o[0]) / c + 2.0)
    } else {
        60.0 * ((o[0] - o[1]) / c + 4.0)
    };
    if hue < 0.0 {
        hue += 360.0;
    }
    let mut i = 0;
    while i < 7 && hue >= HUE_CENTERS[i + 1] {
        i += 1;
    }
    let t = ((hue - HUE_CENTERS[i]) / (HUE_CENTERS[i + 1] - HUE_CENTERS[i])).clamp(0.0, 1.0);
    let j = (i + 1) % 8;
    let mix = |a: f32, b: f32| (a + (b - a) * t) / 100.0;
    let dh = mix(h[i], h[j]);
    let ds = mix(h[8 + i], h[8 + j]);
    let dl = mix(h[16 + i], h[16 + j]);
    let sv = c / mx;
    // 色相：最多 ±30°；飽和度：−100 = 去色、+100 = 兩倍；明亮度：正值往白、負值往黑（依彩度加權）
    let s2 = (sv * (1.0 + ds)).clamp(0.0, 1.0);
    let mut rgb = hsv_to_rgb(hue + dh * 30.0, s2, mx);
    let a = dl * sv * 0.5;
    for v in rgb.iter_mut() {
        *v = if a >= 0.0 { *v + (1.0 - *v) * a } else { *v * (1.0 + a) };
    }
    rgb
}

fn hsv_to_rgb(hue: f32, s: f32, v: f32) -> [f32; 3] {
    let h = hue.rem_euclid(360.0) / 60.0;
    let i = h.floor().min(5.0);
    let f = h - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match i as i32 {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

/// 修補一律在長邊約 2560（與調整視窗相同）的解析度計算：內容感知合成與解析度有關，
/// 原尺寸較大時先縮小計算，再把「修補前後的差」放大加回原圖，結果與調整視窗看到的一致
fn apply_spots_ref(rgb: &mut RgbImage, spots: &[crate::heal::Spot]) {
    const REF: u32 = crate::render::PREVIEW_EDGE;
    let (w, h) = rgb.dimensions();
    let long = w.max(h);
    if long <= REF + REF / 20 {
        crate::heal::apply_spots(rgb, spots);
        return;
    }
    let sw = ((w as u64 * REF as u64) / long as u64).max(1) as u32;
    let sh = ((h as u64 * REF as u64) / long as u64).max(1) as u32;
    let small = image::imageops::thumbnail(rgb, sw, sh);
    let mut healed = small.clone();
    crate::heal::apply_spots(&mut healed, spots);
    // 差值（只有修補範圍不為 0）
    let diff: Vec<f32> = healed.as_raw().iter().zip(small.as_raw()).map(|(a, b)| *a as f32 - *b as f32).collect();
    let (swu, shu) = (sw as usize, sh as usize);
    let at = |x: usize, y: usize, k: usize| diff[(y * swu + x) * 3 + k];
    let wu = w as usize;
    rgb.as_mut().par_chunks_mut(wu * 3).enumerate().for_each(|(y, row)| {
        let fy = ((y as f32 + 0.5) * sh as f32 / h as f32 - 0.5).clamp(0.0, (shu - 1) as f32);
        let y0 = fy.floor() as usize;
        let y1 = (y0 + 1).min(shu - 1);
        let ty = fy - y0 as f32;
        for x in 0..wu {
            let fx = ((x as f32 + 0.5) * sw as f32 / w as f32 - 0.5).clamp(0.0, (swu - 1) as f32);
            let x0 = fx.floor() as usize;
            let x1 = (x0 + 1).min(swu - 1);
            let tx = fx - x0 as f32;
            for k in 0..3 {
                let a = at(x0, y0, k) * (1.0 - tx) + at(x1, y0, k) * tx;
                let b = at(x0, y1, k) * (1.0 - tx) + at(x1, y1, k) * tx;
                let d = a * (1.0 - ty) + b * ty;
                if d.abs() < 0.01 {
                    continue;
                }
                let v = row[x * 3 + k] as f32 + d;
                row[x * 3 + k] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    });
}

/// 套用到整張影像（rayon 逐列平行處理）
pub fn apply_rgb(img: &mut RgbImage, p: &Params) {
    if p.is_color_identity() {
        return;
    }
    let p = p.clamped();
    let gains = wb_gains(&p);
    let lut = curve_lut(&p.curve);
    let w = img.width() as usize;
    img.as_mut()
        .par_chunks_mut(w * 3)
        .for_each(|row| {
            for px in row.chunks_exact_mut(3) {
                let o = pixel([px[0] as f32 / 255.0, px[1] as f32 / 255.0, px[2] as f32 / 255.0], &p, &gains, lut.as_ref());
                px[0] = (o[0] * 255.0 + 0.5) as u8;
                px[1] = (o[1] * 255.0 + 0.5) as u8;
                px[2] = (o[2] * 255.0 + 0.5) as u8;
            }
        });
}

pub fn apply(img: DynamicImage, p: &Params) -> DynamicImage {
    if p.is_identity() {
        return img;
    }
    let mut rgb = img.to_rgb8();
    // 修補在最前面（作用在原圖上，與 Camera Raw 相同）
    if !p.spots.is_empty() {
        apply_spots_ref(&mut rgb, &p.spots);
    }
    // 再裁切（像素少、算得快；與畫面預覽相同：先取樣再調色）
    let crop = clean_crop(&p.crop);
    if !crop.is_empty() {
        rgb = crop_rgb(&rgb, &crop);
    }
    apply_rgb(&mut rgb, p);
    DynamicImage::ImageRgb8(rgb)
}

/// 有調整就套用（給縮圖、預覽、轉存用）
pub fn apply_item(item: &Item, img: DynamicImage) -> DynamicImage {
    match load(item) {
        Some(p) => apply(img, &p),
        None => img,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_keeps_pixels() {
        let p = Params::default();
        let g = wb_gains(&p);
        for v in [0u8, 1, 17, 64, 128, 200, 254, 255] {
            let x = v as f32 / 255.0;
            let o = pixel([x, x * 0.5, 1.0 - x], &p, &g, None);
            assert!((o[0] * 255.0 - v as f32).abs() < 0.6, "{v} → {o:?}");
        }
        // 單純 tone 也要恆等
        for i in 0..=20 {
            let l = i as f32 / 20.0;
            assert!((tone(l, &p) - l).abs() < 1e-3);
        }
    }

    #[test]
    fn exposure_brightens_and_darkens() {
        let mut p = Params::default();
        let g = wb_gains(&p);
        let base = pixel([0.4, 0.4, 0.4], &p, &g, None)[0];
        p.exposure = 1.0;
        assert!(pixel([0.4, 0.4, 0.4], &p, &g, None)[0] > base + 0.1);
        p.exposure = -1.0;
        assert!(pixel([0.4, 0.4, 0.4], &p, &g, None)[0] < base - 0.1);
    }

    #[test]
    fn tone_controls_are_monotonic() {
        for (field, amt) in [(3, 100.0), (3, -100.0), (4, -100.0), (4, 100.0), (5, 100.0), (5, -100.0), (6, 100.0), (7, -100.0)] {
            let mut v = [0f32; 10];
            v[field] = amt;
            let p = Params::from_values(v, vec![], vec![], vec![], vec![]);
            let mut prev = -1.0;
            for i in 0..=200 {
                let y = tone(i as f32 / 200.0, &p);
                assert!(y >= prev - 1e-4, "field {field} amt {amt} not monotonic at {i}");
                prev = y;
            }
        }
    }

    #[test]
    fn warm_temperature_adds_yellow() {
        let p = Params { temp: 50.0, ..Default::default() };
        let o = pixel([0.5, 0.5, 0.5], &p, &wb_gains(&p), None);
        assert!(o[0] > o[2]);
    }

    #[test]
    fn saturation_zero_is_gray() {
        let p = Params { saturation: -100.0, ..Default::default() };
        let o = pixel([0.8, 0.3, 0.1], &p, &wb_gains(&p), None);
        assert!((o[0] - o[1]).abs() < 1e-3 && (o[1] - o[2]).abs() < 1e-3);
    }

    #[test]
    fn xmp_roundtrip() {
        let p = Params { exposure: 0.75, contrast: 20.0, shadows: -35.5, temp: 12.0, ..Default::default() };
        let mut xml = String::from("<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=\"\"/></rdf:RDF></x:xmpmeta>");
        for (k, v) in p.xmp_props() {
            crate::xmp::test_set_prop(&mut xml, k, v.as_deref());
        }
        assert_eq!(Params::from_xmp(&xml), Some(p));
        // 全部歸零 → 視為沒有調整
        for (k, v) in Params::default().xmp_props() {
            crate::xmp::test_set_prop(&mut xml, k, v.as_deref());
        }
        assert_eq!(Params::from_xmp(&xml), None);
        assert!(!xml.contains("sd:"));
    }

    #[test]
    fn merge_only_selected_fields() {
        let mine = Params { exposure: -1.0, contrast: 40.0, temp: 5.0, ..Default::default() };
        let src = Params { exposure: 1.5, contrast: 0.0, saturation: 20.0, ..Default::default() };
        let m = mine.merged(&src, &["exposure".into(), "saturation".into()]);
        assert_eq!(m.exposure, 1.5);
        assert_eq!(m.saturation, 20.0);
        assert_eq!(m.contrast, 40.0); // 沒勾的保留
        assert_eq!(m.temp, 5.0);
        // 全勾 = 完全一樣
        let all: Vec<String> = Params::KEYS.iter().map(|k| k.to_string()).collect();
        assert_eq!(mine.merged(&src, &all), src.clamped());
    }

    #[test]
    fn curve_identity_and_lut() {
        assert!(clean_curve(&[[0.0, 0.0], [255.0, 255.0]]).is_empty());
        assert!(clean_curve(&[[0.0, 0.0], [128.0, 128.0], [255.0, 255.0]]).is_empty());
        let s = clean_curve(&[[255.0, 255.0], [0.0, 0.0], [64.0, 50.0], [192.0, 210.0]]);
        assert_eq!(s.len(), 4);
        assert_eq!(s[1], [64.0, 50.0]); // 已排序
        let lut = curve_lut(&s).unwrap();
        assert!((lut[0] - 0.0).abs() < 1e-6 && (lut[255] - 1.0).abs() < 1e-6);
        assert!((lut[64] * 255.0 - 50.0).abs() < 0.01);
        assert!((lut[192] * 255.0 - 210.0).abs() < 0.01);
        for i in 1..256 {
            assert!(lut[i] >= lut[i - 1] - 1e-6, "S 曲線要單調");
        }
        // 曲線會改變像素；沒有其他調整時，曲線以外完全不動
        let p = Params { curve: s.clone(), ..Default::default() };
        assert!(!p.is_identity());
        let o = pixel([64.0 / 255.0; 3], &p, &wb_gains(&p), Some(&lut));
        assert!((o[0] * 255.0 - 50.0).abs() < 0.6);
    }

    #[test]
    fn curve_xmp_roundtrip_and_merge() {
        let p = Params { exposure: 0.5, curve: vec![[0.0, 10.0], [128.0, 140.0], [255.0, 245.0]], ..Default::default() };
        let mut xml = String::from("<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=\"\"/></rdf:RDF></x:xmpmeta>");
        for (k, v) in p.xmp_props() {
            crate::xmp::test_set_prop(&mut xml, k, v.as_deref());
        }
        assert!(xml.contains("sd:ToneCurve=\"0,10;128,140;255,245\""));
        assert_eq!(Params::from_xmp(&xml), Some(p.clone()));
        let other = Params { contrast: 30.0, ..Default::default() };
        let m = other.merged(&p, &["curve".into()]);
        assert_eq!(m.curve, p.curve);
        assert_eq!(m.contrast, 30.0);
        assert_eq!(m.exposure, 0.0);
    }

    #[test]
    fn hsl_bands() {
        let gray = [0.5, 0.5, 0.5];
        let mut h = vec![0f32; HSL_LEN];
        // 全部 0 = 不變（HSV 來回轉換）
        for c in [[0.8, 0.2, 0.1], [0.1, 0.6, 0.9], [0.3, 0.9, 0.2]] {
            let o = hsl_adjust(c, &h);
            for k in 0..3 {
                assert!((o[k] - c[k]).abs() < 1e-5);
            }
        }
        // 藍色飽和度 −100：藍色變灰、紅色不變、灰色不變
        h[8 + 5] = -100.0;
        let b = hsl_adjust([0.1, 0.1, 0.9], &h);
        assert!((b[0] - b[2]).abs() < 1e-4 && (b[1] - b[2]).abs() < 1e-4);
        let r = hsl_adjust([0.9, 0.1, 0.1], &h);
        assert!((r[0] - 0.9).abs() < 1e-5 && (r[1] - 0.1).abs() < 1e-5 && (r[2] - 0.1).abs() < 1e-5);
        assert_eq!(hsl_adjust(gray, &h), gray);
        // 藍色明亮度 −100：變暗
        let mut h = vec![0f32; HSL_LEN];
        h[16 + 5] = -100.0;
        let d = hsl_adjust([0.1, 0.1, 0.9], &h);
        assert!(d[2] < 0.6);
        // 紅色色相 +100：往橙色（綠色分量增加）
        let mut h = vec![0f32; HSL_LEN];
        h[0] = 100.0;
        let r = hsl_adjust([0.9, 0.1, 0.1], &h);
        assert!(r[1] > 0.3 && r[2] < 0.15);
        // 紅色色相 −100：往洋紅（藍色分量增加）
        h[0] = -100.0;
        let r = hsl_adjust([0.9, 0.1, 0.1], &h);
        assert!(r[2] > 0.3);
    }

    #[test]
    fn hsl_xmp_roundtrip_and_merge() {
        let mut hsl = vec![0f32; HSL_LEN];
        hsl[5] = 20.0;
        hsl[13] = -35.5;
        let p = Params { hsl: hsl.clone(), ..Default::default() };
        assert!(!p.is_identity());
        let mut xml = String::from("<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=\"\"/></rdf:RDF></x:xmpmeta>");
        for (k, v) in p.xmp_props() {
            crate::xmp::test_set_prop(&mut xml, k, v.as_deref());
        }
        let back = Params::from_xmp(&xml).unwrap();
        assert_eq!(back.hsl, hsl);
        let other = Params { exposure: 1.0, ..Default::default() };
        let m = other.merged(&p, &["hsl".into()]);
        assert_eq!(m.hsl, hsl);
        assert_eq!(m.exposure, 1.0);
        let m = other.merged(&p, &["exposure".into()]);
        assert!(m.hsl.is_empty());
        // 全部 0 = 空的
        assert!(Params { hsl: vec![0.0; HSL_LEN], ..Default::default() }.clamped().hsl.is_empty());
    }

    #[test]
    fn crop_basic_and_rotated() {
        let img = RgbImage::from_fn(200, 100, |x, y| image::Rgb([x as u8, y as u8, 0]));
        // 右半邊
        let c = crop_rgb(&img, &[0.75, 0.5, 0.5, 1.0, 0.0]);
        assert_eq!((c.width(), c.height()), (100, 100));
        assert_eq!(c.get_pixel(0, 0)[0], 100);
        // 旋轉 10°：輸出大小照設定，中心像素不變
        let c = crop_rgb(&img, &[0.5, 0.5, 0.4, 0.4, 10.0]);
        assert_eq!((c.width(), c.height()), (80, 40));
        let m = c.get_pixel(40, 20);
        assert!((m[0] as i32 - 100).abs() <= 2 && (m[1] as i32 - 50).abs() <= 2, "{m:?}");
        // 正角度 = 照片順時針轉：裁切框往右的方向對應原圖往右上
        let k = CropPx { cx: 100.0, cy: 50.0, w: 10.0, h: 10.0, a: 10.0 };
        let (x, y) = k.to_img(10.0, 0.0);
        assert!(x > 100.0 && y < 50.0);
        // 太大的框（同步自比例不同的照片）縮到放得下
        let f = CropPx { cx: 100.0, cy: 50.0, w: 200.0, h: 100.0, a: 20.0 }.fitted(200.0, 100.0);
        assert!(f.fits(200.0, 100.0) && f.w < 200.0 && (f.w / f.h - 2.0).abs() < 1e-3);
    }

    #[test]
    fn crop_xmp_merge_rotate() {
        assert!(clean_crop(&[0.5, 0.5, 1.0, 1.0, 0.0]).is_empty());
        let p = Params { crop: vec![0.4, 0.6, 0.5, 0.3, -5.5], ..Default::default() };
        assert!(!p.is_identity() && p.is_color_identity());
        let mut xml = String::from("<x:xmpmeta><rdf:RDF><rdf:Description rdf:about=\"\"/></rdf:RDF></x:xmpmeta>");
        for (k, v) in p.xmp_props() {
            crate::xmp::test_set_prop(&mut xml, k, v.as_deref());
        }
        let back = Params::from_xmp(&xml).unwrap();
        assert_eq!(back.crop, p.crop);
        let m = Params { exposure: 1.0, ..Default::default() }.merged(&p, &["crop".into()]);
        assert_eq!(m.crop, p.crop);
        assert_eq!(m.exposure, 1.0);
        // 轉四次回到原樣；順轉再逆轉也回到原樣
        let mut c = p.crop.clone();
        for _ in 0..4 {
            c = rotate_crop(&c, true);
        }
        for (a, b) in c.iter().zip(&p.crop) {
            assert!((a - b).abs() < 1e-6);
        }
        assert_eq!(rotate_crop(&rotate_crop(&p.crop, true), false), p.crop);
        // 只裁切（無調色）時，裁切範圍外的像素值不被改動
        let img = DynamicImage::ImageRgb8(RgbImage::from_fn(100, 100, |x, y| image::Rgb([x as u8, y as u8, 7])));
        let out = apply(img, &Params { crop: vec![0.25, 0.25, 0.5, 0.5, 0.0], ..Default::default() }).to_rgb8();
        assert_eq!((out.width(), out.height()), (50, 50));
        assert_eq!(out.get_pixel(10, 20), &image::Rgb([10, 20, 7]));
    }

    #[test]
    fn clamps_bad_values() {
        let p = Params { exposure: 99.0, contrast: f32::NAN, ..Default::default() }.clamped();
        assert_eq!(p.exposure, 5.0);
        assert_eq!(p.contrast, 0.0);
    }
}
