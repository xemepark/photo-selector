//! 影片（MP4 / MOV / M4V）：長度（讀 moov/mvhd）、縮圖（macOS 內建的快速查看 qlmanage 產生）。

use anyhow::{anyhow, Result};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{Duration, Instant};

pub const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v"];

fn read_box_header(f: &mut File) -> Option<(u64, [u8; 4], u64)> {
    let mut h = [0u8; 8];
    f.read_exact(&mut h).ok()?;
    let mut size = u32::from_be_bytes([h[0], h[1], h[2], h[3]]) as u64;
    let typ = [h[4], h[5], h[6], h[7]];
    let mut header = 8u64;
    if size == 1 {
        let mut l = [0u8; 8];
        f.read_exact(&mut l).ok()?;
        size = u64::from_be_bytes(l);
        header = 16;
    } else if size == 0 {
        let pos = f.stream_position().ok()?;
        let end = f.metadata().ok()?.len();
        size = end - pos + 8;
    }
    Some((size, typ, header))
}

/// 影片長度（秒）：在最上層找 moov，再找 mvhd 讀 timescale 與 duration
pub fn duration(path: &Path) -> Option<f64> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut pos = 0u64;
    for _ in 0..64 {
        if pos + 8 > len {
            return None;
        }
        f.seek(SeekFrom::Start(pos)).ok()?;
        let (size, typ, header) = read_box_header(&mut f)?;
        if size < header {
            return None;
        }
        if &typ == b"moov" {
            let end = pos + size;
            let mut p = pos + header;
            for _ in 0..64 {
                if p + 8 > end {
                    return None;
                }
                f.seek(SeekFrom::Start(p)).ok()?;
                let (s2, t2, h2) = read_box_header(&mut f)?;
                if &t2 == b"mvhd" {
                    let mut b = [0u8; 32];
                    f.read_exact(&mut b).ok()?;
                    let (ts, du) = if b[0] == 1 {
                        (u32::from_be_bytes(b[20..24].try_into().ok()?) as f64, u64::from_be_bytes(b[24..32].try_into().ok()?) as f64)
                    } else {
                        (u32::from_be_bytes(b[12..16].try_into().ok()?) as f64, u32::from_be_bytes(b[16..20].try_into().ok()?) as f64)
                    };
                    return (ts > 0.0).then(|| du / ts);
                }
                if s2 < h2 {
                    return None;
                }
                p += s2;
            }
            return None;
        }
        pos += size;
    }
    None
}

/// 影片縮圖（PNG 位元組）：macOS 的 qlmanage（與 Finder 縮圖相同），最多等 20 秒
pub fn thumbnail_png(path: &Path, size: u32) -> Result<Vec<u8>> {
    if !cfg!(target_os = "macos") {
        return ffmpeg_png(path, size);
    }
    let dir = std::env::temp_dir().join(format!(
        "photo-selector-ql-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir)?;
    let mut child = std::process::Command::new("qlmanage")
        .arg("-t")
        .arg("-s")
        .arg(size.to_string())
        .arg("-o")
        .arg(&dir)
        .arg(path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let start = Instant::now();
    loop {
        if child.try_wait()?.is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(20) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&dir);
            return Err(anyhow!("產生影片縮圖逾時"));
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    let png = std::fs::read_dir(&dir)?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("png")))
        .ok_or_else(|| anyhow!("沒有產生影片縮圖"))
        .and_then(|p| Ok(std::fs::read(p)?));
    let _ = std::fs::remove_dir_all(&dir);
    png
}

/// 非 macOS：有安裝 ffmpeg 時用它擷取第 1 秒的畫面
fn ffmpeg_png(path: &Path, size: u32) -> Result<Vec<u8>> {
    let out = std::process::Command::new("ffmpeg")
        .args(["-v", "error", "-ss", "1", "-i"])
        .arg(path)
        .args(["-frames:v", "1", "-vf", &format!("scale='min({size},iw)':-2"), "-f", "image2pipe", "-vcodec", "png", "-"])
        .output()
        .map_err(|e| anyhow!("無法產生影片縮圖：{e}"))?;
    if out.stdout.is_empty() {
        return Err(anyhow!("無法產生影片縮圖"));
    }
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_mvhd_duration() {
        // ftyp + moov{mvhd(version 0, timescale 1000, duration 161500)}
        let mut d = Vec::new();
        d.extend_from_slice(&16u32.to_be_bytes());
        d.extend_from_slice(b"ftypisom\0\0\0\0");
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&161500u32.to_be_bytes());
        let mut mvhd_box = ((mvhd.len() + 8) as u32).to_be_bytes().to_vec();
        mvhd_box.extend_from_slice(b"mvhd");
        mvhd_box.extend_from_slice(&mvhd);
        d.extend_from_slice(&((mvhd_box.len() + 8) as u32).to_be_bytes());
        d.extend_from_slice(b"moov");
        d.extend_from_slice(&mvhd_box);
        let p = std::env::temp_dir().join(format!("ps-mvhd-{}.mp4", std::process::id()));
        std::fs::write(&p, &d).unwrap();
        assert_eq!(duration(&p), Some(161.5));
        std::fs::remove_file(&p).unwrap();
    }
}
