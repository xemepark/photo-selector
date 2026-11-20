//! 文字檔（.txt / .md / .rtf）：讀取、寫入、縮圖（SVG「紙張」）。
//! RTF 只取出文字（粗體、顏色等格式不保留）；用內建編輯器存檔時寫成只有文字的 RTF。

use std::path::Path;

pub const TEXT_EXTS: &[&str] = &["txt", "md", "markdown", "rtf"];

pub fn is_rtf(path: &Path) -> bool {
    path.extension().is_some_and(|e| e.eq_ignore_ascii_case("rtf"))
}

/// 位元組 → 文字：UTF-8（含 BOM）、UTF-16（有 BOM），其他當成 UTF-8 盡量讀
pub fn decode(bytes: &[u8]) -> String {
    if let Some(b) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(b).into_owned();
    }
    let utf16 = |b: &[u8], le: bool| {
        let v: Vec<u16> = b.chunks_exact(2).map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        String::from_utf16_lossy(&v)
    };
    if let Some(b) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(b, true);
    }
    if let Some(b) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(b, false);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 讀出文字檔內容（RTF 轉成純文字）。換行一律成 \n
pub fn read(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    let s = if is_rtf(path) && bytes.starts_with(b"{\\rtf") {
        rtf_to_text(&String::from_utf8_lossy(&bytes))
    } else {
        decode(&bytes)
    };
    Ok(s.replace("\r\n", "\n").replace('\r', "\n"))
}

/// 只讀開頭（縮圖用）
pub fn read_head(path: &Path, max_bytes: usize) -> String {
    use std::io::Read;
    let Ok(f) = std::fs::File::open(path) else { return String::new() };
    let mut buf = Vec::new();
    // RTF 開頭是字型表、顏色表等，多讀一些才有內文
    let limit = if is_rtf(path) { max_bytes * 8 } else { max_bytes };
    let _ = f.take(limit as u64).read_to_end(&mut buf);
    let s = if is_rtf(path) && buf.starts_with(b"{\\rtf") {
        rtf_to_text(&String::from_utf8_lossy(&buf))
    } else {
        decode(&buf)
    };
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// 寫入文字檔。RTF 檔寫成只有文字的 RTF；其他寫 UTF-8
pub fn write(path: &Path, text: &str) -> std::io::Result<()> {
    let data = if is_rtf(path) { text_to_rtf(text) } else { text.to_string() };
    // 先寫暫存檔再改名，寫到一半出錯也不會弄壞原檔
    let tmp = path.with_file_name(format!(".{}.tmp", path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
    std::fs::write(&tmp, data.as_bytes())?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// RTF → 純文字（足以應付 macOS「文字編輯」、Word 等產生的 RTF）。
/// 中文字可能以 \uN 或依字型字元集（Big5 / GBK / Shift-JIS…）編碼的 \'hh 出現，兩種都處理。
pub fn rtf_to_text(rtf: &str) -> String {
    const SKIP: &[&str] = &[
        "colortbl", "expandedcolortbl", "stylesheet", "info", "pict", "header", "footer", "headerl", "headerr", "footerl",
        "footerr", "listtable", "listoverridetable", "generator", "themedata", "colorschememapping", "latentstyles", "datastore",
        "xmlnstbl", "rsidtbl", "object", "fldinst",
    ];
    #[derive(Clone, Copy)]
    struct St {
        skip: bool,
        fonttbl: bool,
        uc: usize,
        cp: u16,
    }
    fn flush(out: &mut String, bytes: &mut Vec<u8>, cp: u16) {
        if !bytes.is_empty() {
            out.push_str(&decode_cp(bytes, cp));
            bytes.clear();
        }
    }
    let b = rtf.as_bytes();
    let mut out = String::new();
    let mut stack: Vec<St> = Vec::new();
    let mut default_cp: u16 = 1252;
    let mut cur = St { skip: false, fonttbl: false, uc: 1, cp: 1252 };
    let mut fonts: std::collections::HashMap<i64, u16> = std::collections::HashMap::new();
    let mut font_def: i64 = -1;
    let mut pending_hi: Option<u16> = None;
    let mut skip_chars = 0usize; // \u 之後的替代字元
    let mut bytes: Vec<u8> = Vec::new(); // 連續的 \'hh，一起依字元集解碼
    let mut bytes_cp: u16 = 1252;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        // 雙位元組編碼（Big5 等）的第二個位元組落在 ASCII 範圍時，會直接寫成一般字元（例如 \'b2M）
        let trail = (0x40..0x7F).contains(&c) && !matches!(c, b'\\' | b'{' | b'}') && dbcs_pending(&bytes, bytes_cp);
        if trail {
            bytes.push(c);
            i += 1;
            continue;
        }
        if !(c == b'\\' && b.get(i + 1) == Some(&b'\'')) {
            flush(&mut out, &mut bytes, bytes_cp);
        }
        match c {
            b'{' => {
                stack.push(cur);
                skip_chars = 0;
                i += 1;
            }
            b'}' => {
                if let Some(s) = stack.pop() {
                    cur = s;
                }
                skip_chars = 0;
                i += 1;
            }
            b'\\' => {
                i += 1;
                let Some(&n) = b.get(i) else { break };
                if n.is_ascii_alphabetic() {
                    let s = i;
                    while i < b.len() && b[i].is_ascii_alphabetic() {
                        i += 1;
                    }
                    let word = &rtf[s..i];
                    let ps = i;
                    if i < b.len() && (b[i] == b'-' || b[i].is_ascii_digit()) {
                        i += 1;
                        while i < b.len() && b[i].is_ascii_digit() {
                            i += 1;
                        }
                    }
                    let param: Option<i64> = rtf[ps..i].parse().ok();
                    if i < b.len() && b[i] == b' ' {
                        i += 1;
                    }
                    if cur.fonttbl {
                        match word {
                            "f" => font_def = param.unwrap_or(-1),
                            "fcharset" => {
                                if let Some(cp) = charset_cp(param.unwrap_or(0)) {
                                    fonts.insert(font_def, cp);
                                }
                            }
                            "cpg" => {
                                fonts.insert(font_def, param.unwrap_or(1252) as u16);
                            }
                            _ => {}
                        }
                        continue;
                    }
                    if skip_chars > 0 && word != "u" {
                        skip_chars -= 1;
                        continue;
                    }
                    let emit: Option<char> = match word {
                        "par" | "line" | "sect" | "page" => Some('\n'),
                        "tab" => Some('\t'),
                        "emdash" => Some('—'),
                        "endash" => Some('–'),
                        "bullet" => Some('•'),
                        "lquote" => Some('‘'),
                        "rquote" => Some('’'),
                        "ldblquote" => Some('“'),
                        "rdblquote" => Some('”'),
                        "ansicpg" => {
                            default_cp = param.unwrap_or(1252) as u16;
                            cur.cp = default_cp;
                            None
                        }
                        "f" => {
                            cur.cp = fonts.get(&param.unwrap_or(-1)).copied().unwrap_or(default_cp);
                            None
                        }
                        "fonttbl" => {
                            cur.fonttbl = true;
                            None
                        }
                        "uc" => {
                            cur.uc = param.unwrap_or(1).max(0) as usize;
                            None
                        }
                        "u" => {
                            let mut v = param.unwrap_or(0);
                            if v < 0 {
                                v += 65536;
                            }
                            let u = v as u16;
                            skip_chars = cur.uc;
                            if (0xD800..0xDC00).contains(&u) {
                                pending_hi = Some(u);
                                None
                            } else if (0xDC00..0xE000).contains(&u) {
                                pending_hi.take().and_then(|hi| char::decode_utf16([hi, u]).next().and_then(|r| r.ok()))
                            } else {
                                char::from_u32(u as u32)
                            }
                        }
                        w if SKIP.contains(&w) => {
                            cur.skip = true;
                            None
                        }
                        _ => None,
                    };
                    if let (Some(c), false) = (emit, cur.skip) {
                        out.push(c);
                    }
                } else {
                    i += 1;
                    match n {
                        b'\\' | b'{' | b'}' => {
                            if skip_chars > 0 {
                                skip_chars -= 1;
                            } else if !cur.skip && !cur.fonttbl {
                                out.push(n as char);
                            }
                        }
                        b'\'' => {
                            let hex = rtf.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok());
                            i += 2;
                            if skip_chars > 0 {
                                skip_chars -= 1;
                            } else if let (Some(v), false, false) = (hex, cur.skip, cur.fonttbl) {
                                if !bytes.is_empty() && bytes_cp != cur.cp {
                                    flush(&mut out, &mut bytes, bytes_cp);
                                }
                                bytes_cp = cur.cp;
                                bytes.push(v);
                            }
                        }
                        b'*' => cur.skip = true,
                        _ if cur.skip || cur.fonttbl => {}
                        b'~' => out.push('\u{a0}'),
                        b'_' => out.push('-'),
                        b'\n' | b'\r' => out.push('\n'),
                        _ => {}
                    }
                }
            }
            b'\r' | b'\n' => i += 1,
            _ => {
                let ch = rtf[i..].chars().next().unwrap_or(' ');
                i += ch.len_utf8();
                if skip_chars > 0 {
                    skip_chars -= 1;
                } else if !cur.skip && !cur.fonttbl {
                    out.push(ch);
                }
            }
        }
    }
    flush(&mut out, &mut bytes, bytes_cp);
    out
}

/// 雙位元組編碼的位元組串最後是否停在「前導位元組、還缺第二個位元組」
fn dbcs_pending(bytes: &[u8], cp: u16) -> bool {
    if !matches!(cp, 932 | 936 | 949 | 950) || bytes.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        let lead = if cp == 932 { matches!(bytes[i], 0x81..=0x9F | 0xE0..=0xFC) } else { bytes[i] >= 0x81 };
        i += if lead { 2 } else { 1 };
    }
    i > bytes.len()
}

/// RTF 字型字元集 → Windows 字碼頁
fn charset_cp(cs: i64) -> Option<u16> {
    Some(match cs {
        77 => 10000,
        128 => 932,
        129 => 949,
        134 => 936,
        136 => 950,
        161 => 1253,
        162 => 1254,
        177 => 1255,
        178 => 1256,
        186 => 1257,
        204 => 1251,
        222 => 874,
        238 => 1250,
        _ => return None,
    })
}

fn decode_cp(bytes: &[u8], cp: u16) -> String {
    use encoding_rs::*;
    let enc: &'static Encoding = match cp {
        932 => SHIFT_JIS,
        936 => GBK,
        949 => EUC_KR,
        950 => BIG5,
        874 => WINDOWS_874,
        1250 => WINDOWS_1250,
        1251 => WINDOWS_1251,
        1253 => WINDOWS_1253,
        1254 => WINDOWS_1254,
        1255 => WINDOWS_1255,
        1256 => WINDOWS_1256,
        1257 => WINDOWS_1257,
        10000 => MACINTOSH,
        _ => WINDOWS_1252,
    };
    enc.decode_without_bom_handling(bytes).0.into_owned()
}

/// 純文字 → 只有文字的 RTF（macOS「文字編輯」可以開）
pub fn text_to_rtf(text: &str) -> String {
    let mut out = String::from("{\\rtf1\\ansi\\ansicpg1252\\uc0\n{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n\\f0\\fs24 ");
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '{' => out.push_str("\\{"),
            '}' => out.push_str("\\}"),
            '\n' => out.push_str("\\\n"),
            '\r' => {}
            '\t' => out.push_str("\\tab "),
            c if (c as u32) < 0x80 => out.push(c),
            c => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{} ", *u as i16));
                }
            }
        }
    }
    out.push('}');
    out
}

/// 拖曳圖示等需要點陣圖的地方：一張畫著幾條灰線的白紙
pub fn paper_jpeg() -> anyhow::Result<Vec<u8>> {
    let (w, h) = (120u32, 160u32);
    let mut img = image::RgbImage::from_pixel(w, h, image::Rgb([255, 255, 255]));
    for (i, y) in (22..h - 24).step_by(12).enumerate() {
        let len = if i % 4 == 3 { 50 } else { 88 };
        for yy in y..y + 4 {
            for x in 16..16 + len {
                img.put_pixel(x, yy, image::Rgb([190, 190, 196]));
            }
        }
    }
    crate::render::encode_jpeg(&image::DynamicImage::ImageRgb8(img), 90)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// 東亞全形字算 2 格寬，其他 1 格
fn cell_width(c: char) -> usize {
    let u = c as u32;
    if (0x1100..=0x115F).contains(&u)
        || (0x2E80..=0xA4CF).contains(&u)
        || (0xAC00..=0xD7A3).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
        || (0xFE30..=0xFE4F).contains(&u)
        || (0xFF00..=0xFF60).contains(&u)
        || (0xFFE0..=0xFFE6).contains(&u)
        || (0x1F300..=0x1FAFF).contains(&u)
        || (0x20000..=0x3FFFD).contains(&u)
    {
        2
    } else {
        1
    }
}

/// 自動換行：每行最多 `cols` 格
fn wrap(text: &str, cols: usize, max_lines: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.replace('\t', "    ");
        let mut line = String::new();
        let mut w = 0;
        for c in raw.chars() {
            if c.is_control() {
                continue;
            }
            let cw = cell_width(c);
            if w + cw > cols {
                lines.push(std::mem::take(&mut line));
                w = 0;
                if lines.len() >= max_lines {
                    return lines;
                }
            }
            line.push(c);
            w += cw;
        }
        lines.push(line);
        if lines.len() >= max_lines {
            return lines;
        }
    }
    lines
}

/// 文字檔縮圖：一張白紙，上面是開頭幾行內容，右下角標示副檔名
pub fn thumb_svg(text: &str, ext: &str) -> Vec<u8> {
    const W: u32 = 300;
    const H: u32 = 400;
    let lines = wrap(text.trim_start_matches('\u{feff}'), 24, 12);
    let empty = lines.iter().all(|l| l.trim().is_empty());
    let mut body = String::new();
    if empty {
        body.push_str(r##"<text x="150" y="190" font-size="22" fill="#aaa" text-anchor="middle">（空白）</text>"##);
    } else {
        for (i, l) in lines.iter().enumerate() {
            body.push_str(&format!(
                r##"<text x="20" y="{}" font-size="19" fill="#333" xml:space="preserve">{}</text>"##,
                42 + i as u32 * 26,
                xml_escape(l)
            ));
        }
    }
    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="-apple-system, 'PingFang TC', 'Heiti TC', 'Microsoft JhengHei', 'Noto Sans CJK TC', 'Helvetica Neue', sans-serif"><defs><clipPath id="c"><rect x="14" y="14" width="{}" height="{}"/></clipPath></defs><rect width="{W}" height="{H}" fill="#fff"/><rect x="0.5" y="0.5" width="{}" height="{}" fill="none" stroke="#d6d6d6"/><g clip-path="url(#c)">{body}</g><rect x="{}" y="{}" width="64" height="28" rx="5" fill="#4a4a52"/><text x="{}" y="{}" font-size="16" font-weight="600" fill="#fff" text-anchor="middle">{}</text></svg>"##,
        W - 28,
        H - 50,
        W - 1,
        H - 1,
        W - 76,
        H - 40,
        W - 44,
        H - 20,
        xml_escape(&ext.to_uppercase())
    )
    .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtf_roundtrip_and_textedit() {
        let s = "第一行 Hello {x} \\ 測試\n第二行\t😀";
        let r = text_to_rtf(s);
        assert_eq!(rtf_to_text(&r), s);
        // macOS「文字編輯」產生的 RTF
        let te = "{\\rtf1\\ansi\\ansicpg1252\\cocoartf2822\n\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fnil\\fcharset136 PingFangTC-Regular;\\f1\\fswiss\\fcharset0 Helvetica;}\n{\\colortbl;\\red255\\green255\\blue255;}\n{\\*\\expandedcolortbl;;}\n\\paperw11900\\paperh16840\\margl1440\\margr1440\\vieww11520\\viewh8400\\viewkind0\n\\pard\\tx720\\tx1440\\pardirnatural\\partightenfactor0\n\n\\f0\\fs24 \\cf0 \\'b4\\'fa\\'b8\\'d5 \\uc0\\u28204 \\u35430 \\\n\\f1\\b Bold\\b0  caf\\'e9}";
        // \'b4\'fa\'b8\'d5 是 Big5（fcharset136）的「測試」
        let t = rtf_to_text(te);
        assert_eq!(t.trim(), "測試 測試\nBold café");
        // Big5 第二個位元組是 ASCII（「清單」的「單」= B3 E6，「拍」= A9 E7，「攝」= C4 E1，「清」= B2 4D → \'b2M）
        let big5 = "{\\rtf1\\ansi{\\fonttbl\\f0\\fnil\\fcharset136 PingFangTC;}\\f0 \\'a9\\'e7\\'c4\\'e1\\'b2M\\'b3\\'e6 OK}";
        assert_eq!(rtf_to_text(big5), "拍攝清單 OK");
    }

    #[test]
    fn decode_utf16_and_bom() {
        assert_eq!(decode(&[0xEF, 0xBB, 0xBF, b'a']), "a");
        assert_eq!(decode(&[0xFF, 0xFE, b'h', 0, b'i', 0]), "hi");
    }

    #[test]
    fn wraps_cjk() {
        let l = wrap(&"中".repeat(20), 24, 10);
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].chars().count(), 12);
        let svg = String::from_utf8(thumb_svg("a<b & c", "txt")).unwrap();
        assert!(svg.contains("a&lt;b &amp; c") && svg.contains("TXT"));
    }
}
