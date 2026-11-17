//! 在任意檔案（RAW、PSD、JPEG…）中尋找「內嵌的 JPEG 預覽圖」。
//!
//! 這是整個縮圖系統快的關鍵：相機在 RAW 檔裡幾乎都會放一張（甚至好幾張）
//! 已經算好的 JPEG。只要找到它、只解碼它，就完全不需要做 RAW 解馬賽克。
//!
//! 策略（由快到慢）：
//! 1. TIFF 架構的 RAW（CR2/NEF/ARW/DNG/ORF/RW2/PEF…）直接走 IFD 找預覽圖的 offset，
//!    只會讀到檔頭與預覽圖本身的頁面（搭配 mmap，不會把 50MB 的 RAW 全部讀進來）。
//! 2. Fuji RAF 檔頭直接記錄 JPEG 的位置。
//! 3. 都找不到時，掃描檔案前段 / 全檔尋找 JPEG 的 SOI 標記，並驗證其結構。

use std::ops::Range;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbeddedJpeg {
    pub offset: usize,
    pub len: usize,
    pub width: u32,
    pub height: u32,
}

impl EmbeddedJpeg {
    pub fn long_edge(&self) -> u32 {
        self.width.max(self.height)
    }
    pub fn bytes<'a>(&self, data: &'a [u8]) -> &'a [u8] {
        &data[self.offset..self.offset + self.len]
    }
}

fn be16(d: &[u8], p: usize) -> Option<usize> {
    Some(u16::from_be_bytes([*d.get(p)?, *d.get(p + 1)?]) as usize)
}

/// 嘗試把 `data[offset..]` 解析成一張完整的 JPEG。
/// 會拒絕無損 JPEG（SOF3，CR2/DNG 用來存 RAW 資料本體）與其他非預覽用途的格式。
pub fn parse_at(data: &[u8], offset: usize) -> Option<EmbeddedJpeg> {
    let d = data.get(offset..)?;
    let (len, width, height) = parse_jpeg(d)?;
    if width < 32 || height < 32 || len < 512 {
        return None;
    }
    Some(EmbeddedJpeg { offset, len, width, height })
}

/// 回傳 (總長度, 寬, 高)
fn parse_jpeg(d: &[u8]) -> Option<(usize, u32, u32)> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let n = d.len();
    let mut p = 2;
    let mut dims: Option<(u32, u32)> = None;

    // 1) 走過所有 marker segment 直到 SOS
    loop {
        if p >= n || d[p] != 0xFF {
            return None;
        }
        while p < n && d[p] == 0xFF {
            p += 1;
        }
        if p >= n {
            return None;
        }
        let m = d[p];
        p += 1;
        match m {
            0xD8 | 0xD9 | 0x00 => return None,
            0x01 | 0xD0..=0xD7 => continue,
            _ => {
                let seg = be16(d, p)?;
                if seg < 2 || p + seg > n {
                    return None;
                }
                match m {
                    // Baseline / Extended / Progressive（Huffman）—— 一般預覽圖
                    0xC0 | 0xC1 | 0xC2 => {
                        if seg < 8 {
                            return None;
                        }
                        let h = be16(d, p + 3)? as u32;
                        let w = be16(d, p + 5)? as u32;
                        dims = Some((w, h));
                    }
                    // 無損、階層式、算術編碼 —— 不是我們要的預覽圖
                    0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF => return None,
                    0xDA => {
                        p += seg;
                        break;
                    }
                    _ => {}
                }
                p += seg;
            }
        }
    }
    let (w, h) = dims?;
    if w == 0 || h == 0 {
        return None;
    }

    // 2) 掃過熵編碼資料，直到 EOI（progressive JPEG 中間會穿插 DHT / SOS 等 segment）
    loop {
        let i = memchr::memchr(0xFF, d.get(p..)?)?;
        p += i + 1;
        let b = *d.get(p)?;
        match b {
            0x00 | 0xD0..=0xD7 => p += 1,
            0xFF => {}
            0xD9 => return Some((p + 1, w, h)),
            0xD8 => return None,
            _ => {
                p += 1;
                let seg = be16(d, p)?;
                if seg < 2 {
                    return None;
                }
                p += seg;
            }
        }
    }
}

/// 在 `range` 範圍內尋找 JPEG 起點（實際長度可以超出 range）。
pub fn scan(data: &[u8], range: Range<usize>) -> Vec<EmbeddedJpeg> {
    let finder = memchr::memmem::Finder::new(&[0xFF, 0xD8, 0xFF]);
    let end = range.end.min(data.len());
    let mut out = Vec::new();
    let mut pos = range.start;
    while pos < end {
        let Some(i) = finder.find(&data[pos..end]) else { break };
        let start = pos + i;
        match parse_at(data, start) {
            Some(j) => {
                out.push(j);
                // 跳過這張 JPEG（裡面的 EXIF 小縮圖就不再重複列出）
                pos = start + j.len;
            }
            None => pos = start + 3,
        }
    }
    out
}

/// JPEG 檔頭裡的尺寸（SOF），只讀檔頭
pub fn jpeg_dims(data: &[u8]) -> Option<(u32, u32)> {
    let mut found = None;
    walk_header(data, |m, body| {
        if matches!(m, 0xC0 | 0xC1 | 0xC2) && body.len() >= 5 {
            let h = u16::from_be_bytes([body[1], body[2]]) as u32;
            let w = u16::from_be_bytes([body[3], body[4]]) as u32;
            found = Some((w, h));
            return false;
        }
        true
    });
    found
}

/// 走過 JPEG 檔頭的 marker segment（直到 SOS 為止）。callback 回傳 false 就停止。
/// `body` 是 segment 內容（不含 marker 與長度欄位）。
fn walk_header(data: &[u8], mut f: impl FnMut(u8, &[u8]) -> bool) {
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return;
    }
    let mut p = 2;
    while p + 4 <= data.len() {
        if data[p] != 0xFF {
            return;
        }
        let m = data[p + 1];
        match m {
            0xFF => {
                p += 1;
                continue;
            }
            0x01 | 0xD0..=0xD7 => {
                p += 2;
                continue;
            }
            0xD8 | 0xD9 | 0xDA => return,
            _ => {}
        }
        let Some(seg) = be16(data, p + 2) else { return };
        let end = p + 2 + seg;
        if seg < 2 || end > data.len() {
            return;
        }
        if !f(m, &data[p + 4..end]) {
            return;
        }
        p = end;
    }
}

/// 相機直出 JPEG 本身內嵌的小預覽圖：
/// - EXIF 縮圖（APP1 / IFD1，約 160×120）
/// - MPF 多圖格式的預覽（APP2，Sony / Canon / Nikon 等約 1616×1080），位於主影像之後
///
/// 只讀檔頭與預覽圖本身（搭配 mmap 只會讀到幾百 KB），不需要讀完 20MB 以上的整張原圖。
pub fn jpeg_file_previews(data: &[u8]) -> Vec<EmbeddedJpeg> {
    let mut out = Vec::new();
    let base_of = |body: &[u8]| body.as_ptr() as usize - data.as_ptr() as usize;
    walk_header(data, |m, body| {
        if m == 0xE1 && body.starts_with(b"Exif\0\0") {
            let tiff_base = base_of(body) + 6;
            if let Some(t) = crate::tiff::parse(&body[6..]) {
                for (o, _) in t.previews {
                    if let Some(j) = parse_at(data, tiff_base + o) {
                        out.push(j);
                    }
                }
            }
        } else if m == 0xE2 && body.starts_with(b"MPF\0") {
            let base = base_of(body) + 4;
            for (off, _size) in mpf_entries(&body[4..]) {
                if let Some(j) = parse_at(data, base + off) {
                    out.push(j);
                }
            }
        }
        true
    });
    out
}

/// 解析 MPF（CIPA DC-007）的 MP Entry，回傳第 2 張以後影像的 (相對於 MP 標頭的位移, 大小)
fn mpf_entries(d: &[u8]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    if d.len() < 8 {
        return out;
    }
    let le = match &d[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return out,
    };
    let u16_at = |p: usize| d.get(p..p + 2).map(|b| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) });
    let u32_at = |p: usize| {
        d.get(p..p + 4).map(|b| {
            let a = [b[0], b[1], b[2], b[3]];
            if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) }
        })
    };
    let Some(ifd) = u32_at(4) else { return out };
    let ifd = ifd as usize;
    let Some(n) = u16_at(ifd) else { return out };
    for i in 0..n.min(64) as usize {
        let e = ifd + 2 + i * 12;
        if u16_at(e) != Some(0xB002) {
            continue;
        }
        let (Some(count), Some(off)) = (u32_at(e + 4), u32_at(e + 8)) else { break };
        for k in 1..(count / 16).min(16) as usize {
            let ent = off as usize + k * 16;
            if let (Some(size), Some(ioff)) = (u32_at(ent + 4), u32_at(ent + 8)) {
                if ioff > 0 && size > 0 {
                    out.push((ioff as usize, size as usize));
                }
            }
        }
    }
    out
}

const HEAD_SCAN: usize = 8 * 1024 * 1024;

/// 找出檔案中所有可用的內嵌 JPEG。`min_long` 是期望的最小長邊；
/// 如果快速路徑已經找到夠大的圖，就不做全檔掃描。
pub fn embedded_jpegs(data: &[u8], min_long: u32) -> Vec<EmbeddedJpeg> {
    let mut v: Vec<EmbeddedJpeg> = Vec::new();

    if let Some(t) = crate::tiff::parse(data) {
        for (o, _l) in t.previews {
            if let Some(j) = parse_at(data, o) {
                v.push(j);
            }
        }
    }
    if data.starts_with(b"FUJIFILMCCD-RAW") && data.len() > 92 {
        let off = u32::from_be_bytes([data[84], data[85], data[86], data[87]]) as usize;
        if let Some(j) = parse_at(data, off) {
            v.push(j);
        }
    }
    let enough = |v: &Vec<EmbeddedJpeg>| v.iter().any(|j| j.long_edge() >= min_long);
    if !enough(&v) {
        v.extend(scan(data, 0..HEAD_SCAN));
        if !enough(&v) && data.len() > HEAD_SCAN {
            v.extend(scan(data, HEAD_SCAN..data.len()));
        }
    }
    v.sort_by_key(|j| j.offset);
    v.dedup_by_key(|j| j.offset);
    v
}

/// 挑選「長邊 ≥ min_long 中最小的一張」，解碼最省時間；都不夠大就挑最大的。
pub fn pick(v: &[EmbeddedJpeg], min_long: u32) -> Option<EmbeddedJpeg> {
    v.iter()
        .filter(|j| j.long_edge() >= min_long)
        .min_by_key(|j| j.width as u64 * j.height as u64)
        .or_else(|| v.iter().max_by_key(|j| j.width as u64 * j.height as u64))
        .copied()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn make_jpeg(w: u16, h: u16) -> Vec<u8> {
        let mut px = Vec::with_capacity(w as usize * h as usize * 3);
        for y in 0..h {
            for x in 0..w {
                px.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, ((x ^ y) % 256) as u8]);
            }
        }
        let mut buf = Vec::new();
        jpeg_encoder::Encoder::new(&mut buf, 80)
            .encode(&px, w, h, jpeg_encoder::ColorType::Rgb)
            .unwrap();
        buf
    }

    #[test]
    fn parses_plain_jpeg() {
        let j = make_jpeg(640, 480);
        let e = parse_at(&j, 0).unwrap();
        assert_eq!((e.width, e.height, e.len), (640, 480, j.len()));
    }

    #[test]
    fn finds_embedded_and_picks_best() {
        let small = make_jpeg(160, 120);
        let mid = make_jpeg(800, 600);
        let big = make_jpeg(1600, 1200);
        let mut file = b"NOTARAWFILE".to_vec();
        file.extend(std::iter::repeat(0xABu8).take(5000));
        // 一段假的「無損 JPEG」（SOF3），必須被忽略
        file.extend_from_slice(&[0xFF, 0xD8, 0xFF, 0xC3, 0x00, 0x0B, 8, 0, 100, 0, 100, 1, 1, 0x11, 0]);
        let o_small = file.len();
        file.extend_from_slice(&small);
        file.extend(std::iter::repeat(0x00u8).take(333));
        let o_big = file.len();
        file.extend_from_slice(&big);
        let o_mid = file.len();
        file.extend_from_slice(&mid);
        file.extend(std::iter::repeat(0xFFu8).take(100));

        let v = embedded_jpegs(&file, 400);
        let offs: Vec<_> = v.iter().map(|j| j.offset).collect();
        assert_eq!(offs, vec![o_small, o_big, o_mid]);
        assert_eq!(pick(&v, 400).unwrap().offset, o_mid);
        assert_eq!(pick(&v, 1000).unwrap().offset, o_big);
        assert_eq!(pick(&v, 5000).unwrap().offset, o_big);
    }
}

#[cfg(test)]
mod mpf_tests {
    use super::tests::make_jpeg;
    use super::*;

    /// 組出「主影像 + APP2 MPF + 附加預覽圖」的 JPEG（與相機直出結構相同）
    fn make_mpo(main: &[u8], preview: &[u8]) -> Vec<u8> {
        let mut tiff = b"II*\0".to_vec();
        tiff.extend_from_slice(&8u32.to_le_bytes());
        tiff.extend_from_slice(&1u16.to_le_bytes());
        tiff.extend_from_slice(&0xB002u16.to_le_bytes());
        tiff.extend_from_slice(&7u16.to_le_bytes());
        tiff.extend_from_slice(&32u32.to_le_bytes());
        tiff.extend_from_slice(&26u32.to_le_bytes()); // entries 位於 TIFF 起點 +26
        tiff.extend_from_slice(&0u32.to_le_bytes()); // next IFD
        let entries_at = tiff.len();
        tiff.extend(std::iter::repeat(0u8).take(32));
        let seg_len = 2 + 4 + tiff.len();
        let base = 2 + 2 + 2 + 4; // SOI + marker + 長度 + "MPF\0"
        let preview_start = 2 + 2 + seg_len + (main.len() - 2);
        let off = (preview_start - base) as u32;
        let e1 = entries_at + 16;
        tiff[e1 + 4..e1 + 8].copy_from_slice(&(preview.len() as u32).to_le_bytes());
        tiff[e1 + 8..e1 + 12].copy_from_slice(&off.to_le_bytes());
        let mut f = vec![0xFF, 0xD8, 0xFF, 0xE2];
        f.extend_from_slice(&(seg_len as u16).to_be_bytes());
        f.extend_from_slice(b"MPF\0");
        f.extend_from_slice(&tiff);
        f.extend_from_slice(&main[2..]);
        f.extend_from_slice(preview);
        f
    }

    #[test]
    fn finds_mpf_preview_in_jpeg_file() {
        let main = make_jpeg(1800, 1200);
        let preview = make_jpeg(600, 400);
        let file = make_mpo(&main, &preview);
        assert_eq!(jpeg_dims(&file), Some((1800, 1200)));
        let v = jpeg_file_previews(&file);
        assert_eq!(v.len(), 1);
        assert_eq!((v[0].width, v[0].height, v[0].len), (600, 400, preview.len()));
        assert_eq!(v[0].bytes(&file), &preview[..]);
        // 沒有 MPF 的一般 JPEG
        assert!(jpeg_file_previews(&main).is_empty());
    }
}
