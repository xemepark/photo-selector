//! 持久化磁碟快取（SQLite）：縮圖與清晰度分數。
//! 鍵值 = 路徑 + 修改時間 + 檔案大小，任一改變就視為新檔案。

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};

pub type Key = (String, i64, i64);

pub struct Cache {
    conn: Mutex<Connection>,
    pub path: PathBuf,
}

impl Cache {
    pub fn open(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("cache.db");
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS thumbs (
               path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS sharpness (
               path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL, score REAL NOT NULL);",
        )?;
        Ok(Self { conn: Mutex::new(conn), path })
    }

    pub fn get_thumb(&self, k: &Key) -> Option<Vec<u8>> {
        self.conn
            .lock()
            .query_row(
                "SELECT data FROM thumbs WHERE path=?1 AND mtime=?2 AND size=?3",
                params![k.0, k.1, k.2],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn put_thumb(&self, k: &Key, data: &[u8]) {
        let _ = self.conn.lock().execute(
            "INSERT OR REPLACE INTO thumbs (path, mtime, size, data) VALUES (?1, ?2, ?3, ?4)",
            params![k.0, k.1, k.2, data],
        );
    }

    pub fn get_sharpness(&self, k: &Key) -> Option<f32> {
        self.conn
            .lock()
            .query_row(
                "SELECT score FROM sharpness WHERE path=?1 AND mtime=?2 AND size=?3",
                params![k.0, k.1, k.2],
                |r| r.get::<_, f64>(0),
            )
            .optional()
            .ok()
            .flatten()
            .map(|v| v as f32)
    }

    pub fn put_sharpness(&self, k: &Key, score: f32) {
        let _ = self.conn.lock().execute(
            "INSERT OR REPLACE INTO sharpness (path, mtime, size, score) VALUES (?1, ?2, ?3, ?4)",
            params![k.0, k.1, k.2, score as f64],
        );
    }

    pub fn size_bytes(&self) -> u64 {
        let c = self.conn.lock();
        c.query_row("SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()", [], |r| {
            r.get::<_, i64>(0)
        })
        .map(|v| v as u64)
        .unwrap_or(0)
    }

    pub fn clear(&self) -> Result<()> {
        let c = self.conn.lock();
        c.execute_batch("DELETE FROM thumbs; DELETE FROM sharpness;")?;
        c.execute_batch("VACUUM;")?;
        Ok(())
    }
}
