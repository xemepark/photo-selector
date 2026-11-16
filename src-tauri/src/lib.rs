mod blur;
mod cache;
mod core;
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

#[derive(Serialize, Clone)]
struct SharpBatch {
    session: u64,
    scores: Vec<(u32, f32)>,
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

#[tauri::command]
fn analyze_sharpness(app: AppHandle, core: CoreState<'_>, session: u64, ids: Vec<u32>) -> Result<(), String> {
    let sess = core.session(session)?;
    let core2 = core.inner().clone();
    std::thread::spawn(move || {
        ids.par_chunks(8).for_each(|chunk| {
            if core2.current().id != sess.id {
                return;
            }
            let scores: Vec<(u32, f32)> = chunk
                .iter()
                .filter_map(|&id| {
                    let it = sess.items.get(id as usize)?;
                    let key = it.display().cache_key();
                    if let Some(s) = core2.cache.get_sharpness(&key) {
                        return Some((id, s));
                    }
                    let img = render::decode_source(it, 1024).ok()?.thumbnail(1024, 1024).to_luma8();
                    let s = blur::sharpness(&img);
                    core2.cache.put_sharpness(&key, s);
                    Some((id, s))
                })
                .collect();
            let _ = app.emit("sharp-batch", SharpBatch { session: sess.id, scores });
        });
        let _ = app.emit("sharp-done", sess.id);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            analyze_sharpness,
            cache_info,
            clear_cache,
            default_folder,
            initial_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
