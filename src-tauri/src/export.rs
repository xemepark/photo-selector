//! 影像轉存（仿 Photoshop / Bridge「影像處理器」）：
//! 把選取的照片縮到指定尺寸內，另存為 JPEG / TIFF / PNG。
//!
//! - 來源：相機 JPEG 用原圖；只有 RAW 時用 RAW 內嵌的最大 JPEG（相機算好的顏色，尚未經 Camera Raw 調整）
//! - 「儲存至相同位置」與 Photoshop 一樣，存到原資料夾下的 JPEG / TIFF / PNG 子資料夾；
//!   指定資料夾時也一樣建立格式子資料夾。同名檔案不覆蓋，自動加上 -1、-2…
//! - 色彩：可轉換為 sRGB（讀取原圖的 ICC 描述檔；相機 Adobe RGB 模式沒有內嵌描述檔時，依 EXIF 判斷）
//!   並可嵌入 ICC 描述檔
//! - JPEG 會保留 EXIF（方向改成「正常」，因為影像已經轉正）；評等、標籤、版權寫入 XMP

use crate::meta;
use crate::render::{self, JpegMeta};
use crate::scan::{Class, Item};
use crate::{jpeg, xmp};
use anyhow::{anyhow, Context, Result};
use image::{imageops::FilterType, DynamicImage, RgbImage};
use moxcms::{ColorProfile, Layout, TransformOptions};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Jpeg,
    Tiff,
    Png,
}

impl Format {
    fn folder(self) -> &'static str {
        match self {
            Format::Jpeg => "JPEG",
            Format::Tiff => "TIFF",
            Format::Png => "PNG",
        }
    }
    fn ext(self) -> &'static str {
        match self {
            Format::Jpeg => "jpg",
            Format::Tiff => "tif",
            Format::Png => "png",
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
pub struct FormatOptions {
    pub format: Format,
    /// 縮到這個框內（寬、高；0 = 不限制）。None = 原尺寸。不會放大。
    pub fit: Option<(u32, u32)>,
    /// JPEG 品質 0–12（與 Photoshop 相同的級距）
    #[serde(default = "default_quality")]
    pub quality: u8,
    /// TIFF LZW 壓縮
    #[serde(default)]
    pub lzw: bool,
}

fn default_quality() -> u8 {
    10
}

#[derive(Deserialize, Clone, Debug)]
pub struct ExportOptions {
    /// None = 儲存至相同位置
    pub dest: Option<PathBuf>,
    pub formats: Vec<FormatOptions>,
    #[serde(default)]
    pub to_srgb: bool,
    #[serde(default = "yes")]
    pub embed_icc: bool,
    #[serde(default)]
    pub copyright: String,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Default, Debug)]
pub struct ExportResult {
    pub done: usize,
    pub failed: Vec<String>,
    /// 輸出的資料夾（給「在 Finder 中打開」用）
    pub dirs: Vec<String>,
}

/// Photoshop 品質 0–12 → JPEG 品質 1–100
fn jpeg_quality(q: u8) -> u8 {
    const TABLE: [u8; 13] = [20, 30, 40, 50, 58, 65, 72, 78, 84, 89, 93, 96, 98];
    TABLE[q.min(12) as usize]
}

/// 解碼後的來源影像與附帶資訊
pub(crate) struct Source {
    pub img: DynamicImage,
    pub icc: Option<Vec<u8>>,
    pub exif: Option<Vec<u8>>,
}

/// 框內縮放後的長邊（不放大）。回傳 None = 不需縮小
fn target_size(w: u32, h: u32, fit: Option<(u32, u32)>) -> Option<(u32, u32)> {
    let (fw, fh) = fit?;
    let sx = if fw > 0 { fw as f64 / w as f64 } else { f64::INFINITY };
    let sy = if fh > 0 { fh as f64 / h as f64 } else { f64::INFINITY };
    let s = sx.min(sy);
    if !s.is_finite() || s >= 1.0 {
        return None;
    }
    Some((((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1)))
}

/// 解碼時至少要多大：所有格式中最大的輸出長邊（用 JPEG DCT 縮放加速；0 = 原尺寸）
fn decode_min_edge(dims: Option<(u32, u32)>, formats: &[FormatOptions]) -> u32 {
    let Some((w, h)) = dims else { return 0 };
    let mut need = 0;
    for f in formats {
        match target_size(w, h, f.fit) {
            None => return 0,
            Some((tw, th)) => need = need.max(tw.max(th)),
        }
    }
    // 多留一點，再用 Lanczos 縮到精確尺寸，畫質較好
    need.saturating_mul(5) / 4
}

pub(crate) fn load(item: &Item, formats: &[FormatOptions]) -> Result<Source> {
    let f = item.display();
    let file = File::open(&f.path)?;
    let data = unsafe { memmap2::Mmap::map(&file)? };
    let orient = meta::item_orientation(item, &data);
    let swap = matches!(orient, 5..=8);
    let oriented = |d: Option<(u32, u32)>| d.map(|(w, h)| if swap { (h, w) } else { (w, h) });

    let (img, m) = match f.class {
        Class::Jpeg => {
            let min = decode_min_edge(oriented(jpeg::jpeg_dims(&data)), formats);
            render::decode_jpeg_with_meta(&data, min)?
        }
        Class::Image => {
            use image::ImageDecoder;
            let reader = image::ImageReader::new(std::io::Cursor::new(&data[..])).with_guessed_format()?;
            let mut dec = reader.into_decoder()?;
            let icc = dec.icc_profile().ok().flatten();
            let img = render::flatten_alpha(DynamicImage::from_decoder(dec)?);
            (img, JpegMeta { icc, ..Default::default() })
        }
        _ if crate::heic::is_heif(f) => {
            let b = crate::heic::jpeg_bytes(f)?;
            let min = decode_min_edge(oriented(jpeg::jpeg_dims(&b)), formats);
            render::decode_jpeg_with_meta(&b, min)?
        }
        Class::Raw | Class::Other => {
            let list = jpeg::embedded_jpegs(&data, u32::MAX);
            let j = jpeg::pick(&list, u32::MAX).ok_or_else(|| anyhow!("找不到 RAW 內嵌的預覽圖"))?;
            let min = decode_min_edge(oriented(Some((j.width, j.height))), formats);
            // 內嵌預覽通常沒有 EXIF；RAW 本身的 TIFF 檔頭含大量私有資料，不直接複製
            render::decode_jpeg_with_meta(j.bytes(&data), min)?
        }
        Class::Text => return Err(anyhow!("文字檔不能轉存成影像")),
    };
    // 套用「調整」設定（在色彩轉換之前，與畫面上看到的一致）
    let img = crate::edit::apply_item(item, render::apply_orientation(img, orient));
    Ok(Source { img, icc: m.icc, exif: m.exif })
}

// ---------------------------------------------------------------- 色彩

fn srgb_icc() -> &'static [u8] {
    static ICC: OnceLock<Vec<u8>> = OnceLock::new();
    ICC.get_or_init(crate::icc::srgb_v2)
}

/// 相機設定成 Adobe RGB 時多半不嵌 ICC，而是在 EXIF 標示：ColorSpace = 未校正 + InteropIndex = "R03"
fn exif_says_adobe_rgb(exif: &[u8]) -> bool {
    let Ok(ex) = exif::Reader::new().read_raw(exif.to_vec()) else { return false };
    let interop = ex
        .get_field(exif::Tag::InteroperabilityIndex, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string())
        .unwrap_or_default();
    let cs = ex.get_field(exif::Tag::ColorSpace, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0));
    interop.contains("R03") && cs != Some(1)
}

/// 來源的色彩描述檔（沒有就依 EXIF 推斷，再不然視為 sRGB）
fn source_profile(src: &Source) -> Option<ColorProfile> {
    if let Some(icc) = &src.icc {
        return ColorProfile::new_from_slice(icc).ok();
    }
    if src.exif.as_deref().is_some_and(exif_says_adobe_rgb) {
        return Some(ColorProfile::new_adobe_rgb());
    }
    None
}

/// 把影像從 `profile` 轉換為 sRGB
fn convert_to_srgb(rgb: &mut RgbImage, profile: &ColorProfile) -> Result<()> {
    let t = profile
        .create_transform_8bit(Layout::Rgb, &ColorProfile::new_srgb(), Layout::Rgb, TransformOptions::default())
        .map_err(|e| anyhow!("色彩轉換：{e:?}"))?;
    let mut out = vec![0u8; rgb.as_raw().len()];
    t.transform(rgb.as_raw(), &mut out).map_err(|e| anyhow!("色彩轉換：{e:?}"))?;
    rgb.copy_from_slice(&out);
    Ok(())
}

// ---------------------------------------------------------------- EXIF

/// 把 EXIF 的方向改成 1（影像已經轉正）。exif 從 TIFF 檔頭開始。
pub(crate) fn reset_orientation(exif: &mut [u8]) {
    let le = match exif.get(..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return,
    };
    let r16 = |d: &[u8], p: usize| -> Option<u16> {
        let b = d.get(p..p + 2)?;
        Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) })
    };
    let r32 = |d: &[u8], p: usize| -> Option<u32> {
        let b = d.get(p..p + 4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Some(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    };
    let Some(ifd) = r32(exif, 4).map(|v| v as usize) else { return };
    let Some(n) = r16(exif, ifd) else { return };
    for i in 0..n as usize {
        let e = ifd + 2 + i * 12;
        if r16(exif, e) == Some(0x0112) && r16(exif, e + 2) == Some(3) {
            let one = if le { [1, 0] } else { [0, 1] };
            if let Some(v) = exif.get_mut(e + 8..e + 10) {
                v.copy_from_slice(&one);
            }
            return;
        }
    }
}

// ---------------------------------------------------------------- 輸出

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let p = dir.join(format!("{stem}.{ext}"));
    if !p.exists() {
        return p;
    }
    (1..)
        .map(|i| dir.join(format!("{stem}-{i}.{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

pub(crate) fn write_jpeg(path: &Path, rgb: &RgbImage, q: u8, icc: Option<&[u8]>, exif: Option<&[u8]>, xmp: Option<&str>) -> Result<()> {
    let mut buf = Vec::with_capacity((rgb.width() * rgb.height() / 3) as usize);
    let mut enc = jpeg_encoder::Encoder::new(&mut buf, jpeg_quality(q));
    // 與 Photoshop 相同：品質 7 以上不做色度抽樣（4:4:4）
    enc.set_sampling_factor(if q >= 7 {
        jpeg_encoder::SamplingFactor::R_4_4_4
    } else {
        jpeg_encoder::SamplingFactor::R_4_2_0
    });
    enc.set_optimized_huffman_tables(true);
    if let Some(e) = exif {
        let mut seg = b"Exif\0\0".to_vec();
        seg.extend_from_slice(e);
        if seg.len() <= 65533 {
            enc.add_app_segment(1, seg)?;
        }
    }
    if let Some(x) = xmp {
        let mut seg = b"http://ns.adobe.com/xap/1.0/\0".to_vec();
        seg.extend_from_slice(x.as_bytes());
        if seg.len() <= 65533 {
            enc.add_app_segment(1, seg)?;
        }
    }
    if let Some(icc) = icc {
        enc.add_icc_profile(icc)?;
    }
    if rgb.width() > u16::MAX as u32 || rgb.height() > u16::MAX as u32 {
        return Err(anyhow!("影像太大，JPEG 最大 65535 像素"));
    }
    enc.encode(rgb.as_raw(), rgb.width() as u16, rgb.height() as u16, jpeg_encoder::ColorType::Rgb)?;
    fs::write(path, buf)?;
    Ok(())
}

pub(crate) fn write_tiff(path: &Path, rgb: &RgbImage, lzw: bool, icc: Option<&[u8]>, xmp: Option<&str>) -> Result<()> {
    use tiff::encoder::{colortype::RGB8, Compression, TiffEncoder};
    use tiff::tags::Tag;
    let w = BufWriter::new(File::create(path)?);
    let mut enc = TiffEncoder::new(w)?.with_compression(if lzw { Compression::Lzw } else { Compression::Uncompressed });
    let mut img = enc.new_image::<RGB8>(rgb.width(), rgb.height())?;
    if let Some(icc) = icc {
        img.encoder().write_tag(Tag::Unknown(34675), icc)?;
    }
    if let Some(x) = xmp {
        img.encoder().write_tag(Tag::Unknown(700), x.as_bytes())?;
    }
    img.write_data(rgb.as_raw())?;
    Ok(())
}

pub(crate) fn write_png(path: &Path, rgb: &RgbImage, icc: Option<&[u8]>) -> Result<()> {
    use image::ImageEncoder;
    let w = BufWriter::new(File::create(path)?);
    let mut enc = image::codecs::png::PngEncoder::new(w);
    if let Some(icc) = icc {
        let _ = enc.set_icc_profile(icc.to_vec());
    }
    enc.write_image(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)?;
    Ok(())
}

/// 轉存一個項目，回傳寫出的檔案
pub fn export_item(item: &Item, opts: &ExportOptions) -> Result<Vec<PathBuf>> {
    let src = load(item, &opts.formats).with_context(|| item.display().name.clone())?;
    let profile = source_profile(&src);
    let mut rgb = src.img.to_rgb8();

    // 色彩：轉 sRGB（來源本來就是 sRGB / 無描述檔時不動）；嵌入的描述檔跟著實際色彩空間走
    let mut icc: Option<Vec<u8>> = src.icc.clone();
    if opts.to_srgb {
        if let Some(p) = &profile {
            if convert_to_srgb(&mut rgb, p).is_ok() {
                icc = None;
            }
        }
        if icc.is_none() {
            icc = Some(srgb_icc().to_vec());
        }
    } else if icc.is_none() {
        // 原圖沒有嵌入描述檔：Adobe RGB 相機檔要補上，否則別的程式會當成 sRGB 而顏色變淡
        icc = Some(match &profile {
            Some(p) => p.encode().unwrap_or_else(|_| srgb_icc().to_vec()),
            None => srgb_icc().to_vec(),
        });
    }
    let icc = if opts.embed_icc { icc.filter(|v| !v.is_empty()) } else { None };

    let mut exif = src.exif.clone();
    if let Some(e) = exif.as_mut() {
        reset_orientation(e);
    }
    let m = meta::read_meta(item);
    let rl = xmp::RatingLabel { rating: Some(m.rating), label: m.label, edited: false };
    let xmp_packet = xmp::export_packet(Some(&rl), &opts.copyright);

    let base_dir = match &opts.dest {
        Some(d) => d.clone(),
        None => item.display().path.parent().map(Path::to_path_buf).unwrap_or_default(),
    };
    let stem = &item.display().stem;
    let mut written = Vec::new();
    for f in &opts.formats {
        let out_img = match target_size(rgb.width(), rgb.height(), f.fit) {
            Some((w, h)) => image::imageops::resize(&rgb, w, h, FilterType::Lanczos3),
            None => rgb.clone(),
        };
        let dir = base_dir.join(f.format.folder());
        fs::create_dir_all(&dir).with_context(|| dir.display().to_string())?;
        let path = unique_path(&dir, stem, f.format.ext());
        let r = match f.format {
            Format::Jpeg => write_jpeg(&path, &out_img, f.quality, icc.as_deref(), exif.as_deref(), xmp_packet.as_deref()),
            Format::Tiff => write_tiff(&path, &out_img, f.lzw, icc.as_deref(), xmp_packet.as_deref()),
            Format::Png => write_png(&path, &out_img, icc.as_deref()),
        };
        if let Err(e) = r {
            let _ = fs::remove_file(&path);
            return Err(e.context(format!("{} → {}", item.display().name, f.format.folder())));
        }
        written.push(path);
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_box() {
        assert_eq!(target_size(8640, 5760, Some((2400, 2400))), Some((2400, 1600)));
        assert_eq!(target_size(5760, 8640, Some((2400, 2400))), Some((1600, 2400)));
        assert_eq!(target_size(8640, 5760, Some((0, 1080))), Some((1620, 1080)));
        assert_eq!(target_size(1000, 800, Some((2400, 2400))), None); // 不放大
        assert_eq!(target_size(1000, 800, Some((0, 0))), None);
        assert_eq!(target_size(1000, 800, None), None);
    }

    #[test]
    fn quality_table() {
        assert_eq!(jpeg_quality(12), 98);
        assert_eq!(jpeg_quality(0), 20);
        assert_eq!(jpeg_quality(99), 98);
    }

    #[test]
    fn srgb_profile_roundtrip() {
        let icc = srgb_icc();
        assert!(icc.len() > 100);
        assert!(ColorProfile::new_from_slice(icc).is_ok());
    }

    #[test]
    fn adobe_to_srgb_changes_saturated_green() {
        // Adobe RGB 的純綠在 sRGB 之外：轉換後應被壓回（紅色分量 0、綠色 255 附近）且數值不同於原本
        let mut img = RgbImage::from_pixel(2, 2, image::Rgb([100, 200, 80]));
        convert_to_srgb(&mut img, &ColorProfile::new_adobe_rgb()).unwrap();
        let p = img.get_pixel(0, 0);
        assert_ne!(p.0, [100, 200, 80]);
    }

    #[test]
    fn orientation_reset() {
        // 最小 TIFF：II*\0, IFD0 at 8, 1 entry: 0x0112 SHORT count 1 value 6
        let mut e = vec![b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
        reset_orientation(&mut e);
        assert_eq!(e[18], 1);
    }

    #[test]
    fn export_jpeg_end_to_end() {
        let dir = std::env::temp_dir().join(format!("export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("A.jpg");
        let img = DynamicImage::ImageRgb8(RgbImage::from_fn(600, 400, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])));
        fs::write(&src, render::encode_jpeg(&img, 90).unwrap()).unwrap();
        let (items, _) = crate::scan::scan_dir(&dir).unwrap();
        let opts = ExportOptions {
            dest: None,
            formats: vec![
                FormatOptions { format: Format::Jpeg, fit: Some((300, 300)), quality: 10, lzw: false },
                FormatOptions { format: Format::Tiff, fit: None, quality: 10, lzw: true },
                FormatOptions { format: Format::Png, fit: Some((0, 100)), quality: 10, lzw: false },
            ],
            to_srgb: true,
            embed_icc: true,
            copyright: "© test".into(),
        };
        let out = export_item(&items[0], &opts).unwrap();
        assert_eq!(out.len(), 3);
        let j = image::open(&out[0]).unwrap();
        assert_eq!((j.width(), j.height()), (300, 200));
        let t = image::open(&out[1]).unwrap();
        assert_eq!((t.width(), t.height()), (600, 400));
        let p = image::open(&out[2]).unwrap();
        assert_eq!((p.width(), p.height()), (150, 100));
        // ICC 與 XMP 有寫進 JPEG
        let bytes = fs::read(&out[0]).unwrap();
        let mut d = jpeg_decoder::Decoder::new(std::io::Cursor::new(&bytes));
        d.decode().unwrap();
        assert!(d.icc_profile().is_some());
        assert!(String::from_utf8_lossy(d.xmp_data().unwrap()).contains("© test"));
        // 再轉一次不覆蓋
        let out2 = export_item(&items[0], &opts).unwrap();
        assert!(out2[0].file_name().unwrap().to_string_lossy().contains("A-1"));
        let _ = fs::remove_dir_all(&dir);
    }
}
