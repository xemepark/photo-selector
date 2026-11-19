//! HEIC / HEIF（iPhone 照片）：用 macOS 內建的 sips 轉成 JPEG 後再解碼（HEVC 解碼器由系統提供）。
//! 轉好的 JPEG 放在暫存資料夾，依「路徑 + 修改時間 + 大小」快取，同一張只轉一次。
//! 轉出的 JPEG 保留 ICC（iPhone 多為 Display P3）與 EXIF，方向以轉出檔的 EXIF 為準。

use crate::scan::FileEntry;
use anyhow::{anyhow, Result};
use std::path::PathBuf;

pub fn is_heif(f: &FileEntry) -> bool {
    matches!(f.ext.as_str(), "heic" | "heif" | "hif")
}

fn cache_dir() -> PathBuf {
    std::env::temp_dir().join("photo-selector-heic")
}

/// 轉成 JPEG 的檔案路徑（已轉過就直接回傳）
pub fn jpeg_path(f: &FileEntry) -> Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    f.path.hash(&mut h);
    f.mtime.hash(&mut h);
    f.size.hash(&mut h);
    let dir = cache_dir();
    let out = dir.join(format!("{:016x}.jpg", h.finish()));
    if out.exists() {
        return Ok(out);
    }
    std::fs::create_dir_all(&dir)?;
    convert(&f.path, &out)?;
    Ok(out)
}

pub fn jpeg_bytes(f: &FileEntry) -> Result<Vec<u8>> {
    Ok(std::fs::read(jpeg_path(f)?)?)
}

#[cfg(target_os = "macos")]
fn convert(src: &std::path::Path, out: &std::path::Path) -> Result<()> {
    // 先寫暫存檔再改名：多個執行緒同時轉同一張時不會讀到寫一半的檔案
    let tmp = out.with_extension(format!("tmp{}-{:?}.jpg", std::process::id(), std::thread::current().id()).replace(['(', ')'], ""));
    let st = std::process::Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg", "-s", "formatOptions", "92"])
        .arg(src)
        .arg("--out")
        .arg(&tmp)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if !st.success() || !tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err(anyhow!("無法轉換 HEIC（sips 失敗）"));
    }
    std::fs::rename(&tmp, out)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn convert(_src: &std::path::Path, _out: &std::path::Path) -> Result<()> {
    Err(anyhow!("這台電腦無法讀取 HEIC（僅支援 macOS）"))
}

/// 轉出 JPEG 的 EXIF 方向（沒有 = 1）
pub fn orientation(f: &FileEntry) -> u16 {
    jpeg_bytes(f).ok().and_then(|b| crate::xmp::jpeg_exif_orientation(&b)).unwrap_or(1)
}
