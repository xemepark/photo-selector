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
    /// 文字檔（.txt / .md / .rtf）
    Text,
    /// 影片（.mp4 / .mov / .m4v）
    Video,
}

pub const RAW_EXTS: &[&str] = &[
    "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "dng", "srw",
    "x3f", "3fr", "iiq", "erf", "mef", "mos", "kdc", "rwl",
];

/// 副檔名是 RAW 檔
pub fn is_raw_path(p: &Path) -> bool {
    p.extension().is_some_and(|e| RAW_EXTS.contains(&e.to_string_lossy().to_ascii_lowercase().as_str()))
}

pub fn classify(ext: &str) -> Option<Class> {
    if RAW_EXTS.contains(&ext) {
        return Some(Class::Raw);
    }
    match ext {
        "jpg" | "jpeg" | "jpe" => Some(Class::Jpeg),
        "png" | "tif" | "tiff" | "webp" | "gif" | "bmp" => Some(Class::Image),
        "heic" | "heif" | "avif" | "psd" | "psb" => Some(Class::Other),
        e if crate::text::TEXT_EXTS.contains(&e) => Some(Class::Text),
        e if crate::video::VIDEO_EXTS.contains(&e) => Some(Class::Video),
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
    /// 開資料夾時檔案還在 iCloud 上（只有雲端的空殼，讀取會觸發下載）
    pub cloud: bool,
}

/// macOS：檔案是否只有 iCloud 上的空殼（st_flags 的 SF_DATALESS）。取得 metadata 不會觸發下載
pub fn is_dataless(md: &fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        const SF_DATALESS: u32 = 0x4000_0000;
        md.st_flags() & SF_DATALESS != 0
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = md;
        false
    }
}

/// 現在（而不是開資料夾當時）這個檔案是否還在 iCloud 上
pub fn path_is_dataless(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| is_dataless(&m)).unwrap_or(false)
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
    /// 「含子資料夾」時，所在的子資料夾（相對於開啟的資料夾，"" = 就在開啟的資料夾）
    pub sub: String,
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
    /// 有任何一個檔案還在 iCloud 上（以現在的狀態為準）
    pub fn in_cloud_now(&self) -> bool {
        self.files.iter().any(|f| f.cloud && path_is_dataless(&f.path))
    }
    pub fn is_text(&self) -> bool {
        self.files[0].class == Class::Text
    }
    pub fn is_video(&self) -> bool {
        self.files[0].class == Class::Video
    }
    /// 文字檔與影片：不和同名照片配對，附屬檔以完整檔名命名
    pub fn is_standalone(&self) -> bool {
        matches!(self.files[0].class, Class::Text | Class::Video)
    }
    pub fn raw(&self) -> Option<&FileEntry> {
        self.by_class(Class::Raw)
    }
    /// XMP 附屬檔路徑（Adobe 慣例：IMG_0001.CR2 → IMG_0001.xmp）
    pub fn sidecar_path(&self) -> PathBuf {
        if let Some(s) = &self.sidecar {
            return s.clone();
        }
        // 文字檔 / 影片：附屬檔名稱包含副檔名（notes.txt → notes.txt.xmp），不會和同名照片的附屬檔混在一起
        if self.is_standalone() {
            let f = &self.files[0];
            return f.path.with_file_name(format!("{}.xmp", f.name));
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
    /// 資料夾的評等 / 標籤（存在資料夾裡的隱藏檔 FOLDER_XMP）
    pub rating: i32,
    pub label: Option<String>,
}

/// 資料夾評等 / 標籤存放的隱藏檔（跟著資料夾移動）
pub const FOLDER_XMP: &str = ".photoselector-folder.xmp";

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

/// 加入時間（毫秒）：macOS 的「加入日期」（檔案放進這個資料夾的時間，Finder 同一欄）；
/// 取不到時用建立時間，再取不到用修改時間
pub fn added_ms(path: &Path) -> i64 {
    #[cfg(target_os = "macos")]
    if let Some(t) = mac_added_time(path) {
        return t;
    }
    let md = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    md.created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(|| mtime_ms(&md))
}

#[cfg(target_os = "macos")]
fn mac_added_time(path: &Path) -> Option<i64> {
    use std::os::unix::ffi::OsStrExt;
    #[repr(C)]
    struct AttrList {
        bitmapcount: u16,
        reserved: u16,
        commonattr: u32,
        volattr: u32,
        dirattr: u32,
        fileattr: u32,
        forkattr: u32,
    }
    extern "C" {
        fn getattrlist(path: *const libc::c_char, list: *mut AttrList, buf: *mut libc::c_void, size: libc::size_t, options: libc::c_ulong) -> libc::c_int;
    }
    const ATTR_CMN_RETURNED_ATTRS: u32 = 0x8000_0000;
    const ATTR_CMN_ADDEDTIME: u32 = 0x1000_0000;
    const FSOPT_NOFOLLOW: libc::c_ulong = 1;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut list = AttrList { bitmapcount: 5, reserved: 0, commonattr: ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_ADDEDTIME, volattr: 0, dirattr: 0, fileattr: 0, forkattr: 0 };
    // 回傳：u32 長度、attribute_set_t（5 × u32）、timespec（有回傳時）
    let mut buf = [0u8; 64];
    let r = unsafe { getattrlist(c.as_ptr(), &mut list, buf.as_mut_ptr() as *mut libc::c_void, buf.len(), FSOPT_NOFOLLOW) };
    if r != 0 {
        return None;
    }
    let returned = u32::from_ne_bytes(buf[4..8].try_into().ok()?);
    if returned & ATTR_CMN_ADDEDTIME == 0 {
        return None;
    }
    let sec = i64::from_ne_bytes(buf[24..32].try_into().ok()?);
    let nsec = i64::from_ne_bytes(buf[32..40].try_into().ok()?);
    (sec > 0).then(|| sec * 1000 + nsec / 1_000_000)
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
            let rl = crate::xmp::read_sidecar(&path.join(FOLDER_XMP)).unwrap_or_default();
            subdirs.push(DirInfo { name, path: path.to_string_lossy().into_owned(), rating: rl.rating.unwrap_or(0), label: rl.label });
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
        // 文字檔不和同名照片配對：每個文字檔自成一個項目
        let key = if matches!(class, Class::Text | Class::Video) { format!("\u{1}{}", name.to_lowercase()) } else { stem.to_lowercase() };
        groups.entry(key).or_default().push(FileEntry {
            path,
            name,
            stem,
            ext,
            class,
            size: md.len(),
            mtime,
            cloud: is_dataless(&md),
        });
    }

    let mut items: Vec<Item> = Vec::new();
    for (key, mut files) in groups {
        files.sort_by(|a, b| a.name.cmp(&b.name));
        let raws = files.iter().filter(|f| f.class == Class::Raw).count();
        let jpgs = files.iter().filter(|f| f.class == Class::Jpeg).count();
        let mut sidecar = match key.strip_prefix('\u{1}') {
            Some(name) => sidecars.remove(name),
            None => sidecars.remove(&key),
        };
        let mut push = |files: Vec<FileEntry>, sidecar: Option<PathBuf>| {
            let kind = match (files.len(), files[0].class) {
                (2, _) => "raw+jpeg",
                (_, Class::Raw) => "raw",
                (_, Class::Jpeg) => "jpeg",
                (_, Class::Image) => "image",
                (_, Class::Text) => "text",
                (_, Class::Video) => "video",
                _ => "other",
            };
            // 文字檔顯示完整檔名（notes.txt），一眼就知道是文字檔
            let name = if matches!(files[0].class, Class::Text | Class::Video) { files[0].name.clone() } else { files[0].stem.clone() };
            items.push(Item { id: 0, sub: String::new(), name, kind, files, sidecar });
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

/// 「含子資料夾」：掃描 dir 與所有子資料夾（略過隱藏資料夾與 .app / 照片圖庫等套件），
/// 最多 `limit` 個項目。回傳 (項目, dir 本身的子資料夾, 是否因超過上限而截斷)
pub fn scan_tree(dir: &Path, limit: usize) -> io::Result<(Vec<Item>, Vec<DirInfo>, bool)> {
    const PACKAGES: &[&str] = &["app", "photoslibrary", "fcpbundle", "lrdata", "bundle", "framework", "aplibrary", "migratedphotolibrary"];
    let (mut items, top) = scan_dir(dir)?;
    let mut queue: std::collections::VecDeque<PathBuf> = top.iter().map(|d| PathBuf::from(&d.path)).collect();
    let mut truncated = false;
    let mut visited = 0usize;
    while let Some(d) = queue.pop_front() {
        if items.len() >= limit || visited >= 5000 {
            truncated = true;
            break;
        }
        visited += 1;
        let ext = d.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if PACKAGES.contains(&ext.as_str()) {
            continue;
        }
        let Ok((mut sub_items, subs)) = scan_dir(&d) else { continue };
        let rel = d.strip_prefix(dir).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
        for it in &mut sub_items {
            it.sub = rel.clone();
        }
        items.extend(sub_items);
        queue.extend(subs.iter().map(|x| PathBuf::from(&x.path)));
    }
    if items.len() > limit {
        items.truncate(limit);
        truncated = true;
    }
    items.sort_by_cached_key(|it| (natural_key(&it.name), natural_key(&it.sub)));
    for (i, it) in items.iter_mut().enumerate() {
        it.id = i as u32;
    }
    Ok((items, top, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairs_raw_and_jpeg_and_attaches_sidecar() {
        let dir = std::env::temp_dir().join(format!("ps-scan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        for n in ["IMG_10.CR2", "IMG_10.JPG", "IMG_10.xmp", "IMG_2.jpg", "notes.txt", "notes.txt.xmp", "a.png", "IMG_2.md", "x.doc"] {
            fs::write(dir.join(n), b"x").unwrap();
        }
        let (items, subdirs) = scan_dir(&dir).unwrap();
        let names: Vec<_> = items.iter().map(|i| (i.name.as_str(), i.kind)).collect();
        assert_eq!(
            names,
            vec![("a", "image"), ("IMG_2", "jpeg"), ("IMG_2.md", "text"), ("IMG_10", "raw+jpeg"), ("notes.txt", "text")]
        );
        assert!(items[4].sidecar.as_ref().unwrap().ends_with("notes.txt.xmp"));
        assert!(items[2].sidecar_path().ends_with("IMG_2.md.xmp"));
        assert_eq!(items[3].display().ext, "jpg");
        assert!(items[3].sidecar.is_some());
        assert_eq!(subdirs.len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scans_subfolders() {
        let dir = std::env::temp_dir().join(format!("ps-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("A/B")).unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::create_dir_all(dir.join("x.app")).unwrap();
        for n in ["IMG_1.jpg", "A/IMG_1.jpg", "A/IMG_1.CR2", "A/B/IMG_2.jpg", ".hidden/h.jpg", "x.app/p.png"] {
            fs::write(dir.join(n), b"x").unwrap();
        }
        let (items, top, cut) = scan_tree(&dir, 100).unwrap();
        let v: Vec<_> = items.iter().map(|i| (i.name.as_str(), i.sub.as_str(), i.kind)).collect();
        assert_eq!(v, vec![("IMG_1", "", "jpeg"), ("IMG_1", "A", "raw+jpeg"), ("IMG_2", "A/B", "jpeg")]);
        assert_eq!(top.len(), 2); // A 與 x.app（隱藏資料夾不列出）
        assert!(!cut);
        let (items, _, cut) = scan_tree(&dir, 2).unwrap();
        assert!(cut && items.len() == 2);
        fs::remove_dir_all(&dir).unwrap();
    }
}
