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
const ANALYSIS_VERSION: i64 = 1;
const ANALYSIS_EDGE: u32 = 2048;

#[derive(Serialize, Clone)]
struct AnalysisBatch {
    session: u64,
    results: Vec<(u32, Analysis)>,
}

fn analyze_item(it: &scan::Item) -> Option<Analysis> {
    let img = render::decode_source(it, ANALYSIS_EDGE).ok()?;
    let img = if img.width().max(img.height()) > ANALYSIS_EDGE { img.thumbnail(ANALYSIS_EDGE, ANALYSIS_EDGE) } else { img };
    let sharp = blur::sharpness(&img.thumbnail(1024, 1024).to_luma8());
    let faces = face::analyze(&img.to_rgb8());
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

#[tauri::command]
async fn set_rating(core: CoreState<'_>, session: u64, ids: Vec<u32>, rating: i32) -> Result<(), String> {
    let sess = core.session(session)?;
    let rating = rating.clamp(-1, 5);
    for id in ids {
        if let Some(it) = sess.items.get(id as usize) {
            xmp::update(&it.sidecar_path(), Some(rating), None).map_err(|e| format!("{}：{e}", it.name))?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn set_label(core: CoreState<'_>, session: u64, ids: Vec<u32>, label: Option<String>) -> Result<(), String> {
    let sess = core.session(session)?;
    for id in ids {
        if let Some(it) = sess.items.get(id as usize) {
            xmp::update(&it.sidecar_path(), None, Some(label.as_deref()))
                .map_err(|e| format!("{}：{e}", it.name))?;
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

/// 選片分析：整張清晰度、人臉偵測、閉眼判斷、臉部清晰度。結果分批以事件回傳並寫入快取。
#[tauri::command]
fn analyze(app: AppHandle, core: CoreState<'_>, session: u64, ids: Vec<u32>) -> Result<(), String> {
    let sess = core.session(session)?;
    let core2 = core.inner().clone();
    std::thread::spawn(move || {
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
    });
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
    let about = AboutMetadata { version: Some(env!("CARGO_PKG_VERSION").into()), ..Default::default() };
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
            cache_info,
            clear_cache,
            default_folder,
            initial_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
