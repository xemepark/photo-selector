//! 極簡 TIFF IFD 走訪器：只為了從 TIFF 架構的 RAW 檔（CR2、NEF、ARW、DNG、ORF、
//! RW2、PEF、SRW…）找出內嵌預覽圖的位置與方向（Orientation）。
//! 不追求完整解析，只讀需要的少數幾個 tag，並對壞檔做好防護。

use std::collections::HashSet;

pub struct TiffInfo {
    /// (offset, length) — 候選的內嵌 JPEG
    pub previews: Vec<(usize, usize)>,
    pub orientation: Option<u16>,
}

struct R<'a> {
    d: &'a [u8],
    le: bool,
}

impl R<'_> {
    fn u16(&self, p: usize) -> Option<u16> {
        let b = [*self.d.get(p)?, *self.d.get(p + 1)?];
        Some(if self.le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) })
    }
    fn u32(&self, p: usize) -> Option<u32> {
        let b = [*self.d.get(p)?, *self.d.get(p + 1)?, *self.d.get(p + 2)?, *self.d.get(p + 3)?];
        Some(if self.le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) })
    }
    /// 讀取一個 IFD entry 的數值陣列（SHORT / LONG / IFD），最多 64 個
    fn values(&self, entry: usize) -> Vec<u32> {
        let (Some(typ), Some(count)) = (self.u16(entry + 2), self.u32(entry + 4)) else {
            return vec![];
        };
        let size = match typ {
            3 => 2,
            4 | 13 => 4,
            _ => return vec![],
        };
        let count = count.min(64) as usize;
        let base = if size * count <= 4 {
            entry + 8
        } else {
            match self.u32(entry + 8) {
                Some(o) => o as usize,
                None => return vec![],
            }
        };
        (0..count)
            .filter_map(|i| {
                let p = base + i * size;
                if size == 2 { self.u16(p).map(u32::from) } else { self.u32(p) }
            })
            .collect()
    }
}

pub fn parse(data: &[u8]) -> Option<TiffInfo> {
    if data.len() < 16 {
        return None;
    }
    let le = match &data[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let r = R { d: data, le };
    let first = r.u32(4)? as usize;

    let mut info = TiffInfo { previews: vec![], orientation: None };
    let mut queue: Vec<(usize, bool)> = vec![(first, true)];
    let mut seen = HashSet::new();

    while let Some((off, is_ifd0)) = queue.pop() {
        if off < 8 || off >= data.len() || !seen.insert(off) || seen.len() > 64 {
            continue;
        }
        let Some(n) = r.u16(off) else { continue };
        let n = n as usize;
        if n == 0 || n > 1000 || off + 2 + n * 12 > data.len() {
            continue;
        }
        let (mut compression, mut strips, mut strip_lens) = (0u32, vec![], vec![]);
        let (mut jpg_off, mut jpg_len) = (None, None);
        for i in 0..n {
            let e = off + 2 + i * 12;
            let Some(tag) = r.u16(e) else { continue };
            match tag {
                0x0103 => compression = r.values(e).first().copied().unwrap_or(0),
                0x0111 => strips = r.values(e),
                0x0117 => strip_lens = r.values(e),
                0x0201 => jpg_off = r.values(e).first().copied(),
                0x0202 => jpg_len = r.values(e).first().copied(),
                0x0112 if is_ifd0 => info.orientation = r.values(e).first().map(|v| *v as u16),
                0x014A => {
                    for v in r.values(e) {
                        queue.push((v as usize, false));
                    }
                }
                // Panasonic RW2 的 JpgFromRaw（UNDEFINED 型別，count = 長度）
                0x002E if r.u16(e + 2) == Some(7) => {
                    if let (Some(len), Some(o)) = (r.u32(e + 4), r.u32(e + 8)) {
                        info.previews.push((o as usize, len as usize));
                    }
                }
                _ => {}
            }
        }
        if let (Some(o), Some(l)) = (jpg_off, jpg_len) {
            info.previews.push((o as usize, l as usize));
        }
        if (compression == 6 || compression == 7) && strips.len() == 1 && strip_lens.len() == 1 {
            info.previews.push((strips[0] as usize, strip_lens[0] as usize));
        }
        if let Some(next) = r.u32(off + 2 + n * 12) {
            if next != 0 {
                queue.push((next as usize, false));
            }
        }
    }
    Some(info)
}

/// Canon CR3（ISO BMFF）把 EXIF 放在 CMT1/CMT2… box，每個 box 內容都是一個 TIFF。
pub fn find_box<'a>(data: &'a [u8], fourcc: &[u8; 4]) -> Option<&'a [u8]> {
    let head = &data[..data.len().min(1024 * 1024)];
    let pos = memchr::memmem::find(head, fourcc)?;
    if pos < 4 {
        return None;
    }
    let size = u32::from_be_bytes(data[pos - 4..pos].try_into().ok()?) as usize;
    let end = (pos - 4).checked_add(size)?;
    data.get(pos + 4..end)
}

pub fn is_cr3(data: &[u8]) -> bool {
    data.len() > 12 && &data[4..8] == b"ftyp" && &data[8..12] == b"crx "
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_ifd_with_jpeg_preview_and_orientation() {
        // 小端 TIFF：IFD0 有 Orientation=6 與 JPEGInterchangeFormat
        let mut d = b"II*\0".to_vec();
        d.extend_from_slice(&8u32.to_le_bytes());
        d.extend_from_slice(&3u16.to_le_bytes());
        let entry = |tag: u16, typ: u16, val: u32| {
            let mut e = tag.to_le_bytes().to_vec();
            e.extend_from_slice(&typ.to_le_bytes());
            e.extend_from_slice(&1u32.to_le_bytes());
            e.extend_from_slice(&val.to_le_bytes());
            e
        };
        d.extend(entry(0x0112, 3, 6));
        d.extend(entry(0x0201, 4, 100));
        d.extend(entry(0x0202, 4, 2000));
        d.extend_from_slice(&0u32.to_le_bytes());
        let t = parse(&d).unwrap();
        assert_eq!(t.orientation, Some(6));
        assert_eq!(t.previews, vec![(100, 2000)]);
    }
}
