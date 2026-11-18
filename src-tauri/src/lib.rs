mod blur;
mod cache;
mod core;
mod dragout;
mod export;
mod face;
mod fileinfo;
mod icc;
mod jpeg;
mod meta;
mod ops;
mod render;
mod scan;
mod tiff;
mod xmp;

use crate::core::Core;
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

type CoreState<'a> = State<'a, Arc<Core>>;

#[derive(Serialize)]
struct ItemDto {
    id: u32,
    name: String,
    kind: &'static str,
    files: Vec<String>,
    size: u64,
    mtime: i64,
}

#[derive(Serialize)]
struct OpenResult {
    session: u64,
    dir: String,
    parent: Option<String>,
    subdirs: Vec<scan::DirInfo>,
    items: Vec<ItemDto>,
}

#[derive(Serialize, Clone)]
struct MetaBatch {
    session: u64,
    metas: Vec<(u32, meta::Meta)>,
}

/// 選片分析結果（整張清晰度 + 每張臉的閉眼 / 清晰度）
#[derive(Serialize, serde::Deserialize, Clone)]
struct Analysis {
    sharp: f32,
    faces: Vec<face::Face>,
}

/// 演算法版本：改動分析方式時加一，舊快取就會自動失效
const ANALYSIS_VERSION: i64 = 3;
const ANALYSIS_EDGE: u32 = 2048;
/// 判斷眼睛對焦用的解析度（長邊至少這麼大）
const EYE_EDGE: u32 = 4096;

#[derive(Serialize, Clone)]
struct AnalysisBatch {
    session: u64,
    results: Vec<(u32, Analysis)>,
}

fn analyze_item(it: &scan::Item) -> Option<Analysis> {
    // 高解析度（約 4000px）用來判斷眼睛有沒有對到焦；縮到 2048px 做人臉偵測
    let full = render::decode_source(it, EYE_EDGE).ok()?;
    let full = if full.width().max(full.height()) > EYE_EDGE * 2 { full.thumbnail(EYE_EDGE * 2, EYE_EDGE * 2) } else { full };
    let hires = full.to_luma8();
    let img = if full.width().max(full.height()) > ANALYSIS_EDGE { full.thumbnail(ANALYSIS_EDGE, ANALYSIS_EDGE) } else { full };
    let sharp = blur::sharpness(&img.thumbnail(1024, 1024).to_luma8());
    let faces = face::analyze(&img.to_rgb8(), Some(&hires));
    Some(Analysis { sharp, faces })
}

#[tauri::command]
async fn open_folder(app: AppHandle, core: CoreState<'_>, path: String) -> Result<OpenResult, String> {
    let dir = PathBuf::from(&path);
    let (items, subdirs) = scan::scan_dir(&dir).map_err(|e| format!("無法讀取資料夾：{e}"))?;
    let dtos = items
        .iter()
        .map(|it| ItemDto {
            id: it.id,
            name: it.name.clone(),
            kind: it.kind,
            files: it.files.iter().map(|f| f.name.clone()).collect(),
            size: it.files.iter().map(|f| f.size).sum(),
            mtime: it.files.iter().map(|f| f.mtime).max().unwrap_or(0),
        })
        .collect();
    let sess = core.new_session(items);

    // EXIF / 評等在背景分批讀取，先讓畫面出現
    let core2 = core.inner().clone();
    let s2 = sess.clone();
    std::thread::spawn(move || {
        s2.items.par_chunks(48).for_each(|chunk| {
            if core2.current().id != s2.id {
                return;
            }
            let metas = chunk.iter().map(|it| (it.id, meta::read_meta(it))).collect();
            let _ = app.emit("meta-batch", MetaBatch { session: s2.id, metas });
        });
        let _ = app.emit("meta-done", s2.id);
    });

    Ok(OpenResult {
        session: sess.id,
        dir: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        subdirs,
        items: dtos,
    })
}

#[tauri::command]
fn set_viewport(core: CoreState<'_>, session: u64, ids: Vec<u32>) {
    core.set_viewport(session, ids);
}

/// 依 Adobe Bridge 的做法寫入評等 / 標籤：
/// RAW → 附屬檔 .xmp；JPEG → 檔案內嵌 XMP；其他格式 → 附屬檔。RAW+JPEG 配對兩邊都寫。
fn write_meta(core: &Core, it: &scan::Item, rating: Option<i32>, label: Option<Option<&str>>) -> Result<(), String> {
    // 同一時間只寫一個檔案：快速連按評分鍵時，兩次寫入不會互相覆蓋或把檔案寫壞
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let err = |e: std::io::Error| format!("{}：{e}", it.name);
    let mut wrote = false;
    if it.raw().is_some() {
        xmp::update(&it.sidecar_path(), rating, label).map_err(err)?;
        wrote = true;
    }
    for f in it.files.iter().filter(|f| f.class == scan::Class::Jpeg) {
        xmp::update_jpeg(&f.path, rating, label).map_err(err)?;
        wrote = true;
        // 快取內容仍有效，只是檔案的修改時間 / 大小變了
        if let Ok(md) = std::fs::metadata(&f.path) {
            core.cache.rekey(&f.path.to_string_lossy(), scan::mtime_ms(&md), md.len() as i64);
        }
    }
    if it.raw().is_none() && it.files.iter().any(|f| f.class == scan::Class::Jpeg) {
        // 舊版本程式替 JPEG 建立的附屬檔，已經寫進 JPEG 內，移除避免資料不一致
        let sc = it.sidecar_path();
        if sc.exists() && xmp::is_own_simple_sidecar(&sc) {
            let _ = std::fs::remove_file(sc);
        }
    }
    if !wrote {
        xmp::update(&it.sidecar_path(), rating, label).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
async fn set_rating(core: CoreState<'_>, session: u64, ids: Vec<u32>, rating: i32) -> Result<(), String> {
    let sess = core.session(session)?;
    let rating = rating.clamp(-1, 5);
    for id in ids {
        if let Some(it) = sess.items.get(id as usize) {
            write_meta(&core, it, Some(rating), None)?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn set_label(core: CoreState<'_>, session: u64, ids: Vec<u32>, label: Option<String>) -> Result<(), String> {
    let sess = core.session(session)?;
    for id in ids {
        if let Some(it) = sess.items.get(id as usize) {
            write_meta(&core, it, None, Some(label.as_deref()))?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn transfer(
    core: CoreState<'_>,
    session: u64,
    ids: Vec<u32>,
    dest: String,
    mode: String,
) -> Result<ops::TransferResult, String> {
    let sess = core.session(session)?;
    let items: Vec<_> = ids.iter().filter_map(|&i| sess.items.get(i as usize)).collect();
    Ok(ops::transfer(&items, &PathBuf::from(dest), mode == "move"))
}

/// 選片分析專用的執行緒池：最多用一半的 CPU 核心，留給縮圖與全螢幕預覽，操作才不會卡
fn analysis_pool() -> &'static rayon::ThreadPool {
    static POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    POOL.get_or_init(|| {
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        rayon::ThreadPoolBuilder::new()
            .num_threads((n / 2).max(1))
            .thread_name(|i| format!("analysis-{i}"))
            .build()
            .expect("analysis pool")
    })
}

/// 選片分析：整張清晰度、人臉偵測、閉眼判斷、臉部清晰度。結果分批以事件回傳並寫入快取。
/// 刪除（移到垃圾桶）
#[tauri::command]
async fn delete_items(core: CoreState<'_>, session: u64, ids: Vec<u32>) -> Result<ops::TransferResult, String> {
    let sess = core.session(session)?;
    let items: Vec<_> = ids.iter().filter_map(|&i| sess.items.get(i as usize)).collect();
    Ok(ops::trash_items(&items))
}

/// 狀態列顯示的檔案資訊
#[tauri::command]
async fn file_info(core: CoreState<'_>, session: u64, id: u32) -> Result<fileinfo::FileInfo, String> {
    let sess = core.session(session)?;
    let it = sess.items.get(id as usize).ok_or("找不到項目")?.clone();
    tauri::async_runtime::spawn_blocking(move || fileinfo::file_info(&it)).await.map_err(|e| e.to_string())
}

static EXPORT_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct ExportProgress {
    done: usize,
    total: usize,
}

/// 影像轉存（仿 Photoshop 影像處理器）。進度以 export-progress 事件回報
#[tauri::command]
async fn export_images(
    app: AppHandle,
    core: CoreState<'_>,
    session: u64,
    ids: Vec<u32>,
    options: export::ExportOptions,
) -> Result<export::ExportResult, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    if options.formats.is_empty() {
        return Err("請至少選擇一種檔案類型".into());
    }
    let sess = core.session(session)?;
    let items: Vec<scan::Item> = ids.iter().filter_map(|&i| sess.items.get(i as usize).cloned()).collect();
    EXPORT_CANCEL.store(false, Ordering::SeqCst);
    let total = items.len();
    tauri::async_runtime::spawn_blocking(move || {
        // 5000 萬像素的照片解碼後約 150MB，同時處理的張數要有上限
        let threads = (std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) / 2).clamp(1, 4);
        let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().map_err(|e| e.to_string())?;
        let done = AtomicUsize::new(0);
        let _ = app.emit("export-progress", ExportProgress { done: 0, total });
        let results: Vec<Result<Vec<PathBuf>, String>> = pool.install(|| {
            items
                .par_iter()
                .map(|it| {
                    if EXPORT_CANCEL.load(Ordering::SeqCst) {
                        return Err(format!("{}：已取消", it.display().name));
                    }
                    let r = export::export_item(it, &options).map_err(|e| format!("{e:#}"));
                    let n = done.fetch_add(1, Ordering::SeqCst) + 1;
                    let _ = app.emit("export-progress", ExportProgress { done: n, total });
                    r
                })
                .collect()
        });
        let mut res = export::ExportResult::default();
        let mut dirs = std::collections::BTreeSet::new();
        for r in results {
            match r {
                Ok(paths) => {
                    res.done += 1;
                    for p in paths {
                        if let Some(d) = p.parent() {
                            dirs.insert(d.to_string_lossy().into_owned());
                        }
                    }
                }
                Err(e) => res.failed.push(e),
            }
        }
        res.dirs = dirs.into_iter().collect();
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn export_cancel() {
    EXPORT_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[derive(Serialize)]
struct DragPayload {
    files: Vec<PathBuf>,
    icon: PathBuf,
}

/// 準備拖曳到其他程式：回傳檔案路徑與拖曳圖示（暫存 PNG）
#[tauri::command]
async fn drag_prepare(
    app: AppHandle,
    core: CoreState<'_>,
    session: u64,
    ids: Vec<u32>,
    include_raw: bool,
) -> Result<DragPayload, String> {
    let sess = core.session(session)?;
    let items: Vec<_> = ids.iter().filter_map(|&i| sess.items.get(i as usize)).collect();
    if items.is_empty() {
        return Err("沒有選取照片".into());
    }
    let files = dragout::files_for(&items, include_raw);
    let thumbs: Vec<Vec<u8>> =
        items.iter().take(3).filter_map(|it| core.thumb_bytes(it).ok()).map(|b| b.as_ref().clone()).collect();
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let icon = dir.join("drag-icon.png");
    dragout::make_icon(&thumbs, &icon).map_err(|e| e.to_string())?;
    Ok(DragPayload { files, icon })
}

#[derive(serde::Deserialize)]
struct RenameEntry {
    id: u32,
    stem: String,
}

/// 重新命名（單張或批次）。mode："rename"（相同資料夾）/ "move" / "copy"
#[tauri::command]
async fn batch_rename(
    core: CoreState<'_>,
    session: u64,
    entries: Vec<RenameEntry>,
    mode: String,
    dest: Option<String>,
    preserve: bool,
) -> Result<ops::TransferResult, String> {
    let sess = core.session(session)?;
    let list: Vec<(&scan::Item, String)> = entries
        .iter()
        .filter_map(|e| sess.items.get(e.id as usize).map(|it| (it, e.stem.trim().to_string())))
        .filter(|(_, s)| !s.is_empty())
        .collect();
    let m = match (mode.as_str(), dest) {
        ("move", Some(d)) => ops::RenameMode::Move(PathBuf::from(d)),
        ("copy", Some(d)) => ops::RenameMode::Copy(PathBuf::from(d)),
        _ => ops::RenameMode::InPlace,
    };
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    Ok(ops::batch_rename(&list, &m, preserve, &core.cache))
}

pub const WEBSITE: &str = "https://smallday.tw";
/// 照片裁切輸出（線上工具）
pub const CROP_TOOL: &str = "https://xemepark.github.io/crop/";

/// 開啟內建的外部連結。只接受固定的名稱，不接受任意網址
#[tauri::command]
fn open_link(name: String) -> Result<(), String> {
    let url = match name.as_str() {
        "website" => WEBSITE,
        "crop" => CROP_TOOL,
        _ => return Err("未知的連結".into()),
    };
    ops::open_url(url).map_err(|e| e.to_string())
}

/// 用 Finder 開啟資料夾（複製 / 移動完成後的提示訊息使用）
#[tauri::command]
async fn open_dir(path: String) -> Result<(), String> {
    ops::open_dir(&PathBuf::from(path)).map_err(|e| e.to_string())
}

/// 開啟 https://smallday.tw
#[tauri::command]
fn open_website() -> Result<(), String> {
    ops::open_website().map_err(|e| e.to_string())
}

/// 在 Finder 中顯示
#[tauri::command]
async fn reveal_item(core: CoreState<'_>, session: u64, id: u32) -> Result<(), String> {
    let sess = core.session(session)?;
    let it = sess.items.get(id as usize).ok_or("找不到項目")?;
    ops::reveal(&it.display().path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ResolvedPath {
    dir: String,
    /// 輸入的是檔案時，該檔案的檔名（開啟資料夾後選取它）
    file: Option<String>,
}

/// 解析路徑列輸入的文字：去掉引號、展開 ~、檔案則取所在資料夾
#[derive(Serialize)]
struct DirNode {
    name: String,
    path: String,
    /// 是否有子資料夾（決定要不要顯示展開箭頭）
    has_children: bool,
}

fn is_hidden(name: &str) -> bool {
    name.starts_with('.') || name.starts_with('$') || name == "System Volume Information"
}

fn has_subdir(p: &Path) -> bool {
    let Ok(rd) = std::fs::read_dir(p) else { return false };
    rd.flatten()
        .take(2000)
        .any(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false) && !is_hidden(&e.file_name().to_string_lossy()))
}

/// 列出資料夾裡的子資料夾（資料夾樹展開時使用，只讀這一層）
#[tauri::command]
async fn list_dirs(path: String) -> Result<Vec<DirNode>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("無法讀取資料夾：{e}"))?;
    let mut dirs: Vec<(String, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if is_hidden(&name) {
                return None;
            }
            let p = e.path();
            // 也接受指向資料夾的捷徑（symlink）
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false) || p.is_dir();
            is_dir.then_some((name, p))
        })
        .collect();
    dirs.sort_by_cached_key(|(n, _)| scan::natural_key(n));
    let many = dirs.len() > 300;
    Ok(dirs
        .into_iter()
        .map(|(name, p)| DirNode {
            has_children: many || has_subdir(&p),
            name,
            path: p.to_string_lossy().into_owned(),
        })
        .collect())
}

#[derive(Serialize)]
struct RootNode {
    /// "home" / "desktop" / "downloads" / "pictures" / "volume"
    kind: &'static str,
    name: String,
    path: String,
    has_children: bool,
}

/// 資料夾樹的最上層：常用位置與所有磁碟（含外接硬碟）
#[tauri::command]
async fn list_roots(app: AppHandle) -> Vec<RootNode> {
    let mut out = Vec::new();
    let mut push = |kind: &'static str, name: String, p: PathBuf| {
        if p.is_dir() && !out.iter().any(|r: &RootNode| r.path == p.to_string_lossy() && r.kind == kind) {
            out.push(RootNode { kind, name, has_children: has_subdir(&p), path: p.to_string_lossy().into_owned() });
        }
    };
    let pr = app.path();
    if let Ok(h) = pr.home_dir() {
        let name = h.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "家目錄".into());
        push("home", name, h);
    }
    if let Ok(p) = pr.desktop_dir() {
        push("desktop", "桌面".into(), p);
    }
    if let Ok(p) = pr.download_dir() {
        push("downloads", "下載項目".into(), p);
    }
    if let Ok(p) = pr.picture_dir() {
        push("pictures", "圖片".into(), p);
    }
    #[cfg(target_os = "macos")]
    {
        // /Volumes 底下是所有磁碟；開機磁碟（例如 Macintosh HD）是指向 / 的捷徑
        if let Ok(rd) = std::fs::read_dir("/Volumes") {
            let mut vols: Vec<_> = rd.flatten().collect();
            vols.sort_by_key(|e| e.file_name());
            for e in vols {
                let name = e.file_name().to_string_lossy().into_owned();
                if is_hidden(&name) {
                    continue;
                }
                let p = e.path();
                let target = std::fs::canonicalize(&p).unwrap_or(p.clone());
                push("volume", name, if target == Path::new("/") { PathBuf::from("/") } else { p });
            }
        }
    }
    #[cfg(target_os = "windows")]
    {
        for c in b'A'..=b'Z' {
            let p = PathBuf::from(format!("{}:\\", c as char));
            if p.exists() {
                push("volume", format!("{}:", c as char), p);
            }
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        push("volume", "電腦".into(), PathBuf::from("/"));
        let user = std::env::var("USER").unwrap_or_default();
        for base in [format!("/media/{user}"), "/media".to_string(), "/mnt".to_string()] {
            if let Ok(rd) = std::fs::read_dir(&base) {
                for e in rd.flatten() {
                    let name = e.file_name().to_string_lossy().into_owned();
                    if !is_hidden(&name) && e.path().is_dir() && name != user {
                        push("volume", name, e.path());
                    }
                }
            }
        }
    }
    out
}

#[tauri::command]
fn resolve_path(app: AppHandle, input: String) -> Result<ResolvedPath, String> {
    let mut t = input.trim().trim_matches(|c| c == '"' || c == '\'' ).trim().to_string();
    if let Some(rest) = t.strip_prefix("file://") {
        t = rest.replace("%20", " ");
    }
    if t == "~" || t.starts_with("~/") {
        let home = app.path().home_dir().map_err(|e| e.to_string())?;
        t = format!("{}{}", home.to_string_lossy(), &t[1..]);
    }
    let p = PathBuf::from(&t);
    if p.is_dir() {
        return Ok(ResolvedPath { dir: p.to_string_lossy().into_owned(), file: None });
    }
    if p.is_file() {
        let dir = p.parent().ok_or("無效的路徑")?;
        return Ok(ResolvedPath {
            dir: dir.to_string_lossy().into_owned(),
            file: p.file_name().map(|n| n.to_string_lossy().into_owned()),
        });
    }
    Err(format!("找不到這個路徑：{t}"))
}

#[tauri::command]
fn analyze(app: AppHandle, core: CoreState<'_>, session: u64, ids: Vec<u32>) -> Result<(), String> {
    let sess = core.session(session)?;
    let core2 = core.inner().clone();
    std::thread::spawn(move || analysis_pool().install(|| {
        ids.par_chunks(4).for_each(|chunk| {
            if core2.current().id != sess.id {
                return;
            }
            let results: Vec<(u32, Analysis)> = chunk
                .iter()
                .filter_map(|&id| {
                    let it = sess.items.get(id as usize)?;
                    let key = it.display().cache_key();
                    if let Some(a) = core2
                        .cache
                        .get_analysis(&key, ANALYSIS_VERSION)
                        .and_then(|j| serde_json::from_str::<Analysis>(&j).ok())
                    {
                        return Some((id, a));
                    }
                    let a = analyze_item(it)?;
                    if let Ok(j) = serde_json::to_string(&a) {
                        core2.cache.put_analysis(&key, ANALYSIS_VERSION, &j);
                    }
                    Some((id, a))
                })
                .collect();
            let _ = app.emit("analysis-batch", AnalysisBatch { session: sess.id, results });
        });
        let _ = app.emit("analysis-done", sess.id);
    }));
    Ok(())
}

#[tauri::command]
fn cache_info(core: CoreState<'_>) -> (String, u64) {
    (core.cache.path.to_string_lossy().into_owned(), core.cache.size_bytes())
}

/// 重新產生縮圖：刪掉這些項目的快取（前端接著重新要圖）
#[tauri::command]
async fn forget_thumbs(core: CoreState<'_>, session: u64, ids: Vec<u32>) -> Result<(), String> {
    let sess = core.session(session)?;
    for &i in &ids {
        if let Some(it) = sess.items.get(i as usize) {
            core.forget(it);
        }
    }
    Ok(())
}

#[tauri::command]
async fn clear_cache(core: CoreState<'_>) -> Result<(), String> {
    core.clear_memory();
    core.cache.clear().map_err(|e| e.to_string())
}

#[tauri::command]
fn default_folder(app: AppHandle) -> Option<String> {
    app.path()
        .picture_dir()
        .ok()
        .filter(|p| p.is_dir())
        .or_else(|| app.path().home_dir().ok())
        .map(|p| p.to_string_lossy().into_owned())
}

const AUDIO_EXTS: &[&str] = &["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "oga", "opus"];

#[derive(Serialize)]
struct AllowAudioResult {
    allowed: Vec<String>,
    /// (路徑, 原因)
    rejected: Vec<(String, String)>,
}

/// 允許幻燈片播放使用者挑選的背景音樂檔。
/// 只開放「存在、可讀取、且副檔名是音樂格式」的檔案給 asset 協定讀取。
#[tauri::command]
fn allow_audio(app: AppHandle, paths: Vec<String>) -> AllowAudioResult {
    let scope = app.asset_protocol_scope();
    let mut res = AllowAudioResult { allowed: vec![], rejected: vec![] };
    for p in paths {
        let path = std::path::Path::new(&p);
        let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let reason = if ext == "m4p" {
            Some("Apple Music 下載的歌曲有版權保護（.m4p），無法使用".to_string())
        } else if !AUDIO_EXTS.contains(&ext.as_str()) {
            Some(format!("不支援 .{ext} 格式"))
        } else if !path.is_file() {
            Some("找不到檔案".to_string())
        } else if let Err(e) = std::fs::File::open(path) {
            Some(format!("沒有權限讀取（{e}）"))
        } else if let Err(e) = scope.allow_file(path) {
            Some(format!("無法加入允許清單（{e}）"))
        } else {
            None
        };
        match reason {
            None => res.allowed.push(p),
            Some(r) => res.rejected.push((p, r)),
        }
    }
    res
}

/// 版本字串，例如「0.1.0 (b57cba3)」；CI 編譯時帶入 commit 編號，方便確認裝的是哪一版
fn version_string() -> String {
    let sha = option_env!("BUILD_SHA").map(|s| &s[..s.len().min(7)]).unwrap_or("dev");
    format!("{} ({sha})", env!("CARGO_PKG_VERSION"))
}

#[tauri::command]
fn app_version() -> String {
    version_string()
}

/// 命令列指定的資料夾：photo-selector /path/to/photos
#[tauri::command]
fn initial_folder() -> Option<String> {
    std::env::args().skip(1).find(|a| !a.starts_with('-') && std::path::Path::new(a).is_dir())
}

/// macOS 選單列（Windows / Linux 不顯示選單列）。
/// 自訂項目被點選時，以 "menu" 事件把 id 傳給前端處理。
#[cfg(target_os = "macos")]
fn mac_menu<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem as P, Submenu};
    let about = AboutMetadata {
        version: Some(version_string()),
        website: Some(WEBSITE.into()),
        website_label: Some("smallday.tw".into()),
        ..Default::default()
    };
    let app_menu = Submenu::with_items(
        app,
        "小日子寫真館",
        true,
        &[
            &P::about(app, Some("關於 小日子寫真館"), Some(about))?,
            &MenuItem::with_id(app, "website", "前往 smallday.tw", true, None::<&str>)?,
            &MenuItem::with_id(app, "crop", "照片裁切輸出", true, None::<&str>)?,
            &P::separator(app)?,
            &P::hide(app, Some("隱藏 小日子寫真館"))?,
            &P::hide_others(app, Some("隱藏其他"))?,
            &P::show_all(app, Some("顯示全部"))?,
            &P::separator(app)?,
            &P::quit(app, Some("結束 小日子寫真館"))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        "檔案",
        true,
        &[
            &MenuItem::with_id(app, "open", "開啟資料夾…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(app, "up", "上一層資料夾", true, Some("CmdOrCtrl+Up"))?,
            &P::separator(app)?,
            &MenuItem::with_id(app, "slideshow", "播放幻燈片…", true, Some("CmdOrCtrl+Shift+P"))?,
            &MenuItem::with_id(app, "batch-rename", "批次重新命名…", true, Some("CmdOrCtrl+Shift+R"))?,
            &MenuItem::with_id(app, "export", "影像轉存…", true, Some("CmdOrCtrl+Shift+E"))?,
            &MenuItem::with_id(app, "goto", "前往資料夾…", true, Some("CmdOrCtrl+Shift+G"))?,
            &MenuItem::with_id(app, "refresh", "重新整理", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, "rethumb", "重新產生選取照片的縮圖", true, None::<&str>)?,
            &P::separator(app)?,
            &P::close_window(app, Some("關閉視窗"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "編輯",
        true,
        &[
            &P::copy(app, Some("拷貝"))?,
            &P::paste(app, Some("貼上"))?,
            // 不用系統的「全選」：它會去選取網頁文字，而不是選取照片
            &MenuItem::with_id(app, "select-all", "選取全部照片", true, Some("CmdOrCtrl+A"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "視窗",
        true,
        &[&P::minimize(app, Some("縮到最小"))?, &P::fullscreen(app, Some("進入全螢幕"))?],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu).on_menu_event(|app, ev| {
        let _ = app.emit("menu", ev.id().0.clone());
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            let dir = app.path().app_cache_dir()?;
            app.manage(Core::new(dir)?);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("img", |ctx, request, responder| {
            let core = ctx.app_handle().state::<Arc<Core>>().inner().clone();
            core.submit(request.uri().path(), responder);
        })
        .invoke_handler(tauri::generate_handler![
            open_folder,
            set_viewport,
            set_rating,
            set_label,
            transfer,
            analyze,
            delete_items,
            drag_prepare,
            export_images,
            file_info,
            forget_thumbs,
            export_cancel,
            app_version,
            open_dir,
            open_website,
            open_link,
            batch_rename,
            reveal_item,
            resolve_path,
            list_dirs,
            list_roots,
            cache_info,
            clear_cache,
            default_folder,
            initial_folder,
            allow_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
