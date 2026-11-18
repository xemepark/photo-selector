//! 核心狀態與縮圖排程。
//!
//! 前端用 `<img src="img://localhost/t/<session>/<id>">` 要圖，請求進到這裡：
//!
//! 1. 記憶體 LRU 命中 → 立刻回應（不進佇列）
//! 2. 否則放進工作佇列：預覽 / 原圖走「高優先」，縮圖走「低優先」
//! 3. 佇列是 LIFO（後進先出）：使用者快速捲動時，最新捲到的畫面最先處理
//! 4. 工作者取出縮圖工作時，若該項目已不在前端回報的「可視範圍」內就直接取消（410），
//!    前端等它再次出現在畫面上時才重新要求 —— 快速捲過一萬張照片也不會塞車
//! 5. 縮圖結果寫入 SQLite 磁碟快取，下次開同一個資料夾就不必重新解碼

use crate::cache::Cache;
use crate::render::{self, Kind};
use crate::scan::Item;
use lru::LruCache;
use parking_lot::{Condvar, Mutex, RwLock};
use std::collections::HashSet;
use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
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
    high: Vec<Job>,
    low: Vec<Job>,
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
        });
        let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).saturating_sub(1).max(2);
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
            v.append(&mut q.low);
            v
        };
        for j in stale {
            respond_status(j.responder, StatusCode::NOT_FOUND);
        }
        s
    }

    pub fn set_viewport(&self, session: u64, ids: Vec<u32>) {
        *self.viewport.write() = (session, ids.into_iter().collect());
    }

    /// 處理 `img://` 請求。路徑格式：/<t|p|f>/<session>/<id>
    pub fn submit(&self, path: &str, responder: UriSchemeResponder) {
        let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
        let parsed = match parts.as_slice() {
            [k, s, i] => {
                let kind = match *k {
                    "t" => Some(Kind::Thumb),
                    "p" => Some(Kind::Preview),
                    "m" => Some(Kind::Medium),
                    "f" => Some(Kind::Full),
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
            Kind::Thumb => self.mem_thumbs.lock().get(&key).cloned(),
            Kind::Preview => self.mem_previews.lock().get(&key).cloned(),
            Kind::Medium => self.mem_medium.lock().get(&key).cloned(),
            Kind::Full => None,
        };
        if let Some(bytes) = hit {
            return respond(responder, StatusCode::OK, "image/jpeg", bytes.as_ref().clone(), true);
        }
        let job = Job { session, id, kind, responder };
        let mut q = self.queue.lock();
        if kind == Kind::Thumb { q.low.push(job) } else { q.high.push(job) }
        drop(q);
        self.cv.notify_one();
    }

    fn worker(&self) {
        loop {
            let job = {
                let mut q = self.queue.lock();
                loop {
                    if let Some(j) = q.high.pop() {
                        break j;
                    }
                    if let Some(j) = q.low.pop() {
                        break j;
                    }
                    self.cv.wait(&mut q);
                }
            };
            self.process(job);
        }
    }

    fn process(&self, job: Job) {
        let sess = self.current();
        if sess.id != job.session {
            return respond_status(job.responder, StatusCode::NOT_FOUND);
        }
        if job.kind == Kind::Thumb {
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

        if job.kind == Kind::Thumb {
            if let Some(bytes) = self.cache.get_thumb(&key) {
                let bytes = Arc::new(bytes);
                self.mem_thumbs.lock().put(key, bytes.clone());
                return respond(job.responder, StatusCode::OK, "image/jpeg", bytes.as_ref().clone(), true);
            }
        }

        if job.kind == Kind::Medium {
            return match render::render_medium(item) {
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
        match render::render(item, job.kind) {
            Ok(bytes) => {
                match job.kind {
                    Kind::Thumb => {
                        self.cache.put_thumb(&key, &bytes);
                        self.mem_thumbs.lock().put(key, Arc::new(bytes.clone()));
                    }
                    Kind::Medium => {
                        self.mem_medium.lock().put(key, Arc::new(bytes.clone()));
                    }
                    Kind::Preview => {
                        self.mem_previews.lock().put(key, Arc::new(bytes.clone()));
                    }
                    Kind::Full => {}
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
        let key = item.display().cache_key();
        if let Some(b) = self.mem_thumbs.lock().get(&key).cloned() {
            return Ok(b);
        }
        if let Some(b) = self.cache.get_thumb(&key) {
            let b = Arc::new(b);
            self.mem_thumbs.lock().put(key, b.clone());
            return Ok(b);
        }
        let bytes = render::render(item, Kind::Thumb)?;
        self.cache.put_thumb(&key, &bytes);
        let b = Arc::new(bytes);
        self.mem_thumbs.lock().put(key, b.clone());
        Ok(b)
    }

    pub fn clear_memory(&self) {
        self.mem_thumbs.lock().clear();
        self.mem_previews.lock().clear();
        self.mem_medium.lock().clear();
    }
}
