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
             DROP TABLE IF EXISTS sharpness;
             CREATE TABLE IF NOT EXISTS analysis (
               path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL,
               version INTEGER NOT NULL, json TEXT NOT NULL);",
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

    /// 選片分析結果（JSON）。`version` 不同代表演算法更新過，需要重新分析
    pub fn get_analysis(&self, k: &Key, version: i64) -> Option<String> {
        self.conn
            .lock()
            .query_row(
                "SELECT json FROM analysis WHERE path=?1 AND mtime=?2 AND size=?3 AND version=?4",
                params![k.0, k.1, k.2, version],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }

    pub fn put_analysis(&self, k: &Key, version: i64, json: &str) {
        let _ = self.conn.lock().execute(
            "INSERT OR REPLACE INTO analysis (path, mtime, size, version, json) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![k.0, k.1, k.2, version, json],
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

    /// 檔案因為本程式寫入評等 / 標籤而改變了修改時間與大小：快取內容仍然有效，只要更新鍵值
    pub fn rekey(&self, path: &str, mtime: i64, size: i64) {
        let c = self.conn.lock();
        let _ = c.execute("UPDATE thumbs SET mtime=?2, size=?3 WHERE path=?1", params![path, mtime, size]);
        let _ = c.execute("UPDATE analysis SET mtime=?2, size=?3 WHERE path=?1", params![path, mtime, size]);
    }

    pub fn clear(&self) -> Result<()> {
        let c = self.conn.lock();
        c.execute_batch("DELETE FROM thumbs; DELETE FROM analysis;")?;
        c.execute_batch("VACUUM;")?;
        Ok(())
    }
}
