//! 複製 / 移動時「套用調整」：把有調整的照片輸出成已套用調整的新檔案。
//!
//! - JPEG → JPEG（品質 96、4:4:4），保留 EXIF（方向改為正常）、ICC 描述檔、原本的 XMP（評等、標籤、關鍵字…）；
//!   XMP 裡的調整設定（sd:）會移除，避免在本程式裡被套用兩次
//! - PNG → PNG、TIFF → TIFF（LZW）；HEIC 等無法寫回的格式 → JPEG（副檔名改為 .jpg）
//! - RAW 無法寫入調整：不在這裡處理（照原樣複製，調整設定跟著附屬檔走）

use crate::edit::Params;
use crate::export;
use crate::scan::{Class, Item};
use crate::xmp;
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// 這個項目是否需要「套用調整後輸出」：有調整、而且顯示用的檔案是 JPEG / 一般影像
pub fn needs_bake(item: &Item) -> bool {
    matches!(item.display().class, Class::Jpeg | Class::Image) && crate::edit::load(item).is_some()
}

/// 調整設定與方向屬性從 XMP 移除（影像已經轉正、調整已經套用）
fn strip_edit_xml(xml: &str) -> String {
    let mut x = xml.trim_end_matches(['\0', ' ', '\n', '\r', '\t']).to_string();
    let mut props = Params::default().xmp_props();
    props.push(("tiff:Orientation", None));
    xmp::apply_props(&mut x, &props);
    x
}

/// 移除附屬檔裡的調整設定（RAW+JPEG 配對：JPEG 已經套用調整，RAW 維持原樣）
pub fn strip_sidecar(path: &Path) {
    if path.exists() {
        let _ = xmp::update_props(path, &Params::default().xmp_props());
    }
}

/// 輸出套用調整後的影像到 `dst`（副檔名可能改成 .jpg），回傳實際寫入的路徑。保留原檔的修改時間。
pub fn bake_to(item: &Item, dst: &Path) -> Result<PathBuf> {
    let f = item.display();
    let src = export::load(item, &[]).with_context(|| f.name.clone())?;
    let rgb = src.img.to_rgb8();
    let mut exif = src.exif.clone();
    if let Some(e) = exif.as_mut() {
        export::reset_orientation(e);
    }
    let xmp_xml = match f.class {
        Class::Jpeg => xmp::read_jpeg_xml(&f.path).map(|x| strip_edit_xml(&x)),
        _ => None,
    }
    .filter(|x| x.len() < 60_000);
    let ext = dst.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let out = match ext.as_str() {
        "jpg" | "jpeg" | "jpe" | "png" | "tif" | "tiff" => dst.to_path_buf(),
        _ => {
            // 無法寫回原格式（HEIC、WebP…）→ 輸出 JPEG，避開同名檔案
            let base = dst.with_extension("jpg");
            let mut p = base.clone();
            let mut n = 1;
            while p.exists() {
                let stem = base.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
                p = base.with_file_name(format!("{stem}_{n}.jpg"));
                n += 1;
            }
            p
        }
    };
    let icc = src.icc.as_deref();
    let r = match out.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => export::write_png(&out, &rgb, icc),
        "tif" | "tiff" => export::write_tiff(&out, &rgb, true, icc, xmp_xml.as_deref()),
        _ => export::write_jpeg(&out, &rgb, 11, icc, exif.as_deref(), xmp_xml.as_deref()),
    };
    if let Err(e) = r {
        let _ = std::fs::remove_file(&out);
        return Err(e.context(f.name.clone()));
    }
    if let Ok(md) = std::fs::metadata(&f.path) {
        let _ = filetime::set_file_mtime(&out, filetime::FileTime::from_last_modification_time(&md));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, RgbImage};
    use std::fs;

    #[test]
    fn bake_applies_edit_and_strips_settings() {
        let dir = std::env::temp_dir().join(format!("bake-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("out")).unwrap();
        let src = dir.join("A.jpg");
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 48, image::Rgb([80, 80, 80])));
        fs::write(&src, crate::render::encode_jpeg(&img, 95).unwrap()).unwrap();
        // 評等 + 曝光 +1
        xmp::update_jpeg(&src, Some(4), None).unwrap();
        let p = Params { exposure: 1.0, ..Default::default() };
        xmp::update_jpeg_props(&src, &p.xmp_props()).unwrap();
        let (items, _) = crate::scan::scan_dir(&dir).unwrap();
        let it = items.iter().find(|i| i.name == "A").unwrap();
        assert!(needs_bake(it));
        let out = bake_to(it, &dir.join("out/A.jpg")).unwrap();
        let baked = image::open(&out).unwrap().to_rgb8();
        assert!(baked.get_pixel(10, 10)[0] > 110, "曝光 +1 應該變亮");
        // 評等保留、調整設定移除（不會再被套用一次）
        let xml = xmp::read_jpeg_xml(&out).unwrap();
        assert!(xml.contains("xmp:Rating=\"4\""));
        assert!(!xml.contains("sd:"));
        let _ = fs::remove_dir_all(&dir);
    }
}

/// 拖曳到其他程式用：把套用調整後的照片放在暫存資料夾（同一張、同一組調整只做一次）。
/// 檔名與原檔相同，對方程式收到的名稱不變。
pub fn cached(item: &Item, root: &Path) -> Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    let f = item.display();
    let p = crate::edit::load(item).unwrap_or_default();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    f.path.hash(&mut h);
    f.mtime.hash(&mut h);
    f.size.hash(&mut h);
    format!("{:?}", p.xmp_props()).hash(&mut h);
    let dir = root.join(format!("{:016x}", h.finish()));
    if let Ok(rd) = std::fs::read_dir(&dir) {
        if let Some(done) = rd.flatten().map(|e| e.path()).find(|p| !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(".tmp"))) {
            return Ok(done);
        }
    }
    // 先寫到暫存子資料夾再搬過去：背景預先處理與拖曳同時進行時，不會拿到寫一半的檔案
    let tmp = root.join(format!(".tmp-{:016x}-{}", h.finish(), std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let out = bake_to(item, &tmp.join(&f.name))?;
    std::fs::create_dir_all(&dir)?;
    let final_path = dir.join(out.file_name().unwrap_or_default());
    std::fs::rename(&out, &final_path).or_else(|_| std::fs::copy(&out, &final_path).map(|_| ()))?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(final_path)
}
