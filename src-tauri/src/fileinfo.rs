//! 狀態列的檔案資訊：格式、檔案大小、建立 / 修改時間、色彩空間

use crate::scan::{Class, Item};
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

#[derive(Serialize)]
pub struct FilePart {
    /// 副檔名（大寫）
    pub ext: String,
    pub size: u64,
}

#[derive(Serialize)]
pub struct FileInfo {
    pub parts: Vec<FilePart>,
    /// 建立時間（毫秒；檔案系統不支援時為 null）
    pub created: Option<i64>,
    pub modified: Option<i64>,
    pub color_space: Option<String>,
    /// 從檔頭讀到的像素尺寸（已依方向轉正；EXIF 沒寫尺寸的照片用）
    pub width: Option<u32>,
    pub height: Option<u32>,
}

fn pixel_size(path: &Path, class: Class) -> Option<(u32, u32)> {
    let file = File::open(path).ok()?;
    let data = unsafe { memmap2::Mmap::map(&file) }.ok()?;
    let (w, h) = match class {
        Class::Jpeg => crate::jpeg::jpeg_dims(&data)?,
        Class::Image => image::ImageReader::new(std::io::Cursor::new(&data[..])).with_guessed_format().ok()?.into_dimensions().ok()?,
        _ => return None,
    };
    let o = crate::meta::orientation(class, &data);
    Some(if matches!(o, 5..=8) { (h, w) } else { (w, h) })
}

fn format_name(ext: &str) -> String {
    match ext.to_uppercase().as_str() {
        "JPG" | "JPE" => "JPEG".into(),
        "TIF" => "TIFF".into(),
        e => e.to_string(),
    }
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// ICC 描述檔的名稱（例如「Adobe RGB (1998)」「Display P3」）
pub fn icc_name(icc: &[u8]) -> Option<String> {
    use moxcms::ProfileText;
    let p = moxcms::ColorProfile::new_from_slice(icc).ok()?;
    let s = match p.description? {
        ProfileText::PlainString(s) => s,
        ProfileText::Localizable(v) => {
            v.iter().find(|l| l.language == "en").or(v.first()).map(|l| l.value.clone())?
        }
        ProfileText::Description(d) => {
            if d.ascii_string.trim().is_empty() { d.unicode_string } else { d.ascii_string }
        }
    };
    let s = s.trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string();
    (!s.is_empty()).then_some(s)
}

fn icc_of(path: &Path, class: Class) -> Option<Vec<u8>> {
    match class {
        Class::Jpeg => {
            // 只讀檔頭（ICC 在影像資料之前）
            let mut buf = vec![0u8; 512 * 1024];
            let n = File::open(path).ok()?.read(&mut buf).ok()?;
            buf.truncate(n);
            let mut d = jpeg_decoder::Decoder::new(std::io::Cursor::new(&buf));
            d.read_info().ok()?;
            d.icc_profile()
        }
        Class::Image => {
            use image::ImageDecoder;
            let r = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?;
            r.into_decoder().ok()?.icc_profile().ok().flatten()
        }
        _ => None,
    }
}

/// 從 EXIF 判斷：ColorSpace 1 = sRGB；未校正 + InteropIndex R03 = Adobe RGB
fn exif_color_space(path: &Path) -> Option<String> {
    let f = File::open(path).ok()?;
    let ex = exif::Reader::new().read_from_container(&mut BufReader::new(f)).ok()?;
    let cs = ex.get_field(exif::Tag::ColorSpace, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0));
    let interop = ex
        .get_field(exif::Tag::InteroperabilityIndex, exif::In::PRIMARY)
        .map(|f| f.display_value().to_string())
        .unwrap_or_default();
    match cs {
        Some(1) => Some("sRGB".into()),
        Some(2) => Some("Adobe RGB".into()),
        _ if interop.contains("R03") => Some("Adobe RGB".into()),
        Some(0xFFFF) => Some("未校正".into()),
        _ => None,
    }
}

pub fn file_info(item: &Item) -> FileInfo {
    let disp = item.display();
    let mut files: Vec<_> = item.files.iter().filter(|f| matches!(f.class, Class::Raw | Class::Jpeg | Class::Image)).collect();
    if files.is_empty() {
        files = item.files.iter().collect();
    }
    // RAW 放前面（RAW+JPEG → 「ARW + JPG」）
    files.sort_by_key(|f| f.class != Class::Raw);
    let parts = files.iter().map(|f| FilePart { ext: format_name(&f.ext), size: f.size }).collect();

    let md = std::fs::metadata(&disp.path).ok();
    let created = md.as_ref().and_then(|m| ms(m.created()));
    let modified = md.as_ref().and_then(|m| ms(m.modified()));

    let mut color_space = icc_of(&disp.path, disp.class).as_deref().and_then(icc_name);
    if color_space.is_none() {
        color_space = exif_color_space(&disp.path);
    }
    if color_space.is_none() {
        if let Some(raw) = item.raw() {
            color_space = exif_color_space(&raw.path);
        }
    }
    let size = pixel_size(&disp.path, disp.class);
    FileInfo { parts, created, modified, color_space, width: size.map(|s| s.0), height: size.map(|s| s.1) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(icc_name(&crate::icc::srgb_v2()).as_deref(), Some("sRGB IEC61966-2.1"));
        let adobe = moxcms::ColorProfile::new_adobe_rgb().encode().unwrap();
        assert!(icc_name(&adobe).is_some());
    }

    #[test]
    fn jpeg_icc_from_header() {
        let dir = std::env::temp_dir().join(format!("fileinfo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.jpg");
        let mut buf = Vec::new();
        let mut enc = jpeg_encoder::Encoder::new(&mut buf, 80);
        enc.add_icc_profile(&crate::icc::srgb_v2()).unwrap();
        enc.encode(&[128u8; 16 * 16 * 3], 16, 16, jpeg_encoder::ColorType::Rgb).unwrap();
        std::fs::write(&p, buf).unwrap();
        let icc = icc_of(&p, Class::Jpeg).unwrap();
        assert_eq!(icc_name(&icc).as_deref(), Some("sRGB IEC61966-2.1"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
