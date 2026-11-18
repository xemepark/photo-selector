//! 壓縮打包：把選取的照片打包成一個 ZIP 檔。
//!
//! - 有調整的 JPEG / 一般影像（設定開啟時）放入「已套用調整」的版本，檔名不變
//! - 可選擇連 RAW 一起打包（配對的 RAW、或只有 RAW 的照片）；.xmp 附屬檔不打包
//! - JPEG / RAW 等本來就壓縮過的檔案以「儲存」方式放入（再壓縮幾乎沒有效果，只會變慢），TIFF 等才壓縮
//! - 先寫到 .part 暫存檔，完成後才改成正式檔名，中途失敗不會留下壞掉的 ZIP

use crate::bake;
use crate::scan::{Class, Item};
use anyhow::{Context, Result};
use rayon::prelude::*;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

pub struct ZipResult {
    pub done: usize,
    pub failed: Vec<String>,
}

/// 一張照片要放進 ZIP 的檔案：(來源路徑, ZIP 裡的檔名, 是否為暫存檔)
fn entries_for(item: &Item, include_raw: bool, apply_edits: bool, tmp: &Path) -> Result<Vec<(PathBuf, String, bool)>> {
    let mut out = Vec::new();
    let disp = item.display();
    let is_raw_only = matches!(disp.class, Class::Raw | Class::Other);
    if !is_raw_only {
        if apply_edits && bake::needs_bake(item) {
            let dir = tmp.join(format!("{}", item.id));
            std::fs::create_dir_all(&dir)?;
            let p = bake::bake_to(item, &dir.join(&disp.name))?;
            let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
            out.push((p, name, true));
        } else {
            out.push((disp.path.clone(), disp.name.clone(), false));
        }
    }
    if include_raw || is_raw_only {
        for f in item.files.iter().filter(|f| f.class == Class::Raw) {
            out.push((f.path.clone(), f.name.clone(), false));
        }
    }
    Ok(out)
}

fn method_for(name: &str) -> CompressionMethod {
    let ext = Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "tif" | "tiff" | "bmp" => CompressionMethod::Deflated,
        _ => CompressionMethod::Stored,
    }
}

/// 打包。`progress(done, total)` 在每張照片處理完時呼叫
pub fn make_zip(
    items: &[Item],
    dest: &Path,
    include_raw: bool,
    apply_edits: bool,
    tmp_root: &Path,
    progress: impl Fn(usize, usize) + Sync,
) -> Result<ZipResult> {
    let tmp = tmp_root.join(format!("zip-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp)?;
    let total = items.len();
    let counter = std::sync::atomic::AtomicUsize::new(0);
    // 套用調整（解碼、編碼整張照片）比較花時間：最多 4 張同時處理
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads((std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 4))
        .build()?;
    let prepared: Vec<Result<Vec<(PathBuf, String, bool)>, String>> = pool.install(|| {
        items
            .par_iter()
            .map(|it| {
                let r = entries_for(it, include_raw, apply_edits, &tmp).map_err(|e| format!("{}：{e:#}", it.name));
                let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                progress(n, total);
                r
            })
            .collect()
    });

    let part = dest.with_extension("zip.part");
    let write = || -> Result<ZipResult> {
        let mut res = ZipResult { done: 0, failed: vec![] };
        let mut zw = zip::ZipWriter::new(BufWriter::new(File::create(&part).with_context(|| part.display().to_string())?));
        let mut used: HashSet<String> = HashSet::new();
        for r in &prepared {
            match r {
                Ok(list) => {
                    for (src, name, _) in list {
                        // 不同照片同名（極少見）時加上 _1、_2…
                        let mut n = name.clone();
                        let mut k = 1;
                        while !used.insert(n.to_lowercase()) {
                            let p = Path::new(name);
                            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("photo");
                            let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
                            n = format!("{stem}_{k}{ext}");
                            k += 1;
                        }
                        let mtime = std::fs::metadata(src)
                            .and_then(|m| m.modified())
                            .ok()
                            .map(|t| chrono_like(t))
                            .unwrap_or_default();
                        let opts = SimpleFileOptions::default()
                            .compression_method(method_for(&n))
                            .large_file(true)
                            .last_modified_time(mtime);
                        zw.start_file(n, opts)?;
                        std::io::copy(&mut BufReader::new(File::open(src)?), &mut zw)?;
                    }
                    res.done += 1;
                }
                Err(e) => res.failed.push(e.clone()),
            }
        }
        zw.finish()?.flush()?;
        Ok(res)
    };
    let out = write();
    let _ = std::fs::remove_dir_all(&tmp);
    match out {
        Ok(r) => {
            std::fs::rename(&part, dest).with_context(|| dest.display().to_string())?;
            Ok(r)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// SystemTime → ZIP 的日期時間（本地時間；ZIP 格式沒有時區）
fn chrono_like(t: std::time::SystemTime) -> zip::DateTime {
    let secs = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let offset = local_offset_secs();
    let s = secs + offset;
    let days = s.div_euclid(86_400);
    let rem = s.rem_euclid(86_400);
    // 由 1970-01-01 起算的日數換成年月日（Howard Hinnant 演算法）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    zip::DateTime::from_date_and_time(
        y.clamp(1980, 2107) as u16,
        m as u8,
        d as u8,
        (rem / 3600) as u8,
        (rem % 3600 / 60) as u8,
        (rem % 60) as u8,
    )
    .unwrap_or_default()
}

/// 本地時區與 UTC 的差（秒）。用 libc 的 localtime 取得（Unix）；其他平台視為 0
fn local_offset_secs() -> i64 {
    #[cfg(unix)]
    {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as libc::time_t).unwrap_or(0);
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        unsafe {
            libc::localtime_r(&now, &mut tm);
        }
        return tm.tm_gmtoff as i64;
    }
    #[allow(unreachable_code)]
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::Params;
    use image::{DynamicImage, RgbImage};
    use std::fs;
    use std::io::Read;

    #[test]
    fn zips_with_edits_and_optional_raw() {
        let dir = std::env::temp_dir().join(format!("zipout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let src = dir.join("src");
        fs::create_dir_all(&src).unwrap();
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 48, image::Rgb([80, 80, 80])));
        fs::write(src.join("E.jpg"), crate::render::encode_jpeg(&img, 95).unwrap()).unwrap();
        fs::write(src.join("小日子 P.jpg"), crate::render::encode_jpeg(&img, 95).unwrap()).unwrap();
        fs::write(src.join("R.JPG"), crate::render::encode_jpeg(&img, 95).unwrap()).unwrap();
        fs::write(src.join("R.NEF"), b"raw").unwrap();
        fs::write(src.join("Q.ARW"), b"raw only").unwrap();
        crate::xmp::update_jpeg_props(&src.join("E.jpg"), &Params { exposure: 1.0, ..Default::default() }.xmp_props()).unwrap();
        let (items, _) = crate::scan::scan_dir(&src).unwrap();

        let zip_path = dir.join("out.zip");
        let r = make_zip(&items, &zip_path, false, true, &dir.join("tmp"), |_, _| {}).unwrap();
        assert_eq!(r.done, items.len(), "{:?}", r.failed);
        assert!(!dir.join("out.zip.part").exists());
        let mut z = zip::ZipArchive::new(File::open(&zip_path).unwrap()).unwrap();
        let mut names: Vec<String> = (0..z.len()).map(|i| z.by_index(i).unwrap().name().to_string()).collect();
        names.sort();
        // 不含 RAW 時：JPEG 都在、配對的 RAW 不放、只有 RAW 的照片仍放 RAW
        assert_eq!(names, vec!["E.jpg", "Q.ARW", "R.JPG", "小日子 P.jpg"]);
        let mut buf = Vec::new();
        z.by_name("E.jpg").unwrap().read_to_end(&mut buf).unwrap();
        assert!(image::load_from_memory(&buf).unwrap().to_rgb8().get_pixel(5, 5)[0] > 110, "要套用調整");

        // 包含 RAW、不套用調整
        let zip2 = dir.join("out2.zip");
        make_zip(&items, &zip2, true, false, &dir.join("tmp"), |_, _| {}).unwrap();
        let mut z2 = zip::ZipArchive::new(File::open(&zip2).unwrap()).unwrap();
        assert!(z2.by_name("R.NEF").is_ok());
        let mut buf = Vec::new();
        z2.by_name("E.jpg").unwrap().read_to_end(&mut buf).unwrap();
        assert!(image::load_from_memory(&buf).unwrap().to_rgb8().get_pixel(5, 5)[0] < 90, "沒有套用調整");
        let _ = fs::remove_dir_all(&dir);
    }
}
