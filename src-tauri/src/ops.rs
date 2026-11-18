//! 檔案操作：把選中的照片（連同配對的 RAW/JPEG 與 .xmp 附屬檔）複製或移動到其他資料夾。
//! 絕不覆蓋既有檔案：目標已存在時整組加上 _1、_2… 後綴，讓配對關係維持一致。

use crate::scan::Item;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Serialize, Default)]
pub struct TransferResult {
    pub done: usize,
    pub failed: Vec<String>,
}

fn target_names(files: &[PathBuf], dest: &Path) -> Vec<PathBuf> {
    let mut n = 0;
    loop {
        let names: Vec<PathBuf> = files
            .iter()
            .map(|p| {
                let stem = p.file_stem().unwrap_or_default().to_string_lossy();
                let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
                if n == 0 { dest.join(format!("{stem}{ext}")) } else { dest.join(format!("{stem}_{n}{ext}")) }
            })
            .collect();
        if names.iter().all(|p| !p.exists()) {
            return names;
        }
        n += 1;
    }
}

fn copy_preserving(src: &Path, dst: &Path) -> io::Result<()> {
    fs::copy(src, dst)?;
    if let Ok(md) = fs::metadata(src) {
        let _ = filetime::set_file_mtime(dst, filetime::FileTime::from_last_modification_time(&md));
    }
    Ok(())
}

fn move_file(src: &Path, dst: &Path) -> io::Result<()> {
    match fs::rename(src, dst) {
        Ok(()) => Ok(()),
        // 跨磁碟時 rename 會失敗，改成複製後刪除
        Err(_) => {
            copy_preserving(src, dst)?;
            fs::remove_file(src)
        }
    }
}

/// 把項目（含配對的 RAW/JPEG 與 .xmp 附屬檔）移到系統垃圾桶，可從垃圾桶復原。
///
/// macOS 先用系統 API（NSFileManager，不需額外權限）；若因隱私權保護（例如「桌面」「文件」
/// 資料夾）被拒絕，改請 Finder 代為移到垃圾桶（第一次會詢問是否允許控制 Finder）。
pub fn trash_items(items: &[&Item]) -> TransferResult {
    let mut res = TransferResult::default();
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    #[allow(unused_mut)]
    let mut retry: Vec<(&Item, Vec<PathBuf>, String)> = Vec::new();
    for it in items {
        let paths: Vec<PathBuf> = it.all_paths().into_iter().filter(|p| p.exists()).collect();
        if paths.is_empty() {
            res.done += 1; // 檔案已經不在了，視同已刪除
            continue;
        }
        match ctx.delete_all(&paths) {
            Ok(()) => res.done += 1,
            Err(e) => {
                // 部分檔案可能已經移走，只重試還在的
                let left: Vec<PathBuf> = paths.into_iter().filter(|p| p.exists()).collect();
                if left.is_empty() {
                    res.done += 1;
                } else {
                    retry.push((it, left, e.to_string()));
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    if !retry.is_empty() {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut finder = trash::TrashContext::default();
        finder.set_delete_method(DeleteMethod::Finder);
        // 一次交給 Finder，只會跳一次權限詢問、速度也快
        let all: Vec<PathBuf> = retry.iter().flat_map(|(_, p, _)| p.clone()).collect();
        let batch_ok = finder.delete_all(&all).is_ok();
        let mut still = Vec::new();
        for (it, paths, e) in retry {
            let left: Vec<PathBuf> = paths.into_iter().filter(|p| p.exists()).collect();
            if left.is_empty() {
                res.done += 1;
            } else if !batch_ok {
                match finder.delete_all(&left) {
                    Ok(()) => res.done += 1,
                    Err(e2) => still.push((it, format!("{e}；{e2}"))),
                }
            } else {
                still.push((it, e));
            }
        }
        for (it, e) in still {
            res.failed.push(format!("{}：{}", it.name, friendly_trash_error(&e)));
        }
        return res;
    }
    for (it, _, e) in retry {
        res.failed.push(format!("{}：{}", it.name, friendly_trash_error(&e)));
    }
    res
}

fn friendly_trash_error(e: &str) -> String {
    let lower = e.to_lowercase();
    if lower.contains("permission") || lower.contains("not permitted") || lower.contains("-1743") || lower.contains("not authorized") {
        "沒有權限".into()
    } else {
        e.chars().take(160).collect()
    }
}

pub fn transfer(items: &[&Item], dest: &Path, mv: bool, bake: bool) -> TransferResult {
    let mut res = TransferResult::default();
    if let Err(e) = fs::create_dir_all(dest) {
        res.failed.push(format!("{}：{e}", dest.display()));
        return res;
    }
    for it in items {
        let files = it.all_paths();
        let targets = target_names(&files, dest);
        // 有調整的 JPEG / 一般影像：在目的地輸出「已套用調整」的新檔案
        let baked = bake && crate::bake::needs_bake(it);
        let disp = it.display().path.clone();
        let mut ok = true;
        for (src, dst) in files.iter().zip(&targets) {
            if src.parent() == Some(dest) && !mv {
                continue;
            }
            let r = if baked && *src == disp {
                crate::bake::bake_to(it, dst).map(|_| ()).map_err(|e| io::Error::other(format!("{e:#}")))
            } else if mv {
                move_file(src, dst)
            } else {
                copy_preserving(src, dst)
            };
            if let Err(e) = r {
                ok = false;
                res.failed.push(format!("{}：{e}", src.display()));
            }
        }
        if baked && ok {
            // RAW+JPEG：JPEG 已套用調整，附屬檔裡的調整設定移除（RAW 維持原樣），避免重複套用
            if let Some(sc) = files.iter().zip(&targets).find(|(s, _)| s.extension().is_some_and(|e| e.eq_ignore_ascii_case("xmp"))) {
                crate::bake::strip_sidecar(sc.1);
            }
            // 移動：原本未調整的檔案移到垃圾桶（可以從垃圾桶救回）
            if mv && disp.parent() != Some(dest) {
                if let Err(e) = trash_paths(std::slice::from_ref(&disp)) {
                    res.failed.push(format!("{}：已輸出調整後的照片，但原檔無法移到垃圾桶（{e}）", disp.display()));
                }
            }
        }
        if ok {
            res.done += 1;
        }
    }
    res
}

/// 把檔案移到垃圾桶（macOS 被隱私權保護擋下時改請 Finder 代勞）
fn trash_paths(paths: &[PathBuf]) -> Result<(), String> {
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    match ctx.delete_all(paths) {
        Ok(()) => Ok(()),
        #[allow(unused_variables)]
        Err(e) => {
            #[cfg(target_os = "macos")]
            {
                use trash::macos::{DeleteMethod, TrashContextExtMacos};
                let left: Vec<PathBuf> = paths.iter().filter(|p| p.exists()).cloned().collect();
                let mut finder = trash::TrashContext::default();
                finder.set_delete_method(DeleteMethod::Finder);
                return finder.delete_all(&left).map_err(|e2| friendly_trash_error(&format!("{e}；{e2}")));
            }
            #[allow(unreachable_code)]
            Err(friendly_trash_error(&e.to_string()))
        }
    }
}

// ---------------------------------------------------------------- 重新命名（單張 / 批次）

pub enum RenameMode {
    /// 在相同資料夾中重新命名
    InPlace,
    /// 改名並移到其他資料夾
    Move(PathBuf),
    /// 改名並拷貝到其他資料夾（原檔不動）
    Copy(PathBuf),
}

fn new_path(dir: &Path, src: &Path, stem: &str) -> PathBuf {
    match src.extension() {
        Some(e) => dir.join(format!("{stem}.{}", e.to_string_lossy())),
        None => dir.join(stem),
    }
}

fn lower(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

/// 在 XMP 記錄原始檔名：JPEG 寫進檔案內；RAW 寫在附屬檔（沒有就建立）
fn preserve_names(it: &Item) -> io::Result<()> {
    use crate::scan::Class;
    if let Some(raw) = it.raw() {
        crate::xmp::preserve_name_sidecar(&it.sidecar_path(), &raw.name)?;
    }
    for f in it.files.iter().filter(|f| f.class == Class::Jpeg) {
        crate::xmp::preserve_name_jpeg(&f.path, &f.name)?;
    }
    Ok(())
}

/// 批次重新命名。`items` = (項目, 新的主檔名，不含副檔名)。
/// 配對的 RAW / JPEG 與 .xmp 附屬檔使用相同的新檔名，副檔名維持原樣。
/// 在相同資料夾改名時：先全部檢查，有任何衝突就完全不動；
/// 再分兩階段（先改成暫存名稱、再改成新名稱），名稱互換也不會出錯，失敗時還原。
pub fn batch_rename(items: &[(&Item, String)], mode: &RenameMode, preserve: bool, cache: &crate::cache::Cache) -> TransferResult {
    let mut res = TransferResult::default();
    if preserve {
        for (it, _) in items {
            if let Err(e) = preserve_names(it) {
                res.failed.push(format!("{}：無法寫入原始檔名（{e}）", it.name));
            }
        }
        if !res.failed.is_empty() {
            return res;
        }
    }

    match mode {
        RenameMode::InPlace => {
            let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
            for (it, stem) in items {
                for src in it.all_paths() {
                    let dir = src.parent().unwrap_or(Path::new(".")).to_path_buf();
                    let dst = new_path(&dir, &src, stem);
                    if dst != src {
                        plan.push((src, dst));
                    }
                }
            }
            // 檢查：新檔名不能重複，也不能撞到不在這次改名範圍內的既有檔案
            let srcs: std::collections::HashSet<String> = plan.iter().map(|(s, _)| lower(s)).collect();
            let mut seen = std::collections::HashSet::new();
            for (_, dst) in &plan {
                let name = dst.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if !seen.insert(lower(dst)) {
                    res.failed.push(format!("新檔名重複：{name}"));
                } else if dst.exists() && !srcs.contains(&lower(dst)) {
                    res.failed.push(format!("已有同名檔案：{name}"));
                }
            }
            if !res.failed.is_empty() {
                return res;
            }
            // 第一階段：改成暫存名稱
            let mut temps: Vec<(PathBuf, PathBuf, PathBuf)> = Vec::new();
            for (i, (src, dst)) in plan.iter().enumerate() {
                let tmp = src.with_file_name(format!(
                    ".ps-rename-{i}-{}",
                    src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
                ));
                if let Err(e) = fs::rename(src, &tmp) {
                    for (s, _, t) in temps.iter().rev() {
                        let _ = fs::rename(t, s);
                    }
                    res.failed.push(format!("{}：{e}", src.display()));
                    return res;
                }
                temps.push((src.clone(), dst.clone(), tmp));
            }
            // 第二階段：改成新名稱
            for (k, (src, dst, tmp)) in temps.iter().enumerate() {
                if let Err(e) = fs::rename(tmp, dst) {
                    res.failed.push(format!("{}：{e}", dst.display()));
                    // 還原：已完成的改回原名，其餘從暫存名稱改回
                    for (s, d, _) in &temps[..k] {
                        let _ = fs::rename(d, s);
                    }
                    for (s, _, t) in &temps[k..] {
                        let _ = fs::rename(t, s);
                    }
                    return res;
                }
                cache.rename_path(&src.to_string_lossy(), &dst.to_string_lossy());
            }
            res.done = items.len();
        }
        RenameMode::Move(dest) | RenameMode::Copy(dest) => {
            let mv = matches!(mode, RenameMode::Move(_));
            if let Err(e) = fs::create_dir_all(dest) {
                res.failed.push(format!("{}：{e}", dest.display()));
                return res;
            }
            for (it, stem) in items {
                let pairs: Vec<(PathBuf, PathBuf)> =
                    it.all_paths().into_iter().map(|src| { let d = new_path(dest, &src, stem); (src, d) }).collect();
                if let Some((_, d)) = pairs.iter().find(|(_, d)| d.exists()) {
                    res.failed.push(format!("{}：目的地已有同名檔案 {}", it.name, d.display()));
                    continue;
                }
                let mut ok = true;
                for (src, dst) in &pairs {
                    let r = if mv { move_file(src, dst) } else { copy_preserving(src, dst) };
                    match r {
                        Ok(()) if mv => cache.rename_path(&src.to_string_lossy(), &dst.to_string_lossy()),
                        Ok(()) => {}
                        Err(e) => {
                            ok = false;
                            res.failed.push(format!("{}：{e}", src.display()));
                        }
                    }
                }
                if ok {
                    res.done += 1;
                }
            }
        }
    }
    res
}

/// 在 Finder（Windows：檔案總管）中顯示並選取檔案
pub fn reveal(path: &Path) -> io::Result<()> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg("-R").arg(path).status()?;
    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(format!("/select,{}", path.display())).status()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(path.parent().unwrap_or(path)).status()?;
    if status.success() || cfg!(target_os = "windows") {
        Ok(())
    } else {
        Err(io::Error::other(format!("無法開啟（{status}）")))
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;

    #[test]
    fn swaps_pairs_and_rejects_conflicts() {
        let dir = std::env::temp_dir().join(format!("ps-ren-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        for n in ["A.CR2", "A.JPG", "A.xmp", "B.jpg", "C.jpg"] {
            fs::write(dir.join(n), n).unwrap();
        }
        let cache = crate::cache::Cache::open(&dir.join("cache")).unwrap();
        let (items, _) = crate::scan::scan_dir(&dir).unwrap();
        let by = |n: &str| items.iter().find(|i| i.name == n).unwrap();
        // 衝突：B 改成 C（C 不在改名範圍）→ 完全不動
        let r = batch_rename(&[(by("B"), "C".into())], &RenameMode::InPlace, false, &cache);
        assert_eq!(r.done, 0);
        assert!(r.failed[0].contains("已有同名檔案"));
        assert!(dir.join("B.jpg").exists());
        // 互換：A ↔ B（A 是 RAW+JPEG 配對含附屬檔）
        let r = batch_rename(&[(by("A"), "B".into()), (by("B"), "A".into())], &RenameMode::InPlace, false, &cache);
        assert_eq!((r.done, r.failed.len()), (2, 0), "{:?}", r.failed);
        assert_eq!(fs::read_to_string(dir.join("B.CR2")).unwrap(), "A.CR2");
        assert_eq!(fs::read_to_string(dir.join("B.JPG")).unwrap(), "A.JPG");
        assert_eq!(fs::read_to_string(dir.join("B.xmp")).unwrap(), "A.xmp");
        assert_eq!(fs::read_to_string(dir.join("A.jpg")).unwrap(), "B.jpg");
        assert!(fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".ps-rename")));
        fs::remove_dir_all(&dir).unwrap();
    }
}

/// 用系統的檔案管理員開啟資料夾（macOS：Finder）
pub fn open_dir(dir: &Path) -> io::Result<()> {
    if !dir.is_dir() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "找不到這個資料夾"));
    }
    open_with_system(dir.as_os_str())
}

/// 用預設瀏覽器開啟小日子寫真館網站（固定網址，不接受其他網址）
pub fn open_website() -> io::Result<()> {
    open_url(crate::WEBSITE)
}

/// 用預設瀏覽器開啟網址（呼叫端只會傳入程式內建、固定的網址）
pub fn open_url(url: &str) -> io::Result<()> {
    open_with_system(std::ffi::OsStr::new(url))
}

fn open_with_system(target: &std::ffi::OsStr) -> io::Result<()> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = Command::new("xdg-open");
    cmd.arg(target).spawn().map(|_| ())
}

#[cfg(test)]
mod transfer_bake_tests {
    use super::*;
    use crate::edit::Params;
    use crate::xmp;
    use image::{DynamicImage, RgbImage};

    fn jpg(path: &Path, v: u8) {
        let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(64, 48, image::Rgb([v, v, v])));
        fs::write(path, crate::render::encode_jpeg(&img, 95).unwrap()).unwrap();
    }

    #[test]
    fn copy_and_move_apply_edits() {
        let dir = std::env::temp_dir().join(format!("transfer-bake-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let (src, out_c, out_m) = (dir.join("src"), dir.join("copy"), dir.join("move"));
        fs::create_dir_all(&src).unwrap();
        jpg(&src.join("E.jpg"), 80); // 有調整
        jpg(&src.join("P.jpg"), 80); // 沒調整
        jpg(&src.join("R.JPG"), 80); // RAW+JPEG 配對、有調整
        fs::write(src.join("R.NEF"), b"fake raw").unwrap();
        let p = Params { exposure: 1.0, ..Default::default() };
        xmp::update_jpeg_props(&src.join("E.jpg"), &p.xmp_props()).unwrap();
        xmp::update_jpeg_props(&src.join("R.JPG"), &p.xmp_props()).unwrap();
        xmp::update_props(&src.join("R.xmp"), &p.xmp_props()).unwrap();
        let (items, _) = crate::scan::scan_dir(&src).unwrap();
        let refs: Vec<&Item> = items.iter().collect();

        // 複製：E、R 輸出變亮的 JPEG，P 原樣；RAW 原樣、附屬檔的調整移除；原檔都還在
        let r = transfer(&refs, &out_c, false, true);
        assert_eq!(r.done, 3, "{:?}", r.failed);
        let bright = |p: &Path| image::open(p).unwrap().to_rgb8().get_pixel(5, 5)[0];
        assert!(bright(&out_c.join("E.jpg")) > 110);
        assert!(bright(&out_c.join("R.JPG")) > 110);
        assert!(bright(&out_c.join("P.jpg")) < 90);
        assert_eq!(fs::read(out_c.join("R.NEF")).unwrap(), b"fake raw");
        assert!(!fs::read_to_string(out_c.join("R.xmp")).unwrap().contains("sd:"));
        assert!(xmp::read_jpeg_xml(&out_c.join("E.jpg")).map_or(true, |x| !x.contains("sd:")));
        assert!(src.join("E.jpg").exists() && src.join("R.NEF").exists());
        // 目的地的照片不會被重複套用調整
        let (copied, _) = crate::scan::scan_dir(&out_c).unwrap();
        assert!(copied.iter().all(|i| crate::edit::load(i).is_none()));

        // 關閉套用：原檔照搬（調整設定跟著走）
        let out_raw = dir.join("raw");
        transfer(&refs, &out_raw, false, false);
        assert!(bright(&out_raw.join("E.jpg")) < 90);
        assert!(xmp::read_jpeg_xml(&out_raw.join("E.jpg")).unwrap().contains("sd:Exposure"));

        // 移動：只移動 E → 目的地是調整後的照片，原檔不在原處（進了垃圾桶）
        let e: Vec<&Item> = items.iter().filter(|i| i.name == "E").collect();
        let r = transfer(&e, &out_m, true, true);
        assert_eq!(r.done, 1, "{:?}", r.failed);
        assert!(bright(&out_m.join("E.jpg")) > 110);
        assert!(!src.join("E.jpg").exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
