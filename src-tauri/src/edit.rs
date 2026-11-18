//! 簡易照片調整（仿 Camera Raw「基本」面板）：白平衡、曝光、對比、亮部、陰影、白色、黑色、
//! 自然飽和度、飽和度。
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq)]
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

    fn from_values(v: [f32; 10]) -> Self {
        Params {
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

    /// 把數值限制在合理範圍（也擋掉 NaN）
    pub fn clamped(self) -> Self {
        let mut v = self.values();
        for (i, x) in v.iter_mut().enumerate() {
            let lim = if i == 2 { 5.0 } else { 100.0 };
            *x = if x.is_finite() { x.clamp(-lim, lim) } else { 0.0 };
        }
        Params::from_values(v)
    }

    /// 欄位名稱（與前端 / serde 相同），順序與 values() 相同
    pub const KEYS: [&'static str; 10] =
        ["temp", "tint", "exposure", "contrast", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation"];

    /// 只把 `fields` 列出的項目換成 `src` 的值，其餘保留自己的
    pub fn merged(&self, src: &Params, fields: &[String]) -> Params {
        let mut v = self.values();
        let s = src.values();
        for (i, k) in Self::KEYS.iter().enumerate() {
            if fields.iter().any(|f| f == k) {
                v[i] = s[i];
            }
        }
        Params::from_values(v).clamped()
    }

    pub fn is_identity(&self) -> bool {
        self.values().iter().all(|v| v.abs() < 1e-4)
    }

    /// 要寫進 XMP 的屬性（0 的項目移除；全部 0 時連 sd:Version 一起移除）
    pub fn xmp_props(&self) -> Vec<(&'static str, Option<String>)> {
        let p = self.clamped();
        let mut out: Vec<(&'static str, Option<String>)> = FIELDS
            .iter()
            .zip(p.values())
            .map(|(k, v)| (*k, (v.abs() >= 1e-4).then(|| format!("{}", (v * 100.0).round() / 100.0))))
            .collect();
        out.push(("sd:Version", (!p.is_identity()).then(|| "1".to_string())));
        out
    }

    pub fn from_xmp(xml: &str) -> Option<Self> {
        xmp::get_prop(xml, "sd:Version")?;
        let mut v = [0f32; 10];
        for (i, k) in FIELDS.iter().enumerate() {
            v[i] = xmp::get_prop(xml, k).and_then(|s| s.parse().ok()).unwrap_or(0.0);
        }
        let p = Params::from_values(v).clamped();
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
    let g = [(0.35 * k + 0.1 * t).exp2(), (-0.2 * t).exp2(), (-0.35 * k + 0.1 * t).exp2()];
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
pub fn pixel(rgb: [f32; 3], p: &Params, gains: &[f32; 3]) -> [f32; 3] {
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
    out
}

/// 套用到整張影像（rayon 逐列平行處理）
pub fn apply_rgb(img: &mut RgbImage, p: &Params) {
    if p.is_identity() {
        return;
    }
    let p = p.clamped();
    let gains = wb_gains(&p);
    let w = img.width() as usize;
    img.as_mut()
        .par_chunks_mut(w * 3)
        .for_each(|row| {
            for px in row.chunks_exact_mut(3) {
                let o = pixel([px[0] as f32 / 255.0, px[1] as f32 / 255.0, px[2] as f32 / 255.0], &p, &gains);
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
            let o = pixel([x, x * 0.5, 1.0 - x], &p, &g);
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
        let base = pixel([0.4, 0.4, 0.4], &p, &g)[0];
        p.exposure = 1.0;
        assert!(pixel([0.4, 0.4, 0.4], &p, &g)[0] > base + 0.1);
        p.exposure = -1.0;
        assert!(pixel([0.4, 0.4, 0.4], &p, &g)[0] < base - 0.1);
    }

    #[test]
    fn tone_controls_are_monotonic() {
        for (field, amt) in [(3, 100.0), (3, -100.0), (4, -100.0), (4, 100.0), (5, 100.0), (5, -100.0), (6, 100.0), (7, -100.0)] {
            let mut v = [0f32; 10];
            v[field] = amt;
            let p = Params::from_values(v);
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
        let o = pixel([0.5, 0.5, 0.5], &p, &wb_gains(&p));
        assert!(o[0] > o[2]);
    }

    #[test]
    fn saturation_zero_is_gray() {
        let p = Params { saturation: -100.0, ..Default::default() };
        let o = pixel([0.8, 0.3, 0.1], &p, &wb_gains(&p));
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
        assert_eq!(mine.merged(&src, &all), src);
    }

    #[test]
    fn clamps_bad_values() {
        let p = Params { exposure: 99.0, contrast: f32::NAN, ..Default::default() }.clamped();
        assert_eq!(p.exposure, 5.0);
        assert_eq!(p.contrast, 0.0);
    }
}
