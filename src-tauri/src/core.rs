//! 核心狀態與縮圖排程。
//!
//! 前端用 `<img src="img://localhost/t/<session>/<id>">` 要圖，請求進到這裡：
//!
//! 1. 記憶體 LRU 命中 → 立刻回應（不進佇列）
//! 2. 否則放進工作佇列：預覽 / 原圖走「高優先」，縮圖走「低優先」
//! 3. 縮圖依前端要求的順序處理（先畫面上的、由左上到右下）；快速小縮圖（q）最優先
//! 6. 佇列空閒時，在背景依目前的排序把整個資料夾的縮圖預先產生進磁碟快取（最多用一半的工作者），
//!    捲到哪裡都已經有圖
//! 4. 工作者取出縮圖工作時，若該項目已不在前端回報的「可視範圍」內就直接取消（410），
//!    前端等它再次出現在畫面上時才重新要求 —— 快速捲過一萬張照片也不會塞車
//! 5. 縮圖結果寫入 SQLite 磁碟快取，下次開同一個資料夾就不必重新解碼

use crate::cache::Cache;
use crate::render::{self, Kind};
use crate::scan::Item;
use lru::LruCache;
use parking_lot::{Condvar, Mutex, RwLock};
use std::collections::{HashSet, VecDeque};
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::http::{header, Response, StatusCode};
use tauri::UriSchemeResponder;

pub struct Session {
    pub id: u64,
    pub items: Vec<Item>,
}

struct Job {
    session: u64,
    id: u32,
    kind: Kind,
    responder: UriSchemeResponder,
}

#[derive(Default)]
struct Queues {
    quick: VecDeque<Job>,
    high: Vec<Job>,
    low: VecDeque<Job>,
}

enum Task {
    Job(Job),
    Prefetch(u64, u32),
}

pub struct Core {
    session: RwLock<Arc<Session>>,
    next_session: AtomicU64,
    viewport: RwLock<(u64, HashSet<u32>)>,
    pub cache: Cache,
    mem_thumbs: Mutex<LruCache<(String, i64, i64), Arc<Vec<u8>>>>,
    mem_previews: Mutex<LruCache<(String, i64, i64), Arc<Vec<u8>>>>,
    mem_medium: Mutex<LruCache<(String, i64, i64), Arc<Vec<u8>>>>,
    queue: Mutex<Queues>,
    cv: Condvar,
    /// 前端目前的排序（背景預先產生縮圖的順序）
    order: RwLock<(u64, Vec<u32>)>,
    /// 已有縮圖（或已在產生）的項目
    done: Mutex<(u64, HashSet<u32>)>,
    prefetching: AtomicUsize,
    max_prefetch: usize,
    /// 正在處理的前景工作數
    active: AtomicUsize,
}

fn respond(responder: UriSchemeResponder, status: StatusCode, mime: &str, body: Vec<u8>, cacheable: bool) {
    let resp = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, if cacheable { "max-age=3600" } else { "no-store" })
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(body)
        .unwrap();
    responder.respond(resp);
}

fn respond_status(responder: UriSchemeResponder, status: StatusCode) {
    respond(responder, status, "text/plain", Vec::new(), false);
}

/// 磁碟快取的鍵值：用檔案「現在」的修改時間與大小。
/// 存調整 / 旋轉 / 評等時會改寫 JPEG（時間與大小都會變），但開資料夾時記下的值不會更新；
/// 用舊值存的話，下次開啟就對不上而重算（有修補的照片要好幾秒）
fn disk_key(item: &Item) -> (String, i64, i64) {
    let mut k = item.display().cache_key();
    if let Ok(md) = std::fs::metadata(&item.display().path) {
        k.1 = crate::scan::mtime_ms(&md);
        k.2 = md.len() as i64;
    }
    k
}

fn workers() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).saturating_sub(1).max(2)
}

impl Core {
    pub fn new(cache_dir: PathBuf) -> anyhow::Result<Arc<Self>> {
        let core = Arc::new(Self {
            session: RwLock::new(Arc::new(Session { id: 0, items: vec![] })),
            next_session: AtomicU64::new(1),
            viewport: RwLock::new((0, HashSet::new())),
            cache: Cache::open(&cache_dir)?,
            mem_thumbs: Mutex::new(LruCache::new(NonZeroUsize::new(3000).unwrap())),
            mem_previews: Mutex::new(LruCache::new(NonZeroUsize::new(24).unwrap())),
            mem_medium: Mutex::new(LruCache::new(NonZeroUsize::new(64).unwrap())),
            queue: Mutex::new(Queues::default()),
            cv: Condvar::new(),
            order: RwLock::new((0, Vec::new())),
            done: Mutex::new((0, HashSet::new())),
            prefetching: AtomicUsize::new(0),
            max_prefetch: (workers() / 2).max(1),
            active: AtomicUsize::new(0),
        });
        let workers = workers();
        for i in 0..workers {
            let c = core.clone();
            std::thread::Builder::new().name(format!("thumb-{i}")).spawn(move || c.worker()).unwrap();
        }
        Ok(core)
    }

    pub fn current(&self) -> Arc<Session> {
        self.session.read().clone()
    }

    pub fn session(&self, id: u64) -> Result<Arc<Session>, String> {
        let s = self.current();
        if s.id == id { Ok(s) } else { Err("資料夾已變更，請重新整理".into()) }
    }

    pub fn new_session(&self, items: Vec<Item>) -> Arc<Session> {
        let id = self.next_session.fetch_add(1, Ordering::SeqCst);
        let s = Arc::new(Session { id, items });
        *self.session.write() = s.clone();
        *self.viewport.write() = (id, HashSet::new());
        // 舊資料夾的排隊工作全部作廢
        let stale: Vec<Job> = {
            let mut q = self.queue.lock();
            let mut v = std::mem::take(&mut q.high);
            v.extend(q.low.drain(..));
            v.extend(q.quick.drain(..));
            v
        };
        for j in stale {
            respond_status(j.responder, StatusCode::NOT_FOUND);
        }
        s
    }

    pub fn set_viewport(&self, session: u64, ids: Vec<u32>) {
        *self.viewport.write() = (session, ids.into_iter().collect());
        self.cv.notify_all();
    }

    /// 前端的排序 / 篩選結果（背景預先產生縮圖依這個順序）
    pub fn set_order(&self, session: u64, ids: Vec<u32>) {
        *self.order.write() = (session, ids);
        self.cv.notify_all();
    }

    /// 前景還有工作（畫面上要的圖還沒好）：讀 EXIF 等背景工作先讓路
    pub fn busy(&self) -> bool {
        let q = self.queue.lock();
        !q.quick.is_empty() || !q.high.is_empty() || !q.low.is_empty() || self.active.load(Ordering::Relaxed) > 0
    }

    fn mark_done(&self, session: u64, id: u32) {
        let mut d = self.done.lock();
        if d.0 != session {
            *d = (session, HashSet::new());
        }
        d.1.insert(id);
    }

    /// 下一個要在背景預先產生縮圖的項目：從畫面最後一張往後，到底再從頭
    fn next_prefetch(&self) -> Option<(u64, u32)> {
        let sess = self.current();
        let order = self.order.read();
        if order.0 != sess.id || order.1.is_empty() {
            return None;
        }
        let mut d = self.done.lock();
        if d.0 != sess.id {
            *d = (sess.id, HashSet::new());
        }
        let vp = self.viewport.read();
        let anchor = if vp.0 == sess.id {
            order.1.iter().rposition(|id| vp.1.contains(id)).map(|p| p + 1).unwrap_or(0)
        } else {
            0
        };
        let n = order.1.len();
        let anchor = anchor.min(n);
        let id = order.1[anchor..]
            .iter()
            .chain(order.1[..anchor].iter())
            .copied()
            .find(|id| (*id as usize) < sess.items.len() && !d.1.contains(id))?;
        d.1.insert(id);
        Some((sess.id, id))
    }

    fn prefetch(&self, session: u64, id: u32) {
        let sess = self.current();
        if sess.id != session {
            return;
        }
        let Some(item) = sess.items.get(id as usize) else { return };
        if item.is_text() {
            return;
        }
        let dk = disk_key(item);
        if self.cache.has_thumb(&dk) {
            return;
        }
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render::render(item, Kind::Thumb)));
        if let Ok(Ok(bytes)) = r {
            self.cache.put_thumb(&dk, &bytes);
            let mut mem = self.mem_thumbs.lock();
            if mem.len() < mem.cap().get() {
                mem.put(item.display().cache_key(), Arc::new(bytes));
            }
        }
    }

    /// 處理 `img://` 請求。路徑格式：/<t|p|f>/<session>/<id>
    pub fn submit(&self, path: &str, responder: UriSchemeResponder) {
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let parsed = match parts.as_slice() {
            [k, s, i] => {
                let kind = match *k {
                    "t" => Some(Kind::Thumb),
                    "q" => Some(Kind::Quick),
                    "p" => Some(Kind::Preview),
                    "m" => Some(Kind::Medium),
                    "f" => Some(Kind::Full),
                    "o" => Some(Kind::Base),
                    _ => None,
                };
                kind.zip(s.parse::<u64>().ok()).zip(i.parse::<u32>().ok()).map(|((k, s), i)| (k, s, i))
            }
            _ => None,
        };
        let Some((kind, session, id)) = parsed else {
            return respond_status(responder, StatusCode::BAD_REQUEST);
        };
        let sess = self.current();
        let Some(item) = sess.items.get(id as usize).filter(|_| sess.id == session) else {
            return respond_status(responder, StatusCode::NOT_FOUND);
        };
        let key = item.display().cache_key();
        let hit = match kind {
            Kind::Thumb | Kind::Quick => self.mem_thumbs.lock().get(&key).cloned(),
            Kind::Preview => self.mem_previews.lock().get(&key).cloned(),
            Kind::Medium => self.mem_medium.lock().get(&key).cloned(),
            Kind::Full | Kind::Base => None,
        };
        if let Some(bytes) = hit {
            if matches!(kind, Kind::Thumb | Kind::Quick) {
                self.mark_done(session, id);
            }
            return respond(responder, StatusCode::OK, "image/jpeg", bytes.as_ref().clone(), true);
        }
        let job = Job { session, id, kind, responder };
        let mut q = self.queue.lock();
        match kind {
            Kind::Quick => q.quick.push_back(job),
            Kind::Thumb => q.low.push_back(job),
            _ => q.high.push(job),
        }
        drop(q);
        self.cv.notify_one();
    }

    fn worker(&self) {
        loop {
            let task = {
                let mut q = self.queue.lock();
                loop {
                    if let Some(j) = q.quick.pop_front() {
                        break Task::Job(j);
                    }
                    if let Some(j) = q.high.pop() {
                        break Task::Job(j);
                    }
                    if let Some(j) = q.low.pop_front() {
                        break Task::Job(j);
                    }
                    if self.prefetching.load(Ordering::Relaxed) < self.max_prefetch {
                        if let Some((s, id)) = self.next_prefetch() {
                            self.prefetching.fetch_add(1, Ordering::Relaxed);
                            break Task::Prefetch(s, id);
                        }
                    }
                    self.cv.wait(&mut q);
                }
            };
            match task {
                Task::Job(job) => {
                    self.active.fetch_add(1, Ordering::Relaxed);
                    self.process(job);
                    self.active.fetch_sub(1, Ordering::Relaxed);
                }
                Task::Prefetch(s, id) => {
                    self.prefetch(s, id);
                    self.prefetching.fetch_sub(1, Ordering::Relaxed);
                    self.cv.notify_one();
                }
            }
        }
    }

    fn process(&self, job: Job) {
        let sess = self.current();
        if sess.id != job.session {
            return respond_status(job.responder, StatusCode::NOT_FOUND);
        }
        if matches!(job.kind, Kind::Thumb | Kind::Quick) {
            let vp = self.viewport.read();
            if vp.0 == job.session && !vp.1.is_empty() && !vp.1.contains(&job.id) {
                drop(vp);
                return respond_status(job.responder, StatusCode::GONE);
            }
        }
        let Some(item) = sess.items.get(job.id as usize) else {
            return respond_status(job.responder, StatusCode::NOT_FOUND);
        };
        let key = item.display().cache_key();

        // 文字檔：縮圖 / 預覽都是「紙張」SVG（每次現做，內容改了馬上看得到）
        if item.is_text() {
            if job.kind == Kind::Quick {
                return respond_status(job.responder, StatusCode::NOT_FOUND);
            }
            if job.kind == Kind::Thumb {
                self.mark_done(job.session, job.id);
            }
            let f = item.display();
            let svg = crate::text::thumb_svg(&crate::text::read_head(&f.path, 4096), &f.ext);
            return respond(job.responder, StatusCode::OK, "image/svg+xml", svg, false);
        }

        if matches!(job.kind, Kind::Thumb | Kind::Quick) {
            if let Some(bytes) = self.cache.get_thumb(&disk_key(item)) {
                self.mark_done(job.session, job.id);
                let bytes = Arc::new(bytes);
                self.mem_thumbs.lock().put(key, bytes.clone());
                return respond(job.responder, StatusCode::OK, "image/jpeg", bytes.as_ref().clone(), true);
            }
        }
        // 快速小縮圖：沒有正式縮圖時取內嵌的小圖（沒有就回 404，前端直接等正式縮圖）
        if job.kind == Kind::Quick {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render::render_quick(item)));
            return match r {
                Ok(Ok(Some(bytes))) => respond(job.responder, StatusCode::OK, "image/jpeg", bytes, false),
                _ => respond_status(job.responder, StatusCode::NOT_FOUND),
            };
        }

        // 解碼 / 套用調整時萬一 panic：回傳預留圖，不要讓請求永遠沒有回應（畫面會一直「載入中」）
        let guard = |f: &dyn Fn() -> anyhow::Result<Vec<u8>>| -> anyhow::Result<Vec<u8>> {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| Err(anyhow::anyhow!("render panicked")))
        };
        if job.kind == Kind::Medium {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| render::render_medium(item)))
                .unwrap_or_else(|_| Err(anyhow::anyhow!("render panicked")));
            return match r {
                Ok((bytes, is_full)) => {
                    let arc = Arc::new(bytes.clone());
                    self.mem_medium.lock().put(key.clone(), arc.clone());
                    if is_full {
                        self.mem_previews.lock().put(key, arc);
                    }
                    respond(job.responder, StatusCode::OK, "image/jpeg", bytes, true)
                }
                Err(e) => {
                    eprintln!("render failed {}: {e:#}", item.display().path.display());
                    respond(job.responder, StatusCode::OK, "image/svg+xml", render::placeholder(&item.display().ext), false)
                }
            };
        }
        match guard(&|| render::render(item, job.kind)) {
            Ok(bytes) => {
                match job.kind {
                    Kind::Thumb | Kind::Quick => {
                        self.mark_done(job.session, job.id);
                        self.cache.put_thumb(&disk_key(item), &bytes);
                        self.mem_thumbs.lock().put(key, Arc::new(bytes.clone()));
                    }
                    Kind::Medium => {
                        self.mem_medium.lock().put(key, Arc::new(bytes.clone()));
                    }
                    Kind::Preview => {
                        self.mem_previews.lock().put(key, Arc::new(bytes.clone()));
                    }
                    Kind::Full | Kind::Base => {}
                }
                respond(job.responder, StatusCode::OK, "image/jpeg", bytes, true);
            }
            Err(e) => {
                eprintln!("render failed {}: {e:#}", item.display().path.display());
                respond(job.responder, StatusCode::OK, "image/svg+xml", render::placeholder(&item.display().ext), false);
            }
        }
    }

    /// 取得某項目的縮圖 JPEG（記憶體 → 磁碟快取 → 現算），給拖曳圖示等用途
    pub fn thumb_bytes(&self, item: &Item) -> anyhow::Result<Arc<Vec<u8>>> {
        if item.is_text() {
            return Ok(Arc::new(crate::text::paper_jpeg()?));
        }
        let key = item.display().cache_key();
        if let Some(b) = self.mem_thumbs.lock().get(&key).cloned() {
            return Ok(b);
        }
        if let Some(b) = self.cache.get_thumb(&disk_key(item)) {
            let b = Arc::new(b);
            self.mem_thumbs.lock().put(key, b.clone());
            return Ok(b);
        }
        let bytes = render::render(item, Kind::Thumb)?;
        self.cache.put_thumb(&disk_key(item), &bytes);
        let b = Arc::new(bytes);
        self.mem_thumbs.lock().put(key, b.clone());
        Ok(b)
    }

    /// 丟掉某個項目的縮圖與預覽快取，下次要圖時重新產生
    pub fn forget(&self, item: &Item) {
        let key = item.display().cache_key();
        self.mem_thumbs.lock().pop(&key);
        self.mem_previews.lock().pop(&key);
        self.mem_medium.lock().pop(&key);
        self.cache.delete_thumb(&key.0);
        self.done.lock().1.remove(&item.id);
    }

    pub fn clear_memory(&self) {
        self.mem_thumbs.lock().clear();
        self.mem_previews.lock().clear();
        self.mem_medium.lock().clear();
    }
}
