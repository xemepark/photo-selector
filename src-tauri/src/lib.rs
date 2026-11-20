mod bake;
mod blur;
mod cache;
mod core;
mod dragout;
mod edit;
mod heal;
mod heic;
mod export;
mod face;
mod fileinfo;
mod icc;
mod jpeg;
mod meta;
mod orient;
mod ops;
mod render;
mod scan;
mod text;
mod tiff;
mod xmp;
mod zipout;

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
    /// 加入時間（macOS 加入日期；其他系統為建立時間）
    added: i64,
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
            added: it.files.iter().map(|f| scan::added_ms(&f.path)).max().unwrap_or(0),
        })
        .collect();
    let sess = core.new_session(items);

    // EXIF / 評等在背景分批讀取，先讓畫面出現
    let core2 = core.inner().clone();
    let s2 = sess.clone();
    // 用專屬的 2 個執行緒讀（不佔滿 CPU / 硬碟），畫面上的縮圖還在產生時先讓路（最多等 0.3 秒，仍會穩定前進）
    static META_POOL: std::sync::OnceLock<rayon::ThreadPool> = std::sync::OnceLock::new();
    let pool = META_POOL.get_or_init(|| rayon::ThreadPoolBuilder::new().num_threads(2).thread_name(|i| format!("meta-{i}")).build().unwrap());
    pool.spawn(move || {
        s2.items.par_chunks(24).for_each(|chunk| {
            if core2.current().id != s2.id {
                return;
            }
            for _ in 0..15 {
                if !core2.busy() || core2.current().id != s2.id {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
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
fn set_order(core: CoreState<'_>, session: u64, ids: Vec<u32>) {
    core.set_order(session, ids);
}

/// 同一時間只寫一個檔案：快速連按評分鍵、評分與調整同時存檔時，不會互相覆蓋或把檔案寫壞
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 依 Adobe Bridge 的做法寫入評等 / 標籤：
/// RAW → 附屬檔 .xmp；JPEG → 檔案內嵌 XMP；其他格式 → 附屬檔。RAW+JPEG 配對兩邊都寫。
fn write_meta(core: &Core, it: &scan::Item, rating: Option<i32>, label: Option<Option<&str>>) -> Result<(), String> {
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

#[derive(Serialize)]
struct TextDto {
    text: String,
    /// RTF 檔：存檔後粗體、顏色等格式會移除
    rtf: bool,
    name: String,
}

/// 讀取文字檔內容
#[tauri::command]
async fn read_text(core: CoreState<'_>, session: u64, id: u32) -> Result<TextDto, String> {
    let sess = core.session(session)?;
    let it = sess.items.get(id as usize).ok_or("找不到項目")?.clone();
    if !it.is_text() {
        return Err("不是文字檔".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let f = it.display();
        let text = text::read(&f.path).map_err(|e| format!("無法讀取 {}：{e}", f.name))?;
        Ok(TextDto { text, rtf: text::is_rtf(&f.path), name: f.name.clone() })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 儲存文字檔
#[tauri::command]
async fn write_text(core: CoreState<'_>, session: u64, id: u32, text: String) -> Result<(), String> {
    let sess = core.session(session)?;
    let it = sess.items.get(id as usize).ok_or("找不到項目")?.clone();
    if !it.is_text() {
        return Err("不是文字檔".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let f = it.display();
        text::write(&f.path, &text).map_err(|e| format!("無法儲存 {}：{e}", f.name))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 資料夾不存在時（被刪除、改名、外接硬碟沒接上）找最近一層還存在的上層資料夾
#[tauri::command]
fn existing_ancestor(path: String) -> Option<String> {
    let mut p = PathBuf::from(path);
    while let Some(parent) = p.parent().map(|x| x.to_path_buf()) {
        // 根目錄、macOS 的 /Volumes（外接硬碟沒接上時）不算：改成顯示「找不到資料夾」
        if parent.as_os_str().is_empty() || parent.parent().is_none() || parent == std::path::Path::new("/Volumes") {
            break;
        }
        if parent.is_dir() {
            return Some(parent.to_string_lossy().into_owned());
        }
        p = parent;
    }
    None
}

/// 把資料夾移到垃圾桶
#[tauri::command]
async fn trash_folder(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ops::trash_folder(&PathBuf::from(path))).await.map_err(|e| e.to_string())?
}

/// 資料夾評等（寫在資料夾裡的隱藏檔）
#[tauri::command]
async fn set_folder_rating(path: String, rating: i32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        xmp::update(&PathBuf::from(&path).join(scan::FOLDER_XMP), Some(rating), None).map_err(|e| format!("無法寫入資料夾評等：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 資料夾標籤（None = 移除）
#[tauri::command]
async fn set_folder_label(path: String, label: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        xmp::update(&PathBuf::from(&path).join(scan::FOLDER_XMP), None, Some(label.as_deref()))
            .map_err(|e| format!("無法寫入資料夾標籤：{e}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 在資料夾裡新增子資料夾，回傳完整路徑
#[tauri::command]
async fn create_folder(dir: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("請輸入資料夾名稱".to_string());
        }
        if name.contains(['/', '\\', ':']) || name.starts_with('.') {
            return Err("資料夾名稱不能包含 / \\ : ，也不能以 . 開頭".to_string());
        }
        let path = PathBuf::from(&dir).join(&name);
        std::fs::create_dir(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("已經有「{name}」了，請換一個名稱")
            } else {
                format!("無法建立資料夾「{name}」：{e}")
            }
        })?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 在資料夾裡新增文字檔，回傳實際的檔名（沒有副檔名時加上 .txt）
#[tauri::command]
async fn create_text(dir: String, name: String, text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut name = name.trim().to_string();
        if name.is_empty() {
            name = "未命名".into();
        }
        if name.contains(['/', '\\', ':']) || name.starts_with('.') {
            return Err("檔名不能包含 / \\ : ，也不能以 . 開頭".to_string());
        }
        let ext = std::path::Path::new(&name).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !text::TEXT_EXTS.contains(&ext.as_str()) {
            name.push_str(".txt");
        }
        let path = PathBuf::from(&dir).join(&name);
        let data = if text::is_rtf(&path) { text::text_to_rtf(&text) } else { text };
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("資料夾裡已經有「{name}」，請換一個檔名")
            } else {
                format!("無法建立 {name}：{e}")
            }
        })?;
        f.write_all(data.as_bytes()).map_err(|e| format!("無法寫入 {name}：{e}"))?;
        Ok(name)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 讀取一張照片的調整設定（沒有 = 全部 0）
#[tauri::command]
async fn get_edit(core: CoreState<'_>, session: u64, id: u32) -> Result<edit::Params, String> {
    let sess = core.session(session)?;
    let it = sess.items.get(id as usize).ok_or("找不到項目")?.clone();
    tauri::async_runtime::spawn_blocking(move || edit::load(&it).unwrap_or_default()).await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct EditSaveResult {
    done: usize,
    failed: Vec<String>,
    /// 存檔後每張照片是否還有調整（給前端更新「調整」標記）
    edited: Vec<(u32, bool)>,
}

/// 儲存調整設定到這些照片（寫入方式與評等相同），並丟掉舊的縮圖 / 預覽快取。
/// `fields` 有值時只覆寫列出的項目（例如只同步曝光），每張照片其他的設定保留。
#[tauri::command]
async fn save_edit(
    core: CoreState<'_>,
    session: u64,
    ids: Vec<u32>,
    params: edit::Params,
    fields: Option<Vec<String>>,
) -> Result<EditSaveResult, String> {
    let sess = core.session(session)?;
    let core = core.inner().clone();
    let params = params.clamped();
    tauri::async_runtime::spawn_blocking(move || {
        let mut res = EditSaveResult { done: 0, failed: vec![], edited: vec![] };
        for id in ids {
            let Some(it) = sess.items.get(id as usize) else { continue };
            let p = match &fields {
                Some(f) => edit::load(it).unwrap_or_default().merged(&params, f),
                None => params.clone(),
            };
            match write_props(it, &p.xmp_props()) {
                Ok(()) => {
                    res.done += 1;
                    res.edited.push((id, !p.is_identity()));
                }
                Err(e) => res.failed.push(e),
            }
            core.forget(it);
        }
        res
    })
    .await
    .map_err(|e| e.to_string())
}

/// 寫入任意 XMP 屬性，位置規則與 write_meta 相同（RAW → 附屬檔、JPEG → 內嵌、配對兩邊都寫）
fn write_props(it: &scan::Item, props: &[(&str, Option<String>)]) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    write_props_locked(it, props)
}

/// write_props 的本體（呼叫端已經拿到 WRITE_LOCK）
fn write_props_locked(it: &scan::Item, props: &[(&str, Option<String>)]) -> Result<(), String> {
    let err = |e: std::io::Error| format!("{}：{e}", it.name);
    let mut wrote = false;
    if it.raw().is_some() {
        xmp::update_props(&it.sidecar_path(), props).map_err(err)?;
        wrote = true;
    }
    for f in it.files.iter().filter(|f| f.class == scan::Class::Jpeg) {
        xmp::update_jpeg_props(&f.path, props).map_err(err)?;
        wrote = true;
    }
    if !wrote {
        xmp::update_props(&it.sidecar_path(), props).map_err(err)?;
    }
    Ok(())
}

#[derive(Serialize)]
struct RotateResult {
    /// [id, 新方向]
    done: Vec<(u32, u16)>,
    failed: Vec<String>,
}

/// 旋轉 90°（clockwise = 順時針），存回原檔並丟掉舊的縮圖 / 預覽快取
#[tauri::command]
async fn rotate(core: CoreState<'_>, session: u64, ids: Vec<u32>, clockwise: bool) -> Result<RotateResult, String> {
    let sess = core.session(session)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut res = RotateResult { done: vec![], failed: vec![] };
        for id in ids {
            let Some(it) = sess.items.get(id as usize) else { continue };
            match orient::rotate_item(it, clockwise) {
                Ok(o) => {
                    // 有裁切時，裁切框跟著照片一起轉
                    if let Some(mut p) = edit::load(it).filter(|p| !p.crop.is_empty() || !p.spots.is_empty()) {
                        p.crop = edit::rotate_crop(&p.crop, clockwise);
                        p.spots = heal::rotate_spots(&p.spots, clockwise);
                        if let Err(e) = write_props_locked(it, &p.xmp_props()) {
                            res.failed.push(e);
                        }
                    }
                    res.done.push((id, o))
                }
                Err(e) => res.failed.push(format!("{}：{e}", it.name)),
            }
            core.forget(it);
        }
        res
    })
    .await
    .map_err(|e| e.to_string())
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
    apply_edits: Option<bool>,
) -> Result<ops::TransferResult, String> {
    let sess = core.session(session)?;
    let items: Vec<scan::Item> = ids.iter().filter_map(|&i| sess.items.get(i as usize).cloned()).collect();
    let bake = apply_edits.unwrap_or(true);
    // 套用調整需要解碼、編碼整張照片，放到背景執行緒
    tauri::async_runtime::spawn_blocking(move || {
        let refs: Vec<&scan::Item> = items.iter().collect();
        ops::transfer(&refs, &PathBuf::from(dest), mode == "move", bake)
    })
    .await
    .map_err(|e| e.to_string())
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

fn baked_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_cache_dir().map_err(|e| e.to_string())?.join("baked"))
}

/// 準備拖曳到其他程式：回傳檔案路徑與拖曳圖示（暫存 PNG）。
/// `apply_edits`：有調整的照片改拖出「已套用調整」的暫存檔（同名）。
#[tauri::command]
async fn drag_prepare(
    app: AppHandle,
    core: CoreState<'_>,
    session: u64,
    ids: Vec<u32>,
    include_raw: bool,
    apply_edits: Option<bool>,
) -> Result<DragPayload, String> {
    let sess = core.session(session)?;
    let items: Vec<scan::Item> = ids.iter().filter_map(|&i| sess.items.get(i as usize).cloned()).collect();
    if items.is_empty() {
        return Err("沒有選取照片".into());
    }
    let bake = apply_edits.unwrap_or(true);
    let root = baked_dir(&app)?;
    let core2 = core.inner().clone();
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        for it in &items {
            if bake && bake::needs_bake(it) {
                files.push(bake::cached(it, &root).map_err(|e| format!("{e:#}"))?);
                if include_raw {
                    files.extend(it.raw().map(|r| r.path.clone()));
                }
            } else {
                files.extend(dragout::files_for(&[it], include_raw));
            }
        }
        let thumbs: Vec<Vec<u8>> =
            items.iter().take(3).filter_map(|it| core2.thumb_bytes(it).ok()).map(|b| b.as_ref().clone()).collect();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let icon = dir.join("drag-icon.png");
        dragout::make_icon(&thumbs, &icon).map_err(|e| e.to_string())?;
        Ok(DragPayload { files, icon })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
struct ZipProgress {
    done: usize,
    total: usize,
}

/// 壓縮打包選取的照片成 ZIP（進度以 zip-progress 事件回報）
#[tauri::command]
async fn make_zip(
    app: AppHandle,
    core: CoreState<'_>,
    session: u64,
    ids: Vec<u32>,
    dest: String,
    include_raw: bool,
    apply_edits: bool,
) -> Result<ops::TransferResult, String> {
    let sess = core.session(session)?;
    let items: Vec<scan::Item> = ids.iter().filter_map(|&i| sess.items.get(i as usize).cloned()).collect();
    if items.is_empty() {
        return Err("沒有選取照片".into());
    }
    let tmp = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let r = zipout::make_zip(&items, &PathBuf::from(dest), include_raw, apply_edits, &tmp, |done, total| {
            let _ = app.emit("zip-progress", ZipProgress { done, total });
        })
        .map_err(|e| format!("{e:#}"))?;
        Ok(ops::TransferResult { done: r.done, failed: r.failed })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 選取有調整的照片時，先在背景準備好「套用調整後」的拖曳用檔案，拖曳時就不必等
#[tauri::command]
async fn prepare_drag(app: AppHandle, core: CoreState<'_>, session: u64, ids: Vec<u32>) -> Result<(), String> {
    let sess = core.session(session)?;
    let items: Vec<scan::Item> = ids.iter().take(30).filter_map(|&i| sess.items.get(i as usize).cloned()).collect();
    let root = baked_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        for it in items.iter().filter(|it| bake::needs_bake(it)) {
            let _ = bake::cached(it, &root);
        }
    });
    Ok(())
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
    apply_edits: Option<bool>,
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
    Ok(ops::batch_rename(&list, &m, preserve, &core.cache, apply_edits.unwrap_or(true)))
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
            &MenuItem::with_id(app, "new-tab", "新增分頁", true, Some("CmdOrCtrl+T"))?,
            &MenuItem::with_id(app, "open", "開啟資料夾…", true, Some("CmdOrCtrl+O"))?,
            &MenuItem::with_id(app, "up", "上一層資料夾", true, Some("CmdOrCtrl+Up"))?,
            &P::separator(app)?,
            &MenuItem::with_id(app, "slideshow", "播放幻燈片…", true, Some("CmdOrCtrl+Shift+P"))?,
            &MenuItem::with_id(app, "batch-rename", "批次重新命名…", true, Some("CmdOrCtrl+Shift+R"))?,
            &MenuItem::with_id(app, "edit", "調整照片…", true, None::<&str>)?,
            &MenuItem::with_id(app, "export", "影像轉存…", true, Some("CmdOrCtrl+Shift+E"))?,
            &MenuItem::with_id(app, "zip", "壓縮打包選取的照片…", true, Some("CmdOrCtrl+Shift+K"))?,
            &MenuItem::with_id(app, "goto", "前往資料夾…", true, Some("CmdOrCtrl+Shift+G"))?,
            &MenuItem::with_id(app, "refresh", "重新整理", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(app, "rethumb", "重新產生選取照片的縮圖", true, None::<&str>)?,
            &P::separator(app)?,
            // ⌘W 關閉分頁（與瀏覽器 / Finder 相同）；關閉整個視窗改成 ⇧⌘W
            &MenuItem::with_id(app, "close-tab", "關閉分頁", true, Some("CmdOrCtrl+W"))?,
            &MenuItem::with_id(app, "close-other-tabs", "關閉其他分頁", true, Some("Alt+CmdOrCtrl+W"))?,
            &MenuItem::with_id(app, "close-window", "關閉視窗", true, Some("CmdOrCtrl+Shift+W"))?,
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
        &[
            &MenuItem::with_id(app, "prev-tab", "上一個分頁", true, Some("CmdOrCtrl+Shift+["))?,
            &MenuItem::with_id(app, "next-tab", "下一個分頁", true, Some("CmdOrCtrl+Shift+]"))?,
            &P::separator(app)?,
            &P::minimize(app, Some("縮到最小"))?,
            &P::fullscreen(app, Some("進入全螢幕"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &window])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_menu).on_menu_event(|app, ev| {
        if ev.id().0 == "close-window" {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.close();
            }
            return;
        }
        let _ = app.emit("menu", ev.id().0.clone());
    });
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_drag::init())
        .setup(|app| {
            let dir = app.path().app_cache_dir()?;
            // 上次拖曳用的暫存檔（套用調整後的照片）啟動時清掉
            let _ = std::fs::remove_dir_all(dir.join("baked"));
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
            set_order,
            read_text,
            write_text,
            create_text,
            create_folder,
            set_folder_rating,
            trash_folder,
            existing_ancestor,
            set_folder_label,
            set_rating,
            set_label,
            transfer,
            analyze,
            delete_items,
            drag_prepare,
            prepare_drag,
            make_zip,
            export_images,
            file_info,
            get_edit,
            rotate,
            save_edit,
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
