//! 掃描資料夾、分類檔案、把同名的 RAW + JPEG 配對成一個項目，並掛上 .xmp 附屬檔。

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Class {
    Raw,
    Jpeg,
    Image,
    Other,
}

pub const RAW_EXTS: &[&str] = &[
    "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "dng", "srw",
    "x3f", "3fr", "iiq", "erf", "mef", "mos", "kdc", "rwl",
];

pub fn classify(ext: &str) -> Option<Class> {
    if RAW_EXTS.contains(&ext) {
        return Some(Class::Raw);
    }
    match ext {
        "jpg" | "jpeg" | "jpe" => Some(Class::Jpeg),
        "png" | "tif" | "tiff" | "webp" | "gif" | "bmp" => Some(Class::Image),
        "heic" | "heif" | "avif" | "psd" | "psb" => Some(Class::Other),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct FileEntry {
    pub path: PathBuf,
    pub name: String,
    pub stem: String,
    pub ext: String,
    pub class: Class,
    pub size: u64,
    /// 修改時間（毫秒）
    pub mtime: i64,
}

impl FileEntry {
    /// 用於快取的鍵值：路徑 + 修改時間 + 大小，任何一個變了快取就失效
    pub fn cache_key(&self) -> (String, i64, i64) {
        let mut k = self.path.to_string_lossy().into_owned();
        // 透明 PNG 改成疊白底、HEIC 改用系統轉檔：這兩類的舊縮圖快取作廢重算
        if matches!(self.class, Class::Image | Class::Other) {
            k.push_str("#r2");
        }
        (k, self.mtime, self.size as i64)
    }
}

#[derive(Clone, Debug)]
pub struct Item {
    pub id: u32,
    pub name: String,
    pub kind: &'static str,
    pub files: Vec<FileEntry>,
    pub sidecar: Option<PathBuf>,
}

impl Item {
    fn by_class(&self, c: Class) -> Option<&FileEntry> {
        self.files.iter().find(|f| f.class == c)
    }
    /// 用來顯示縮圖 / 預覽的檔案：有相機直出 JPEG 就用 JPEG（最快、顏色也是相機算的）
    pub fn display(&self) -> &FileEntry {
        self.by_class(Class::Jpeg)
            .or_else(|| self.by_class(Class::Image))
            .or_else(|| self.by_class(Class::Raw))
            .unwrap_or(&self.files[0])
    }
    pub fn raw(&self) -> Option<&FileEntry> {
        self.by_class(Class::Raw)
    }
    /// XMP 附屬檔路徑（Adobe 慣例：IMG_0001.CR2 → IMG_0001.xmp）
    pub fn sidecar_path(&self) -> PathBuf {
        if let Some(s) = &self.sidecar {
            return s.clone();
        }
        let f = self.raw().unwrap_or_else(|| self.display());
        f.path.with_file_name(format!("{}.xmp", f.stem))
    }
    /// 項目包含的所有實體檔案（含已存在的附屬檔），供複製 / 移動使用
    pub fn all_paths(&self) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = self.files.iter().map(|f| f.path.clone()).collect();
        let sc = self.sidecar_path();
        if sc.exists() {
            v.push(sc);
        }
        v
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct DirInfo {
    pub name: String,
    pub path: String,
}

pub fn natural_key(s: &str) -> Vec<(u8, u64, String)> {
    // 讓 IMG_2.jpg 排在 IMG_10.jpg 前面
    let mut out = Vec::new();
    let mut num = String::new();
    let mut txt = String::new();
    for ch in s.to_lowercase().chars() {
        if ch.is_ascii_digit() {
            if !txt.is_empty() {
                out.push((1, 0, std::mem::take(&mut txt)));
            }
            num.push(ch);
        } else {
            if !num.is_empty() {
                out.push((0, num.parse().unwrap_or(u64::MAX), std::mem::take(&mut num)));
            }
            txt.push(ch);
        }
    }
    if !num.is_empty() {
        out.push((0, num.parse().unwrap_or(u64::MAX), num));
    }
    if !txt.is_empty() {
        out.push((1, 0, txt));
    }
    out
}

/// 修改時間（毫秒），與快取鍵值使用同一種算法
pub fn mtime_ms(md: &fs::Metadata) -> i64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn scan_dir(dir: &Path) -> io::Result<(Vec<Item>, Vec<DirInfo>)> {
    let mut groups: HashMap<String, Vec<FileEntry>> = HashMap::new();
    let mut sidecars: HashMap<String, PathBuf> = HashMap::new();
    let mut subdirs = Vec::new();

    for entry in fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            subdirs.push(DirInfo { name, path: path.to_string_lossy().into_owned() });
            continue;
        }
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if ext == "xmp" {
            sidecars.insert(stem.to_lowercase(), path);
            continue;
        }
        let Some(class) = classify(&ext) else { continue };
        let Ok(md) = entry.metadata() else { continue };
        let mtime = mtime_ms(&md);
        groups.entry(stem.to_lowercase()).or_default().push(FileEntry {
            path,
            name,
            stem,
            ext,
            class,
            size: md.len(),
            mtime,
        });
    }

    let mut items: Vec<Item> = Vec::new();
    for (key, mut files) in groups {
        files.sort_by(|a, b| a.name.cmp(&b.name));
        let raws = files.iter().filter(|f| f.class == Class::Raw).count();
        let jpgs = files.iter().filter(|f| f.class == Class::Jpeg).count();
        let mut sidecar = sidecars.remove(&key);
        let mut push = |files: Vec<FileEntry>, sidecar: Option<PathBuf>| {
            let kind = match (files.len(), files[0].class) {
                (2, _) => "raw+jpeg",
                (_, Class::Raw) => "raw",
                (_, Class::Jpeg) => "jpeg",
                (_, Class::Image) => "image",
                _ => "other",
            };
            items.push(Item { id: 0, name: files[0].stem.clone(), kind, files, sidecar });
        };
        if raws == 1 && jpgs == 1 {
            let (pair, rest): (Vec<_>, Vec<_>) =
                files.into_iter().partition(|f| matches!(f.class, Class::Raw | Class::Jpeg));
            push(pair, sidecar.take());
            for f in rest {
                push(vec![f], None);
            }
        } else {
            // 附屬檔優先掛在 RAW 上
            files.sort_by_key(|f| f.class != Class::Raw);
            for f in files {
                push(vec![f], sidecar.take());
            }
        }
    }

    items.sort_by_cached_key(|it| natural_key(&it.files[0].name));
    for (i, it) in items.iter_mut().enumerate() {
        it.id = i as u32;
    }
    subdirs.sort_by_cached_key(|d| natural_key(&d.name));
    Ok((items, subdirs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_raw_and_jpeg_and_attaches_sidecar() {
        let dir = std::env::temp_dir().join(format!("ps-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        for n in ["IMG_10.CR2", "IMG_10.JPG", "IMG_10.xmp", "IMG_2.jpg", "notes.txt", "a.png"] {
            fs::write(dir.join(n), b"x").unwrap();
        }
        let (items, subdirs) = scan_dir(&dir).unwrap();
        let names: Vec<_> = items.iter().map(|i| (i.name.as_str(), i.kind)).collect();
        assert_eq!(names, vec![("a", "image"), ("IMG_2", "jpeg"), ("IMG_10", "raw+jpeg")]);
        assert_eq!(items[2].display().ext, "jpg");
        assert!(items[2].sidecar.is_some());
        assert_eq!(subdirs.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
