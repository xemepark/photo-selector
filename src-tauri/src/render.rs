//! 產生縮圖 / 預覽 / 100% 原圖。

use crate::jpeg;
use crate::meta;
use crate::scan::{Class, Item};
use anyhow::{anyhow, Context, Result};
use image::{DynamicImage, GrayImage, RgbImage};
use std::fs::File;
use std::io::Cursor;

pub const THUMB_EDGE: u32 = 400;
pub const PREVIEW_EDGE: u32 = 2560;
pub const MEDIUM_EDGE: u32 = 2048;
/// 中等預覽接受的最小來源尺寸：內嵌預覽常見 1616×1080
const MEDIUM_MIN_SOURCE: u32 = 1600;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Thumb,
    /// 中等預覽（約 1600–2048px）：相機 JPEG / RAW 內嵌預覽就有這個大小，幾乎不用解碼原圖，全螢幕時先顯示
    Medium,
    Preview,
    Full,
    /// 調整視窗用：預覽大小、不套用調整（前端用 WebGL 即時套用）
    Base,
}

pub fn apply_orientation(img: DynamicImage, o: u16) -> DynamicImage {
    match o {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

/// 用 DCT 縮放解碼 JPEG：直接解出 1/2、1/4、1/8 尺寸，
/// 解出的長邊會 ≥ min_edge（min_edge = 0 代表全尺寸）。
pub fn decode_jpeg_scaled(bytes: &[u8], min_edge: u32) -> Result<DynamicImage> {
    decode_jpeg_with_meta(bytes, min_edge).map(|(img, _)| img)
}

/// JPEG 內的色彩描述檔 / EXIF（轉存時要帶到新檔案）
#[derive(Default)]
pub struct JpegMeta {
    pub icc: Option<Vec<u8>>,
    /// 從 TIFF 檔頭開始的 EXIF 資料
    pub exif: Option<Vec<u8>>,
}

/// 同 decode_jpeg_scaled，另外回傳 ICC / EXIF
pub fn decode_jpeg_with_meta(bytes: &[u8], min_edge: u32) -> Result<(DynamicImage, JpegMeta)> {
    let mut d = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    d.read_info()?;
    let info = d.info().ok_or_else(|| anyhow!("no jpeg info"))?;
    let (w, h) = (info.width as u32, info.height as u32);
    let long = w.max(h).max(1);
    if min_edge > 0 && min_edge < long {
        let rw = ((w as u64 * min_edge as u64).div_ceil(long as u64)).max(1) as u16;
        let rh = ((h as u64 * min_edge as u64).div_ceil(long as u64)).max(1) as u16;
        d.scale(rw, rh)?;
    }
    let px = d.decode()?;
    let info = d.info().ok_or_else(|| anyhow!("no jpeg info"))?;
    let (w, h) = (info.width as u32, info.height as u32);
    use jpeg_decoder::PixelFormat::*;
    let img = match info.pixel_format {
        RGB24 => DynamicImage::ImageRgb8(RgbImage::from_raw(w, h, px).context("rgb")?),
        L8 => DynamicImage::ImageLuma8(GrayImage::from_raw(w, h, px).context("gray")?),
        L16 => {
            let g: Vec<u8> = px.chunks_exact(2).map(|c| c[0]).collect();
            DynamicImage::ImageLuma8(GrayImage::from_raw(w, h, g).context("gray16")?)
        }
        CMYK32 => {
            // Adobe 反相 CMYK 的近似轉換（少見，夠用就好）
            let rgb: Vec<u8> = px
                .chunks_exact(4)
                .flat_map(|c| {
                    let k = c[3] as u32;
                    [(c[0] as u32 * k / 255) as u8, (c[1] as u32 * k / 255) as u8, (c[2] as u32 * k / 255) as u8]
                })
                .collect();
            DynamicImage::ImageRgb8(RgbImage::from_raw(w, h, rgb).context("cmyk")?)
        }
    };
    let meta = JpegMeta {
        icc: d.icc_profile(),
        exif: d.exif_data().map(|e| e.to_vec()),
    };
    Ok((img, meta))
}

/// 解碼一個項目的顯示影像（已套用方向），長邊至少 min_edge（0 = 全尺寸）。
pub fn decode_source(item: &Item, min_edge: u32) -> Result<DynamicImage> {
    let f = item.display();
    let file = File::open(&f.path)?;
    let data = unsafe { memmap2::Mmap::map(&file)? };
    let orient = meta::orientation(f.class, &data);
    let img = match f.class {
        Class::Jpeg => {
            // 相機 JPEG 內嵌的預覽圖夠大、比例也一致時，就只解碼它（快數十倍，外接硬碟上差異更大）
            match (min_edge > 0).then(|| jpeg_embedded_preview(&data, min_edge)).flatten() {
                Some(j) => decode_jpeg_scaled(j.bytes(&data), min_edge)?,
                None => decode_jpeg_scaled(&data, min_edge)?,
            }
        }
        Class::Image => image::load_from_memory(&data)?,
        Class::Raw | Class::Other => {
            let want = if min_edge == 0 { u32::MAX } else { min_edge };
            let list = jpeg::embedded_jpegs(&data, want);
            let j = jpeg::pick(&list, want).ok_or_else(|| anyhow!("找不到內嵌預覽圖"))?;
            decode_jpeg_scaled(j.bytes(&data), min_edge)?
        }
    };
    Ok(apply_orientation(img, orient))
}

/// JPEG 檔案內嵌、長邊 ≥ min_edge 且比例與原圖一致的預覽圖（取最小的一張）
fn jpeg_embedded_preview(data: &[u8], min_edge: u32) -> Option<jpeg::EmbeddedJpeg> {
    let (w, h, nc) = jpeg::jpeg_info(data)?;
    let ratio = w.max(h) as f32 / w.min(h).max(1) as f32;
    jpeg::jpeg_file_previews(data)
        .into_iter()
        .filter(|j| j.long_edge() >= min_edge && j.long_edge() < w.max(h))
        // 原圖是彩色、內嵌圖卻是灰階 → 不是預覽圖（多一道保險）
        .filter(|j| !(nc >= 3 && j.components < 3))
        .filter(|j| {
            let r = j.long_edge() as f32 / j.width.min(j.height).max(1) as f32;
            (r - ratio).abs() / ratio < 0.02 // 比例不同（例如加了黑邊）就不用
        })
        .min_by_key(|j| j.width as u64 * j.height as u64)
}

/// 中等預覽。回傳 (影像, 是否其實已經是完整預覽品質)。
/// 沒有內嵌預覽的 JPEG 反正都要解碼原圖，就直接做成完整預覽（之後要完整預覽時不必再算一次）。
pub fn render_medium(item: &Item) -> Result<(Vec<u8>, bool)> {
    let f = item.display();
    let adj = crate::edit::load(item);
    if f.class == Class::Jpeg {
        let has_embedded = File::open(&f.path)
            .ok()
            .and_then(|file| unsafe { memmap2::Mmap::map(&file) }.ok())
            .map(|data| jpeg_embedded_preview(&data, MEDIUM_MIN_SOURCE).is_some())
            .unwrap_or(false);
        if !has_embedded {
            return Ok((render(item, Kind::Preview)?, true));
        }
    }
    let mut img = decode_source(item, MEDIUM_MIN_SOURCE)?;
    if let Some(p) = &adj {
        img = crate::edit::apply(img, p);
    }
    if img.width().max(img.height()) >= PREVIEW_EDGE {
        return Ok((encode_jpeg(&fit(img, PREVIEW_EDGE), 88)?, true));
    }
    Ok((encode_jpeg(&fit(img, MEDIUM_EDGE), 85)?, false))
}

pub fn encode_jpeg(img: &DynamicImage, quality: u8) -> Result<Vec<u8>> {
    let rgb = img.to_rgb8();
    let mut buf = Vec::with_capacity((rgb.width() * rgb.height() / 4) as usize);
    jpeg_encoder::Encoder::new(&mut buf, quality).encode(
        rgb.as_raw(),
        rgb.width() as u16,
        rgb.height() as u16,
        jpeg_encoder::ColorType::Rgb,
    )?;
    Ok(buf)
}

fn fit(img: DynamicImage, edge: u32) -> DynamicImage {
    if img.width().max(img.height()) <= edge {
        img
    } else {
        img.thumbnail(edge, edge)
    }
}

pub fn render(item: &Item, kind: Kind) -> Result<Vec<u8>> {
    // 有「調整」設定時套用（縮小後才套用，速度快）
    let adj = crate::edit::load(item);
    let finish = |img: DynamicImage, edge: u32, q: u8| -> Result<Vec<u8>> {
        let img = fit(img, edge);
        let img = match &adj {
            Some(p) => crate::edit::apply(img, p),
            None => img,
        };
        encode_jpeg(&img, q)
    };
    match kind {
        Kind::Thumb => finish(decode_source(item, THUMB_EDGE)?, THUMB_EDGE, 82),
        Kind::Medium => finish(decode_source(item, MEDIUM_MIN_SOURCE)?, MEDIUM_EDGE, 85),
        Kind::Preview => finish(decode_source(item, PREVIEW_EDGE)?, PREVIEW_EDGE, 88),
        Kind::Base => encode_jpeg(&fit(decode_source(item, PREVIEW_EDGE)?, PREVIEW_EDGE), 90),
        Kind::Full => {
            let f = item.display();
            if adj.is_none() {
                // 原始 JPEG 直接交給 WebView（瀏覽器自己會依 EXIF 轉正）
                if f.class == Class::Jpeg {
                    return Ok(std::fs::read(&f.path)?);
                }
                if matches!(f.class, Class::Raw | Class::Other) {
                    let file = File::open(&f.path)?;
                    let data = unsafe { memmap2::Mmap::map(&file)? };
                    if meta::orientation(f.class, &data) == 1 {
                        if let Some(j) = jpeg::pick(&jpeg::embedded_jpegs(&data, u32::MAX), u32::MAX) {
                            return Ok(j.bytes(&data).to_vec());
                        }
                    }
                }
            }
            finish(decode_source(item, 0)?, u32::MAX, 92)
        }
    }
}

pub fn placeholder(ext: &str) -> Vec<u8> {
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200" viewBox="0 0 300 200"><rect width="300" height="200" rx="6" fill="#26262b"/><text x="150" y="112" font-family="sans-serif" font-size="34" font-weight="600" fill="#77777f" text-anchor="middle">{}</text></svg>"##,
        ext.to_uppercase()
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 實測縮圖產生時間：THUMB_BENCH_DIR=/path cargo test --release thumb_bench -- --nocapture
    #[test]
    fn thumb_bench() {
        let Ok(dir) = std::env::var("THUMB_BENCH_DIR") else { return };
        let (items, _) = crate::scan::scan_dir(std::path::Path::new(&dir)).unwrap();
        for it in &items {
            for kind in [Kind::Thumb, Kind::Medium, Kind::Preview] {
                let t = std::time::Instant::now();
                let bytes = render(it, kind).unwrap();
                let img = image::load_from_memory(&bytes).unwrap();
                println!("{} {kind:?}: {:?} -> {}x{} ({} KB)", it.name, t.elapsed(), img.width(), img.height(), bytes.len() / 1024);
                if let Ok(out) = std::env::var("THUMB_BENCH_SAVE") {
                    std::fs::write(format!("{out}/{}_{kind:?}.jpg", it.name), &bytes).unwrap();
                }
            }
        }
    }
}
