//! 人臉偵測與閉眼判斷（純 Rust 推論，使用 tract 執行 ONNX 模型，不需額外 DLL）。
//!
//! 模型來自 Google MediaPipe Face Landmarker（Apache 2.0），轉成 ONNX 後內嵌在執行檔中：
//!
//! 1. **人臉偵測**（BlazeFace 128×128）：原模型只擅長近距離大臉，所以這裡把照片切成
//!    多層、互相重疊的方塊分別偵測（整張 → 1/2 → 1/4），再用加權 NMS 合併，
//!    合照、婚禮大合照裡的小臉也找得到。
//! 2. **臉部特徵點**（478 點）：依兩眼連線把臉轉正後裁成 256×256 再推論。
//! 3. **表情係數**（52 個 blendshape）：取其中的 eyeBlinkLeft / eyeBlinkRight 當作閉眼分數，
//!    比單純用眼睛長寬比（EAR）更能分辨「閉眼」與「低頭、瞇眼笑」。

use image::{GrayImage, RgbImage};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, OnceLock};
use tract_onnx::prelude::*;

type Model = Arc<TypedRunnableModel>;

static DET_ONNX: &[u8] = include_bytes!("../models/face_detector.onnx");
static LMK_ONNX: &[u8] = include_bytes!("../models/face_landmarks_detector.onnx");
static BS_ONNX: &[u8] = include_bytes!("../models/face_blendshapes.onnx");

/// 閉眼判斷（只抓「幾乎完全閉上」）：兩眼的眨眼分數都要夠高，而且眼睛長寬比（EAR）都要很小。
/// 依實測：笑瞇眼 ≈ 眨眼 0.3–0.6 / EAR 0.05–0.15、低頭看東西 ≈ 0.35 / 0.13、真正閉眼 ≥ 0.6 / ≤ 0.08。
pub const CLOSED_BLINK: f32 = 0.55;
pub const CLOSED_EAR: f32 = 0.12;
/// 判斷眼睛對焦時，把眼睛統一縮放成這個寬度（像素）再計算清晰度，不同大小的臉才能比較
const EYE_NORM_WIDTH: f32 = 64.0;
/// 臉太小（像素）時特徵點不可靠，不判斷眼睛
const MIN_FACE_FOR_EYES: f32 = 40.0;

struct Models {
    det: Model,
    lmk: Model,
    bs: Model,
}

fn load(bytes: &[u8], shape: &[usize]) -> TractResult<Model> {
    tract_onnx::onnx()
        .model_for_read(&mut std::io::Cursor::new(bytes))?
        .with_input_fact(0, f32::fact(shape).into())?
        .into_optimized()?
        .into_runnable()
}

fn models() -> Option<&'static Models> {
    static M: OnceLock<Option<Models>> = OnceLock::new();
    M.get_or_init(|| {
        let r = (|| -> TractResult<Models> {
            Ok(Models {
                det: load(DET_ONNX, &[1, 128, 128, 3])?,
                lmk: load(LMK_ONNX, &[1, 256, 256, 3])?,
                bs: load(BS_ONNX, &[1, 146, 2])?,
            })
        })();
        r.map_err(|e| eprintln!("載入人臉模型失敗：{e:#}")).ok()
    })
    .as_ref()
}

/// 眼睛狀態：睜眼、閉眼（幾乎完全閉上）、無法判斷（臉太小 / 側臉）
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Eyes {
    Open,
    Closed,
    Unknown,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Face {
    /// 人臉框（相對於整張照片的比例：x, y, w, h）
    pub b: [f32; 4],
    /// 眨眼分數 [左眼, 右眼]（當事人的左右）
    pub blink: [f32; 2],
    pub eyes: Eyes,
    /// 臉部清晰度（拉普拉斯變異數，臉部區域縮放到固定尺寸後計算）
    pub sharp: f32,
    /// 眼睛長寬比 EAR [左眼, 右眼]，越小越閉
    pub ear: [f32; 2],
    /// 靠近鏡頭那隻眼睛的清晰度（用高解析度影像計算）；無法判斷時為 -1
    pub eye_sharp: f32,
    /// 靠近鏡頭那隻眼睛的範圍（相對於整張照片的比例 x, y, w, h），用來在預覽上標示
    pub eye: Option<[f32; 4]>,
}

fn floats(t: &Tensor) -> TractResult<Vec<f32>> {
    Ok(t.to_plain_array_view::<f32>()?.iter().copied().collect())
}

// ---------------------------------------------------------------- 影像取樣

/// 以仿射映射從原圖雙線性取樣成 out×out 的 NHWC 張量。
/// `map(u, v)` 把輸出座標（0..out，像素中心）轉成原圖座標。超出邊界補 `pad`。
fn sample(img: &RgbImage, out: usize, map: impl Fn(f32, f32) -> (f32, f32), lo: f32, hi: f32) -> Vec<f32> {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let px = img.as_raw();
    let scale = (hi - lo) / 255.0;
    let pad = (lo + hi) / 2.0;
    let mut v = vec![pad; out * out * 3];
    for oy in 0..out {
        for ox in 0..out {
            let (x, y) = map(ox as f32 + 0.5, oy as f32 + 0.5);
            let (x, y) = (x - 0.5, y - 0.5);
            let (x0, y0) = (x.floor() as i32, y.floor() as i32);
            if x0 < -1 || y0 < -1 || x0 >= w || y0 >= h {
                continue;
            }
            let (fx, fy) = (x - x0 as f32, y - y0 as f32);
            let get = |xx: i32, yy: i32, c: usize| -> f32 {
                let xx = xx.clamp(0, w - 1) as usize;
                let yy = yy.clamp(0, h - 1) as usize;
                px[(yy * w as usize + xx) * 3 + c] as f32
            };
            let o = (oy * out + ox) * 3;
            for c in 0..3 {
                let top = get(x0, y0, c) * (1.0 - fx) + get(x0 + 1, y0, c) * fx;
                let bot = get(x0, y0 + 1, c) * (1.0 - fx) + get(x0 + 1, y0 + 1, c) * fx;
                v[o + c] = lo + (top * (1.0 - fy) + bot * fy) * scale;
            }
        }
    }
    v
}

// ---------------------------------------------------------------- 人臉偵測

#[derive(Clone, Debug)]
struct Det {
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
    score: f32,
    kps: [[f32; 2]; 6],
}

impl Det {
    fn iou(&self, o: &Det) -> f32 {
        let ix = (self.x1.min(o.x1) - self.x0.max(o.x0)).max(0.0);
        let iy = (self.y1.min(o.y1) - self.y0.max(o.y0)).max(0.0);
        let inter = ix * iy;
        let a = (self.x1 - self.x0) * (self.y1 - self.y0);
        let b = (o.x1 - o.x0) * (o.y1 - o.y0);
        inter / (a + b - inter).max(1e-6)
    }
}

/// BlazeFace short-range 的 SSD anchors（896 個，中心點，固定大小）
fn anchors() -> &'static [(f32, f32)] {
    static A: OnceLock<Vec<(f32, f32)>> = OnceLock::new();
    A.get_or_init(|| {
        let mut v = Vec::with_capacity(896);
        for (stride, per_cell) in [(8usize, 2usize), (16, 6)] {
            let n = 128 / stride;
            for y in 0..n {
                for x in 0..n {
                    for _ in 0..per_cell {
                        v.push(((x as f32 + 0.5) / n as f32, (y as f32 + 0.5) / n as f32));
                    }
                }
            }
        }
        v
    })
}

/// 在一個正方形視窗（原圖座標 wx, wy, side）裡偵測人臉
fn detect_window(m: &Models, img: &RgbImage, wx: f32, wy: f32, side: f32) -> TractResult<Vec<Det>> {
    let s = side / 128.0;
    let data = sample(img, 128, |u, v| (wx + u * s, wy + v * s), -1.0, 1.0);
    let input = Tensor::from_shape(&[1, 128, 128, 3], &data)?;
    let out = m.det.run(tvec!(input.into()))?;
    let reg = floats(&out[0])?;
    let cls = floats(&out[1])?;
    let mut dets = Vec::new();
    for (i, &(ax, ay)) in anchors().iter().enumerate() {
        let score = 1.0 / (1.0 + (-cls[i].clamp(-100.0, 100.0)).exp());
        if score < 0.5 {
            continue;
        }
        let r = &reg[i * 16..i * 16 + 16];
        let cx = r[0] / 128.0 + ax;
        let cy = r[1] / 128.0 + ay;
        let (bw, bh) = (r[2] / 128.0, r[3] / 128.0);
        let to_img = |nx: f32, ny: f32| [wx + nx * side, wy + ny * side];
        let mut kps = [[0f32; 2]; 6];
        for (k, kp) in kps.iter_mut().enumerate() {
            *kp = to_img(r[4 + k * 2] / 128.0 + ax, r[5 + k * 2] / 128.0 + ay);
        }
        let [x0, y0] = to_img(cx - bw / 2.0, cy - bh / 2.0);
        let [x1, y1] = to_img(cx + bw / 2.0, cy + bh / 2.0);
        dets.push(Det { x0, y0, x1, y1, score, kps });
    }
    Ok(dets)
}

/// 加權 NMS（MediaPipe 的做法）：重疊的偵測結果依分數加權平均，框更穩定
fn weighted_nms(mut dets: Vec<Det>, iou: f32) -> Vec<Det> {
    dets.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut out = Vec::new();
    while !dets.is_empty() {
        let best = dets[0].clone();
        let (group, rest): (Vec<Det>, Vec<Det>) = dets.into_iter().partition(|d| d.iou(&best) > iou);
        dets = rest;
        let total: f32 = group.iter().map(|d| d.score).sum();
        let mut m = best.clone();
        let avg = |f: &dyn Fn(&Det) -> f32| group.iter().map(|d| f(d) * d.score).sum::<f32>() / total;
        m.x0 = avg(&|d| d.x0);
        m.y0 = avg(&|d| d.y0);
        m.x1 = avg(&|d| d.x1);
        m.y1 = avg(&|d| d.y1);
        for k in 0..6 {
            m.kps[k][0] = avg(&|d| d.kps[k][0]);
            m.kps[k][1] = avg(&|d| d.kps[k][1]);
        }
        out.push(m);
    }
    out
}

fn detect(m: &Models, img: &RgbImage) -> TractResult<Vec<Det>> {
    let (w, h) = (img.width() as f32, img.height() as f32);
    let mut all = Vec::new();
    // 第 0 層：整張照片（補邊成正方形）
    let side = w.max(h);
    all.extend(detect_window(m, img, (w - side) / 2.0, (h - side) / 2.0, side)?);
    // 第 1~3 層：邊長為短邊的 1、1/2、1/4，重疊一半的方塊
    for div in [1.0, 2.0, 4.0] {
        let side = w.min(h) / div;
        if side < 96.0 {
            break;
        }
        let stride = side / 2.0;
        let nx = ((w - side) / stride).ceil().max(0.0) as usize + 1;
        let ny = ((h - side) / stride).ceil().max(0.0) as usize + 1;
        for iy in 0..ny {
            for ix in 0..nx {
                let wx = (ix as f32 * stride).min(w - side);
                let wy = (iy as f32 * stride).min(h - side);
                for d in detect_window(m, img, wx, wy, side)? {
                    // 方塊邊緣被切到一半的臉不採用（鄰近重疊的方塊會完整看到它）
                    let (cx, cy) = ((d.x0 + d.x1) / 2.0, (d.y0 + d.y1) / 2.0);
                    let (mx, my) = (side * 0.12, side * 0.12);
                    let ok_x = (wx <= 0.5 || cx > wx + mx) && (wx + side >= w - 0.5 || cx < wx + side - mx);
                    let ok_y = (wy <= 0.5 || cy > wy + my) && (wy + side >= h - 0.5 || cy < wy + side - my);
                    if ok_x && ok_y {
                        all.push(d);
                    }
                }
            }
        }
    }
    Ok(weighted_nms(all, 0.3))
}

// ---------------------------------------------------------------- 特徵點與閉眼

/// MediaPipe face_blendshapes 模型使用的 146 個特徵點索引
const BS_IDX: [usize; 146] = [
    0, 1, 4, 5, 6, 7, 8, 10, 13, 14, 17, 21, 33, 37, 39, 40, 46, 52, 53, 54, 55, 58, 61, 63, 65, 66, 67, 70, 78, 80, 81,
    82, 84, 87, 88, 91, 93, 95, 103, 105, 107, 109, 127, 132, 133, 136, 144, 145, 146, 148, 149, 150, 152, 153, 154,
    155, 157, 158, 159, 160, 161, 162, 163, 168, 172, 173, 176, 178, 181, 185, 191, 195, 197, 234, 246, 249, 251, 263,
    267, 269, 270, 276, 282, 283, 284, 285, 288, 291, 293, 295, 296, 297, 300, 308, 310, 311, 312, 314, 317, 318, 321,
    323, 324, 332, 334, 336, 338, 356, 361, 362, 365, 373, 374, 375, 377, 378, 379, 380, 381, 382, 384, 385, 386, 387,
    388, 389, 390, 397, 398, 400, 402, 405, 409, 415, 454, 466, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477,
];
const BLINK_LEFT: usize = 9;
const BLINK_RIGHT: usize = 10;

struct Landmarks {
    pts: Vec<[f32; 2]>,
    /// 相對深度（越小越靠近鏡頭）
    z: Vec<f32>,
    presence: f32,
}

fn landmarks(m: &Models, img: &RgbImage, d: &Det) -> TractResult<Landmarks> {
    // 依兩眼連線決定旋轉角度，把臉轉正；ROI = 人臉框長邊 × 1.5 的正方形
    let [rx, ry] = d.kps[0];
    let [lx, ly] = d.kps[1];
    let angle = (ly - ry).atan2(lx - rx);
    let (c, s) = (angle.cos(), angle.sin());
    let cx = (d.x0 + d.x1) / 2.0;
    let cy = (d.y0 + d.y1) / 2.0;
    let size = (d.x1 - d.x0).max(d.y1 - d.y0) * 1.5;
    let to_img = move |u: f32, v: f32| {
        let lx = (u / 256.0 - 0.5) * size;
        let ly = (v / 256.0 - 0.5) * size;
        (cx + lx * c - ly * s, cy + lx * s + ly * c)
    };
    let data = sample(img, 256, to_img, 0.0, 1.0);
    let input = Tensor::from_shape(&[1, 256, 256, 3], &data)?;
    let out = m.lmk.run(tvec!(input.into()))?;
    let raw = floats(&out[0])?;
    let pts = raw.chunks_exact(3).map(|p| {
        let (x, y) = to_img(p[0], p[1]);
        [x, y]
    });
    let z: Vec<f32> = raw.chunks_exact(3).map(|p| p[2]).collect();
    let mut presence = floats(&out[1])?.first().copied().unwrap_or(0.0);
    if !(0.0..=1.0).contains(&presence) {
        presence = 1.0 / (1.0 + (-presence).exp());
    }
    Ok(Landmarks { pts: pts.collect(), z, presence })
}

fn blink(m: &Models, pts: &[[f32; 2]]) -> TractResult<[f32; 2]> {
    let mut data = Vec::with_capacity(146 * 2);
    for &i in &BS_IDX {
        data.extend_from_slice(&pts[i]);
    }
    let input = Tensor::from_shape(&[1, 146, 2], &data)?;
    let out = m.bs.run(tvec!(input.into()))?;
    let v = floats(&out[0])?;
    Ok([v[BLINK_LEFT], v[BLINK_RIGHT]])
}

fn face_sharpness(gray: &GrayImage, d: &Det) -> f32 {
    // 取人臉框中央 80%，縮放到 128×128 後計算，不同大小的臉才能互相比較
    let (w, h) = (d.x1 - d.x0, d.y1 - d.y0);
    let x = (d.x0 + w * 0.1).max(0.0) as u32;
    let y = (d.y0 + h * 0.1).max(0.0) as u32;
    let cw = ((w * 0.8) as u32).min(gray.width().saturating_sub(x));
    let ch = ((h * 0.8) as u32).min(gray.height().saturating_sub(y));
    if cw < 8 || ch < 8 {
        return 0.0;
    }
    let crop = image::imageops::crop_imm(gray, x, y, cw, ch).to_image();
    let crop = image::imageops::resize(&crop, 128, 128, image::imageops::FilterType::Triangle);
    crate::blur::laplacian_variance(&crop)
}

pub fn eyes_state(b: [f32; 2], ear: [f32; 2]) -> Eyes {
    if b[0] >= CLOSED_BLINK && b[1] >= CLOSED_BLINK && ear[0] <= CLOSED_EAR && ear[1] <= CLOSED_EAR {
        Eyes::Closed
    } else {
        Eyes::Open
    }
}

/// MediaPipe 臉部網格的眼睛特徵點：[外眼角, 上1, 上2, 內眼角, 下2, 下1]（當事人的左、右眼）
const EYE_LEFT: [usize; 6] = [362, 385, 387, 263, 373, 380];
const EYE_RIGHT: [usize; 6] = [33, 160, 158, 133, 153, 144];

fn dist(a: [f32; 2], b: [f32; 2]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

/// 眼睛長寬比（Eye Aspect Ratio）：上下眼皮距離 / 眼角距離
fn ear(pts: &[[f32; 2]], idx: &[usize; 6]) -> f32 {
    let p = |i: usize| pts[idx[i]];
    let w = dist(p(0), p(3)).max(1e-3);
    (dist(p(1), p(5)) + dist(p(2), p(4))) / (2.0 * w)
}

/// 靠近鏡頭的那隻眼睛：比較兩眼特徵點的平均深度（z 越小越近），差不多時取看起來較大的那隻
fn near_eye(l: &Landmarks) -> &'static [usize; 6] {
    let zavg = |idx: &[usize; 6]| idx.iter().map(|&i| l.z[i]).sum::<f32>() / 6.0;
    let width = |idx: &[usize; 6]| dist(l.pts[idx[0]], l.pts[idx[3]]);
    let (zl, zr) = (zavg(&EYE_LEFT), zavg(&EYE_RIGHT));
    let (wl, wr) = (width(&EYE_LEFT), width(&EYE_RIGHT));
    if (zl - zr).abs() > 0.02 * wl.max(wr) {
        if zl < zr { &EYE_LEFT } else { &EYE_RIGHT }
    } else if wl >= wr {
        &EYE_LEFT
    } else {
        &EYE_RIGHT
    }
}

/// 眼睛的清晰度：在高解析度灰階影像上裁出眼睛（含睫毛），統一縮放到相同大小後計算拉普拉斯變異數。
/// `scale` = 高解析度影像 / 偵測用影像 的倍率。回傳 (清晰度, 眼睛範圍[偵測影像座標])
fn eye_sharpness(hires: &GrayImage, scale: f32, pts: &[[f32; 2]], idx: &[usize; 6]) -> Option<(f32, [f32; 4])> {
    let w = dist(pts[idx[0]], pts[idx[3]]);
    // 眼睛（在高解析度影像中）至少要 40px 寬才判斷對焦：太小的眼睛放大後本身就會顯得模糊，
    // 會拉低整批的基準。合照這類小臉改用整張照片的清晰度判斷。
    if w * scale < 40.0 {
        return None;
    }
    let cx = idx.iter().map(|&i| pts[i][0]).sum::<f32>() / 6.0;
    let cy = idx.iter().map(|&i| pts[i][1]).sum::<f32>() / 6.0;
    let side = w * 1.6;
    let (x0, y0) = (cx - side / 2.0, cy - side / 2.0);
    let (hx, hy, hs) = ((x0 * scale).max(0.0) as u32, (y0 * scale).max(0.0) as u32, (side * scale) as u32);
    let hw = hs.min(hires.width().saturating_sub(hx));
    let hh = hs.min(hires.height().saturating_sub(hy));
    if hw < 8 || hh < 8 {
        return None;
    }
    let crop = image::imageops::crop_imm(hires, hx, hy, hw, hh).to_image();
    let k = EYE_NORM_WIDTH * 1.6 / hs as f32;
    let (nw, nh) = (((hw as f32) * k).round().max(8.0) as u32, ((hh as f32) * k).round().max(8.0) as u32);
    let norm = image::imageops::resize(&crop, nw, nh, image::imageops::FilterType::Triangle);
    Some((crate::blur::laplacian_variance(&norm), [x0, y0, side, side]))
}

/// 分析一張照片中的所有人臉。模型無法載入時回傳空陣列。
/// `hires`：同一張照片的高解析度灰階影像（用來判斷眼睛對焦），沒有就用 `img` 本身。
pub fn analyze(img: &RgbImage, hires: Option<&GrayImage>) -> Vec<Face> {
    let Some(m) = models() else { return vec![] };
    let gray = image::DynamicImage::ImageRgb8(img.clone()).to_luma8();
    let (w, h) = (img.width() as f32, img.height() as f32);
    let Ok(dets) = detect(m, img) else { return vec![] };
    let mut faces = Vec::new();
    for d in dets {
        let fw = d.x1 - d.x0;
        if fw < 12.0 {
            continue;
        }
        let (mut eyes, mut bl, mut ears) = (Eyes::Unknown, [0.0, 0.0], [0.0, 0.0]);
        let (mut eye_sharp, mut eye_box) = (-1.0, None);
        if fw >= MIN_FACE_FOR_EYES {
            match landmarks(m, img, &d) {
                // 偵測器與特徵點模型兩者都要有信心才算人臉：
                // 實測真人臉 det ≥ 0.88、presence ≈ 1.0；誤判的物體（例如金屬罐）det ≈ 0.6、presence ≈ 0.95
                Ok(l) if l.presence < 0.5 || (d.score < 0.75 && l.presence < 0.98) => continue,
                Ok(l) => {
                    ears = [ear(&l.pts, &EYE_LEFT), ear(&l.pts, &EYE_RIGHT)];
                    if let Ok(b) = blink(m, &l.pts) {
                        bl = b;
                        eyes = eyes_state(b, ears);
                    }
                    let (hi, scale) = match hires {
                        Some(h) => (h, h.width() as f32 / w),
                        None => (&gray, 1.0),
                    };
                    if let Some((sv, bx)) = eye_sharpness(hi, scale, &l.pts, near_eye(&l)) {
                        eye_sharp = sv;
                        eye_box = Some([bx[0] / w, bx[1] / h, bx[2] / w, bx[3] / h]);
                    }
                }
                Err(_) => {}
            }
        } else if d.score < 0.75 {
            continue; // 很小又不確定的偵測結果，誤判機率高
        }
        faces.push(Face {
            b: [d.x0.max(0.0) / w, d.y0.max(0.0) / h, fw / w, (d.y1 - d.y0) / h],
            blink: bl,
            eyes,
            sharp: face_sharpness(&gray, &d),
            ear: ears,
            eye_sharp,
            eye: eye_box,
        });
    }
    // 由大到小排序：第一張臉通常是主角
    faces.sort_by(|a, b| (b.b[2] * b.b[3]).partial_cmp(&(a.b[2] * a.b[3])).unwrap_or(std::cmp::Ordering::Equal));
    faces
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_load_and_anchor_count() {
        assert_eq!(anchors().len(), 896);
        assert!(models().is_some());
    }

    #[test]
    fn no_faces_in_synthetic_pattern() {
        let img = RgbImage::from_fn(800, 600, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        assert!(analyze(&img, None).is_empty());
    }

    /// 用真實照片驗證：FACE_TEST_IMAGES=a.jpg,b.png cargo test --release face_report -- --nocapture
    #[test]
    fn face_report() {
        let Ok(list) = std::env::var("FACE_TEST_IMAGES") else { return };
        for p in list.split(',') {
            let img = image::open(p).unwrap().to_rgb8();
            let t = std::time::Instant::now();
            let hi = std::env::var("FACE_HIRES").ok().map(|_| image::DynamicImage::ImageRgb8(img.clone()).to_luma8());
            let det = image::DynamicImage::ImageRgb8(img.clone()).thumbnail(2048, 2048).to_rgb8();
            let faces = analyze(&det, hi.as_ref());
            let img = det;
            println!("{p}: {} faces in {:?}", faces.len(), t.elapsed());
            for f in faces {
                let (cx, cy) = ((f.b[0] + f.b[2] / 2.0) * img.width() as f32, (f.b[1] + f.b[3] / 2.0) * img.height() as f32);
                println!(
                    "  center=({cx:.0},{cy:.0}) size={:.0}px blink=[{:.3},{:.3}] ear=[{:.3},{:.3}] eyes={:?} eye_sharp={:.0}",
                    f.b[2] * img.width() as f32,
                    f.blink[0],
                    f.blink[1],
                    f.ear[0],
                    f.ear[1],
                    f.eyes,
                    f.eye_sharp
                );
            }
        }
    }
}
