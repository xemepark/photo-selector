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
