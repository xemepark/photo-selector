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
pub fn trash_items(items: &[&Item]) -> TransferResult {
    let mut res = TransferResult::default();
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        // 用系統 API 直接移到垃圾桶，不需要「控制 Finder」的權限詢問
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    for it in items {
        let paths: Vec<PathBuf> = it.all_paths().into_iter().filter(|p| p.exists()).collect();
        if paths.is_empty() {
            res.done += 1; // 檔案已經不在了，視同已刪除
            continue;
        }
        match ctx.delete_all(&paths) {
            Ok(()) => res.done += 1,
            Err(e) => res.failed.push(format!("{}：{e}", it.name)),
        }
    }
    res
}

pub fn transfer(items: &[&Item], dest: &Path, mv: bool) -> TransferResult {
    let mut res = TransferResult::default();
    if let Err(e) = fs::create_dir_all(dest) {
        res.failed.push(format!("{}：{e}", dest.display()));
        return res;
    }
    for it in items {
        let files = it.all_paths();
        let targets = target_names(&files, dest);
        let mut ok = true;
        for (src, dst) in files.iter().zip(&targets) {
            if src.parent() == Some(dest) && !mv {
                continue;
            }
            let r = if mv { move_file(src, dst) } else { copy_preserving(src, dst) };
            if let Err(e) = r {
                ok = false;
                res.failed.push(format!("{}：{e}", src.display()));
            }
        }
        if ok {
            res.done += 1;
        }
    }
    res
}
