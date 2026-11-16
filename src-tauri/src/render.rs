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

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Thumb,
    Preview,
    Full,
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
    Ok(img)
}

/// 解碼一個項目的顯示影像（已套用方向），長邊至少 min_edge（0 = 全尺寸）。
pub fn decode_source(item: &Item, min_edge: u32) -> Result<DynamicImage> {
    let f = item.display();
    let file = File::open(&f.path)?;
    let data = unsafe { memmap2::Mmap::map(&file)? };
    let orient = meta::orientation(f.class, &data);
    let img = match f.class {
        Class::Jpeg => decode_jpeg_scaled(&data, min_edge)?,
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
    match kind {
        Kind::Thumb => encode_jpeg(&fit(decode_source(item, THUMB_EDGE)?, THUMB_EDGE), 82),
        Kind::Preview => encode_jpeg(&fit(decode_source(item, PREVIEW_EDGE)?, PREVIEW_EDGE), 88),
        Kind::Full => {
            let f = item.display();
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
            encode_jpeg(&decode_source(item, 0)?, 92)
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
