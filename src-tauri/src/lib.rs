mod blur;
mod cache;
mod core;
mod face;
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
use std::path::PathBuf;
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
    let about = AboutMetadata { version: Some(version_string()), ..Default::default() };
    let app_menu = Submenu::with_items(
        app,
        "Photo Selector",
        true,
        &[
            &P::about(app, Some("關於 Photo Selector"), Some(about))?,
            &P::separator(app)?,
            &P::hide(app, Some("隱藏 Photo Selector"))?,
            &P::hide_others(app, Some("隱藏其他"))?,
            &P::show_all(app, Some("顯示全部"))?,
            &P::separator(app)?,
            &P::quit(app, Some("結束 Photo Selector"))?,
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
            &MenuItem::with_id(app, "analyze", "選片分析", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, "slideshow", "播放幻燈片…", true, Some("CmdOrCtrl+Shift+P"))?,
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
            app_version,
            cache_info,
            clear_cache,
            default_folder,
            initial_folder,
            allow_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
