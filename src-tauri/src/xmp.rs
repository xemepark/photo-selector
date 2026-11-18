//! 讀寫 XMP 的評等（xmp:Rating）與色彩標籤（xmp:Label），做法與 Adobe Bridge 相同：
//!
//! - **RAW**：寫在附屬檔（IMG_0001.xmp）
//! - **JPEG**：寫進 JPEG 檔案本身的 XMP 區段（APP1）——Bridge 對 JPEG 只讀檔案內嵌的 XMP，不讀附屬檔
//!
//! 已存在的 XMP 只會改動這兩個屬性，其他內容（Camera Raw 調整、關鍵字、版權…）原封不動。

use std::fs;
use std::io;
use std::path::Path;

const NS_XMP: &str = "http://ns.adobe.com/xap/1.0/";
const NS_XMPMM: &str = "http://ns.adobe.com/xap/1.0/mm/";
/// 本程式的照片調整設定（曝光、對比…）。用自己的命名空間，Lightroom / Camera Raw 不會誤用
pub const NS_SD: &str = "http://ns.smallday.tw/edit/1.0/";

fn namespace_of(prefix: &str) -> Option<&'static str> {
    match prefix {
        "xmp" => Some(NS_XMP),
        "xmpMM" => Some(NS_XMPMM),
        "sd" => Some(NS_SD),
        "tiff" => Some("http://ns.adobe.com/tiff/1.0/"),
        _ => None,
    }
}

fn template() -> String {
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Photo Selector\">\n \
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  \
<rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"{NS_XMP}\"/>\n \
</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n"
    )
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('"', "&quot;").replace('>', "&gt;")
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&")
}

/// 找出 `name="..."` 屬性（前面必須是空白），回傳 (整段範圍, 值的範圍)
fn find_attr(xml: &str, name: &str) -> Option<(std::ops::Range<usize>, std::ops::Range<usize>)> {
    let pat = format!("{name}=");
    let mut from = 0;
    while let Some(i) = xml[from..].find(&pat) {
        let start = from + i;
        let ok_before = start > 0 && xml.as_bytes()[start - 1].is_ascii_whitespace();
        let q = start + pat.len();
        let quote = xml.as_bytes().get(q).copied();
        if ok_before && matches!(quote, Some(b'"') | Some(b'\'')) {
            let close = xml[q + 1..].find(quote.unwrap() as char)? + q + 1;
            return Some((start - 1..close + 1, q + 1..close));
        }
        from = start + pat.len();
    }
    None
}

/// 找出 `<name>...</name>` 元素
fn find_elem(xml: &str, name: &str) -> Option<(std::ops::Range<usize>, std::ops::Range<usize>)> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let s = xml.find(&open)?;
    let vs = s + open.len();
    let ve = xml[vs..].find(&close)? + vs;
    Some((s..ve + close.len(), vs..ve))
}

pub fn get_prop(xml: &str, name: &str) -> Option<String> {
    find_attr(xml, name)
        .or_else(|| find_elem(xml, name))
        .map(|(_, v)| unescape(xml[v].trim()))
}

fn set_prop(xml: &mut String, name: &str, value: Option<&str>) {
    if let Some((all, val)) = find_attr(xml, name) {
        match value {
            Some(v) => xml.replace_range(val, &escape(v)),
            None => xml.replace_range(all, ""),
        }
        return;
    }
    if let Some((all, val)) = find_elem(xml, name) {
        match value {
            Some(v) => xml.replace_range(val, &escape(v)),
            None => xml.replace_range(all, ""),
        }
        return;
    }
    let Some(v) = value else { return };
    if let Some(i) = xml.find("<rdf:Description") {
        let at = i + "<rdf:Description".len();
        let mut ins = String::new();
        let prefix = name.split(':').next().unwrap_or("");
        if let Some(ns) = namespace_of(prefix) {
            if !xml.contains(&format!("xmlns:{prefix}=")) {
                ins.push_str(&format!("\n    xmlns:{prefix}=\"{ns}\""));
            }
        }
        ins.push_str(&format!("\n    {name}=\"{}\"", escape(v)));
        xml.insert_str(at, &ins);
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct RatingLabel {
    pub rating: Option<i32>,
    pub label: Option<String>,
    /// 有本程式的照片調整設定
    pub edited: bool,
}

pub fn parse(xml: &str) -> RatingLabel {
    RatingLabel {
        rating: get_prop(xml, "xmp:Rating").and_then(|v| v.parse::<f32>().ok()).map(|v| v as i32),
        label: get_prop(xml, "xmp:Label").filter(|s| !s.is_empty()),
        edited: get_prop(xml, "sd:Version").is_some(),
    }
}

pub fn read_sidecar(path: &Path) -> Option<RatingLabel> {
    fs::read_to_string(path).ok().map(|s| parse(&s))
}

/// 從照片本身內嵌的 XMP 讀評等（只看檔案前 512KB，XMP 封包通常在檔頭附近）
pub fn read_embedded(path: &Path) -> Option<RatingLabel> {
    use std::io::Read;
    let mut buf = vec![0u8; 512 * 1024];
    let mut f = fs::File::open(path).ok()?;
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    let pos = memchr::memmem::find(&buf, b"<x:xmpmeta")?;
    let end = memchr::memmem::find(&buf[pos..], b"</x:xmpmeta>").map(|e| pos + e + 12).unwrap_or(n);
    let s = String::from_utf8_lossy(&buf[pos..end]);
    Some(parse(&s))
}

fn apply(xml: &mut String, rating: Option<i32>, label: Option<Option<&str>>) {
    if !xml.contains("<rdf:Description") {
        *xml = template();
    }
    if let Some(r) = rating {
        set_prop(xml, "xmp:Rating", Some(&r.to_string()));
    }
    if let Some(l) = label {
        set_prop(xml, "xmp:Label", l);
    }
}

/// 更新附屬檔。`rating` / `label`：None = 不變更；Some(None) = 清除（只適用 label）
pub fn update(path: &Path, rating: Option<i32>, label: Option<Option<&str>>) -> io::Result<()> {
    update_with(path, |x| apply(x, rating, label))
}

/// 在 XMP 記錄原始檔名（xmpMM:PreservedFileName），與 Bridge「在 XMP 中繼資料中保留目前的檔名」相同
pub fn preserve_name_sidecar(path: &Path, original: &str) -> io::Result<()> {
    update_with(path, |x| set_named(x, "xmpMM:PreservedFileName", original))
}

pub fn preserve_name_jpeg(path: &Path, original: &str) -> io::Result<()> {
    update_jpeg_with(path, |x| set_named(x, "xmpMM:PreservedFileName", original))
}

/// 一次設定 / 移除多個屬性（None = 移除）。附屬檔版
pub fn update_props(path: &Path, props: &[(&str, Option<String>)]) -> io::Result<()> {
    update_with(path, |x| apply_props(x, props))
}

/// 同上，JPEG 檔案內嵌 XMP 版
pub fn update_jpeg_props(path: &Path, props: &[(&str, Option<String>)]) -> io::Result<()> {
    update_jpeg_with(path, |x| apply_props(x, props))
}

pub fn apply_props(xml: &mut String, props: &[(&str, Option<String>)]) {
    if !xml.contains("<rdf:Description") {
        *xml = template();
    }
    for (k, v) in props {
        set_prop(xml, k, v.as_deref());
    }
}

#[cfg(test)]
pub fn test_set_prop(xml: &mut String, name: &str, value: Option<&str>) {
    set_prop(xml, name, value)
}

/// 讀 JPEG 檔頭內嵌的整段 XMP
pub fn read_jpeg_xml(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = vec![0u8; 256 * 1024];
    let n = fs::File::open(path).ok()?.read(&mut buf).ok()?;
    buf.truncate(n);
    let segs = segments(&buf)?;
    let s = &segs[find_xmp(&buf, &segs)?];
    Some(String::from_utf8_lossy(&buf[s.body + XMP_SIG.len()..s.end]).into_owned())
}

fn set_named(xml: &mut String, name: &str, value: &str) {
    if !xml.contains("<rdf:Description") {
        *xml = template();
    }
    set_prop(xml, name, Some(value));
}

fn update_with(path: &Path, edit: impl Fn(&mut String)) -> io::Result<()> {
    let mut xml = fs::read_to_string(path).unwrap_or_else(|_| template());
    if !xml.contains("<rdf:Description") {
        xml = template();
    }
    edit(&mut xml);
    // 先寫暫存檔再改名，避免寫到一半當機把附屬檔弄壞
    let tmp = path.with_extension("xmp.tmp");
    fs::write(&tmp, xml.as_bytes())?;
    fs::rename(&tmp, path)
}

// ---------------------------------------------------------------- JPEG 內嵌 XMP

const XMP_SIG: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
/// 新寫入的 XMP 預留的空白，之後修改評等 / 標籤就能原地覆寫，不必重寫整個檔案
const PADDING: usize = 2048;
/// APP1 區段內容上限（65535 - 長度欄位 2 bytes）
const MAX_SEGMENT: usize = 65533;

struct Seg {
    marker: u8,
    /// 區段起點（0xFF 的位置）
    start: usize,
    /// 內容起點（長度欄位之後）
    body: usize,
    end: usize,
}

/// 列出 JPEG 檔頭的區段（到 SOS 為止）
fn segments(d: &[u8]) -> Option<Vec<Seg>> {
    if d.len() < 4 || d[0] != 0xFF || d[1] != 0xD8 {
        return None;
    }
    let mut v = Vec::new();
    let mut p = 2;
    while p + 4 <= d.len() && d[p] == 0xFF {
        let m = d[p + 1];
        if m == 0xFF {
            p += 1;
            continue;
        }
        if m == 0xDA || m == 0xD9 {
            break;
        }
        let len = u16::from_be_bytes([d[p + 2], d[p + 3]]) as usize;
        if len < 2 || p + 2 + len > d.len() {
            return None;
        }
        v.push(Seg { marker: m, start: p, body: p + 4, end: p + 2 + len });
        p += 2 + len;
    }
    Some(v)
}

fn find_xmp(d: &[u8], segs: &[Seg]) -> Option<usize> {
    segs.iter().position(|s| s.marker == 0xE1 && d[s.body..s.end].starts_with(XMP_SIG))
}

/// 讀 JPEG 檔案內嵌的 XMP（只讀檔頭）
pub fn read_jpeg(path: &Path) -> Option<RatingLabel> {
    use std::io::Read;
    let mut buf = vec![0u8; 256 * 1024];
    let n = fs::File::open(path).ok()?.read(&mut buf).ok()?;
    buf.truncate(n);
    let segs = segments(&buf)?;
    let s = &segs[find_xmp(&buf, &segs)?];
    Some(parse(&String::from_utf8_lossy(&buf[s.body + XMP_SIG.len()..s.end])))
}

/// 把 XMP 封包補空白到指定長度（空白加在 `<?xpacket end` 之前，這是 XMP 規範的預留區）
fn pad_to(xml: &str, len: usize) -> Option<Vec<u8>> {
    let cur = xml.len();
    if cur > len {
        return None;
    }
    let fill = len - cur;
    let mut out = String::with_capacity(len);
    match xml.rfind("<?xpacket end") {
        Some(i) => {
            out.push_str(&xml[..i]);
            out.extend(std::iter::repeat(' ').take(fill));
            out.push_str(&xml[i..]);
        }
        None => {
            out.push_str(xml);
            out.extend(std::iter::repeat(' ').take(fill));
        }
    }
    Some(out.into_bytes())
}

/// 原地覆寫（不截斷檔案，正在讀取這個檔案的縮圖執行緒不會出錯）
fn write_at(path: &Path, offset: u64, bytes: &[u8]) -> io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};
    let mut f = fs::OpenOptions::new().write(true).open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    f.write_all(bytes)?;
    f.sync_data()
}

/// 整個檔案改寫：先寫完整的暫存檔（當機時資料還在），再覆寫回原檔。
/// 覆寫原檔而不是改名，才能保留 Finder 標籤、建立日期等檔案屬性。
fn rewrite(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let tmp = path.with_file_name(format!(
        ".{}.photo-selector-tmp",
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    {
        let mut f = fs::OpenOptions::new().write(true).open(path)?;
        f.write_all(data)?;
        f.set_len(data.len() as u64)?;
        f.sync_all()?;
    }
    fs::remove_file(&tmp)
}

/// 更新 JPEG 檔案內嵌 XMP 的評等 / 標籤
pub fn update_jpeg(path: &Path, rating: Option<i32>, label: Option<Option<&str>>) -> io::Result<()> {
    update_jpeg_with(path, |x| apply(x, rating, label))
}

fn update_jpeg_with(path: &Path, edit: impl Fn(&mut String)) -> io::Result<()> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    let data = fs::read(path)?;
    let segs = segments(&data).ok_or_else(|| bad("不是有效的 JPEG 檔"))?;

    if let Some(i) = find_xmp(&data, &segs) {
        let s = &segs[i];
        let payload = s.body + XMP_SIG.len();
        let old = std::str::from_utf8(&data[payload..s.end]).map_err(|_| bad("XMP 不是有效的 UTF-8"))?;
        let mut xml = old.trim_end_matches(['\0', ' ', '\n', '\r', '\t']).to_string();
        if !xml.contains("<rdf:Description") {
            xml = template();
        }
        edit(&mut xml);
        // 有足夠的預留空白 → 原地覆寫（最快、最安全）
        if let Some(bytes) = pad_to(&xml, s.end - payload) {
            return write_at(path, payload as u64, &bytes);
        }
        // 空間不夠 → 重建這個區段（附預留空白）
        let bytes = pad_to(&xml, xml.len() + PADDING).unwrap();
        if XMP_SIG.len() + bytes.len() > MAX_SEGMENT {
            return Err(bad("XMP 資料太大"));
        }
        let mut out = Vec::with_capacity(data.len() + PADDING + 64);
        out.extend_from_slice(&data[..s.start]);
        push_app1(&mut out, &bytes);
        out.extend_from_slice(&data[s.end..]);
        // XMP 位在 MPF 標頭之後時，放大 XMP 會讓相機內嵌預覽的位移失準 → 修正 MPF 位移
        if let Some(mpf) = segs.iter().position(|g| g.marker == 0xE2 && data[g.body..g.end].starts_with(b"MPF\0")) {
            if mpf < i {
                let delta = (out.len() as i64) - (data.len() as i64);
                shift_mpf(&mut out, delta);
            }
        }
        return rewrite(path, &out);
    }

    // 沒有 XMP → 在 APP0 / EXIF 之後插入新的區段
    let mut xml = template();
    edit(&mut xml);
    let bytes = pad_to(&xml, xml.len() + PADDING).unwrap();
    let at = segs
        .iter()
        .take_while(|s| s.marker == 0xE0 || (s.marker == 0xE1 && data[s.body..s.end].starts_with(b"Exif\0")))
        .last()
        .map(|s| s.end)
        .unwrap_or(2);
    let mut out = Vec::with_capacity(data.len() + bytes.len() + 64);
    out.extend_from_slice(&data[..at]);
    push_app1(&mut out, &bytes);
    out.extend_from_slice(&data[at..]);
    rewrite(path, &out)
}

/// 把 MPF（多圖格式）裡第 2 張以後影像的位移加上 delta
fn shift_mpf(d: &mut [u8], delta: i64) {
    let Some(segs) = segments(d) else { return };
    let Some(g) = segs.iter().find(|g| g.marker == 0xE2 && d[g.body..g.end].starts_with(b"MPF\0")) else { return };
    let base = g.body + 4;
    let end = g.end;
    let le = &d[base..base + 2] == b"II";
    let rd16 = |d: &[u8], p: usize| {
        let b = [d[p], d[p + 1]];
        if le { u16::from_le_bytes(b) } else { u16::from_be_bytes(b) }
    };
    let rd32 = |d: &[u8], p: usize| {
        let b = [d[p], d[p + 1], d[p + 2], d[p + 3]];
        if le { u32::from_le_bytes(b) } else { u32::from_be_bytes(b) }
    };
    if base + 8 > end {
        return;
    }
    let ifd = base + rd32(d, base + 4) as usize;
    if ifd + 2 > end {
        return;
    }
    for i in 0..rd16(d, ifd) as usize {
        let e = ifd + 2 + i * 12;
        if e + 12 > end || rd16(d, e) != 0xB002 {
            continue;
        }
        let count = rd32(d, e + 4) as usize / 16;
        let off = base + rd32(d, e + 8) as usize;
        for k in 1..count {
            let p = off + k * 16 + 8;
            if p + 4 > end {
                break;
            }
            let v = rd32(d, p);
            if v == 0 {
                continue;
            }
            let nv = (v as i64 + delta).max(0) as u32;
            let bytes = if le { nv.to_le_bytes() } else { nv.to_be_bytes() };
            d[p..p + 4].copy_from_slice(&bytes);
        }
    }
}

fn push_app1(out: &mut Vec<u8>, packet: &[u8]) {
    let len = 2 + XMP_SIG.len() + packet.len();
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&(len as u16).to_be_bytes());
    out.extend_from_slice(XMP_SIG);
    out.extend_from_slice(packet);
}

/// 本程式舊版建立、只含評等 / 標籤的附屬檔（JPEG 改寫進檔案內後就用不到了，可安全刪除）
pub fn is_own_simple_sidecar(path: &Path) -> bool {
    fs::read_to_string(path)
        .map(|s| s.contains("x:xmptk=\"Photo Selector\"") && !s.contains("crs:") && !s.contains("dc:") && s.len() < 4096)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_and_updates_sidecar_preserving_other_content() {
        let dir = std::env::temp_dir().join(format!("ps-xmp-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("IMG_1.xmp");
        let _ = fs::remove_file(&p);

        update(&p, Some(3), Some(Some("Red"))).unwrap();
        assert_eq!(read_sidecar(&p).unwrap(), RatingLabel { rating: Some(3), label: Some("Red".into()), edited: false });

        update(&p, Some(-1), Some(None)).unwrap();
        assert_eq!(read_sidecar(&p).unwrap(), RatingLabel { rating: Some(-1), label: None, edited: false });

        // 既有的 Lightroom / ACR 附屬檔（元素形式 + 其他屬性）
        let existing = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.50">
<xmp:Rating>2</xmp:Rating></rdf:Description></rdf:RDF></x:xmpmeta>"#;
        fs::write(&p, existing).unwrap();
        update(&p, Some(5), Some(Some("Green"))).unwrap();
        let s = fs::read_to_string(&p).unwrap();
        assert!(s.contains(r#"crs:Exposure2012="+0.50""#));
        assert!(s.contains("<xmp:Rating>5</xmp:Rating>"));
        assert!(s.contains(r#"xmlns:xmp="http://ns.adobe.com/xap/1.0/""#));
        assert_eq!(parse(&s).label.as_deref(), Some("Green"));
        fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod jpeg_tests {
    use super::*;

    fn tmp_jpeg(name: &str, data: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ps-xmpjpg-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        fs::write(&p, data).unwrap();
        p
    }

    /// 一張帶 EXIF APP1 的小 JPEG
    fn jpeg_with_exif() -> Vec<u8> {
        let base = crate::jpeg::tests::make_jpeg(320, 200);
        let mut exif = b"Exif\0\0II*\0".to_vec();
        exif.extend_from_slice(&8u32.to_le_bytes());
        exif.extend_from_slice(&0u16.to_le_bytes());
        exif.extend_from_slice(&0u32.to_le_bytes());
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&exif);
        out.extend_from_slice(&base[2..]);
        out
    }

    #[test]
    fn inserts_then_edits_in_place_keeping_image_intact() {
        let orig = jpeg_with_exif();
        let p = tmp_jpeg("a.jpg", &orig);
        update_jpeg(&p, Some(4), Some(Some("Select"))).unwrap();
        assert_eq!(read_jpeg(&p).unwrap(), RatingLabel { rating: Some(4), label: Some("Select".into()), edited: false });
        let after_insert = fs::read(&p).unwrap();
        // 原檔開頭是 EXIF(APP1) + JFIF(APP0)：XMP 應插在這兩個之後，EXIF 仍是第一個區段
        let orig_segs = segments(&orig).unwrap();
        let segs = segments(&after_insert).unwrap();
        assert!(after_insert[segs[0].body..].starts_with(b"Exif\0"));
        assert_eq!(find_xmp(&after_insert, &segs), Some(2));
        // 其後的影像資料完全沒變，而且仍可解碼
        assert!(after_insert.ends_with(&orig[orig_segs[1].end..]));
        assert!(image::load_from_memory(&after_insert).is_ok());

        // 第二次修改：大小不變（原地覆寫）
        update_jpeg(&p, Some(-1), Some(None)).unwrap();
        let after_edit = fs::read(&p).unwrap();
        assert_eq!(after_edit.len(), after_insert.len());
        assert_eq!(read_jpeg(&p).unwrap(), RatingLabel { rating: Some(-1), label: None, edited: false });
        assert!(image::load_from_memory(&after_edit).is_ok());
        // 不留暫存檔
        let leftovers: Vec<_> = fs::read_dir(p.parent().unwrap()).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().contains("photo-selector-tmp")).collect();
        assert!(leftovers.is_empty());
    }

    #[test]
    fn preserves_existing_xmp_content() {
        let orig = jpeg_with_exif();
        let xml = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="1"><dc:rights>(c) Studio</dc:rights></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>"#;
        let mut data = orig[..2].to_vec();
        push_app1(&mut data, xml.as_bytes());
        data.extend_from_slice(&orig[2..]);
        let p = tmp_jpeg("b.jpg", &data);
        update_jpeg(&p, Some(5), Some(Some("Approved"))).unwrap();
        let s = String::from_utf8_lossy(&fs::read(&p).unwrap()).into_owned();
        assert!(s.contains("<dc:rights>(c) Studio</dc:rights>"));
        assert_eq!(read_jpeg(&p).unwrap(), RatingLabel { rating: Some(5), label: Some("Approved".into()), edited: false });
    }
}

#[cfg(test)]
mod mpo_tests {
    use super::*;

    /// 實際的 MPO（主影像 + MPF 預覽，類似 Sony JPEG）：
    /// MPO_TEST=/path/to.jpg cargo test --release mpo_keeps_preview -- --nocapture
    #[test]
    fn mpo_keeps_preview() {
        let Ok(src) = std::env::var("MPO_TEST") else { return };
        let dir = std::env::temp_dir().join(format!("ps-mpo-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.jpg");
        fs::copy(&src, &p).unwrap();
        let before = crate::jpeg::jpeg_file_previews(&fs::read(&p).unwrap());
        let t = std::time::Instant::now();
        update_jpeg(&p, Some(3), Some(Some("Select"))).unwrap();
        println!("insert: {:?}", t.elapsed());
        // 原地修改
        let t = std::time::Instant::now();
        update_jpeg(&p, Some(5), Some(Some("Second"))).unwrap();
        println!("edit in place: {:?}", t.elapsed());
        // 讓 XMP 變大到超過預留空間（強迫重建區段），檢查 MPF 預覽仍正確
        let long = "L".repeat(3000);
        update_jpeg(&p, None, Some(Some(&long))).unwrap();
        update_jpeg(&p, Some(2), Some(Some("Approved"))).unwrap();
        let data = fs::read(&p).unwrap();
        let after = crate::jpeg::jpeg_file_previews(&data);
        println!("previews before {:?}", before.iter().map(|j| (j.width, j.height)).collect::<Vec<_>>());
        println!("previews after  {:?}", after.iter().map(|j| (j.width, j.height)).collect::<Vec<_>>());
        assert_eq!(before.len(), after.len());
        for (a, b) in before.iter().zip(&after) {
            assert_eq!((a.width, a.height, a.len), (b.width, b.height, b.len));
            assert_eq!(a.bytes(&fs::read(&src).unwrap()), b.bytes(&data));
        }
        assert_eq!(read_jpeg(&p).unwrap(), RatingLabel { rating: Some(2), label: Some("Approved".into()), edited: false });
        assert!(image::load_from_memory(&data).is_ok());

        // 情境二：XMP 位在 MPF 標頭「之後」（某些軟體會這樣寫）→ 放大 XMP 時必須修正 MPF 位移
        let orig = fs::read(&src).unwrap();
        let segs = segments(&orig).unwrap();
        let mpf = segs.iter().find(|g| g.marker == 0xE2 && orig[g.body..g.end].starts_with(b"MPF\0")).unwrap();
        let mut xml = template();
        apply(&mut xml, Some(1), None);
        let mut crafted = orig[..mpf.end].to_vec();
        push_app1(&mut crafted, xml.as_bytes()); // 沒有預留空白
        crafted.extend_from_slice(&orig[mpf.end..]);
        let delta = crafted.len() as i64 - orig.len() as i64;
        shift_mpf(&mut crafted, delta);
        let p2 = dir.join("y.jpg");
        fs::write(&p2, &crafted).unwrap();
        assert_eq!(crate::jpeg::jpeg_file_previews(&crafted).len(), 1, "crafted file valid");
        update_jpeg(&p2, Some(4), Some(Some("Review"))).unwrap(); // 沒有預留空間 → 重建並修正位移
        let d2 = fs::read(&p2).unwrap();
        let after2 = crate::jpeg::jpeg_file_previews(&d2);
        assert_eq!(after2.len(), 1);
        assert_eq!(after2[0].bytes(&d2), before[0].bytes(&orig));
        assert_eq!(read_jpeg(&p2).unwrap(), RatingLabel { rating: Some(4), label: Some("Review".into()), edited: false });
        println!("XMP after MPF: preview still correct after growth");
    }
}

/// 轉存新檔案用的 XMP：只帶評等、標籤與版權（不帶 Camera Raw 調整，免得 Lightroom / ACR 對成品再套一次）
pub fn export_packet(src: Option<&RatingLabel>, copyright: &str) -> Option<String> {
    let rating = src.and_then(|r| r.rating).filter(|&r| r != 0);
    let label = src.and_then(|r| r.label.clone());
    let copyright = copyright.trim();
    if rating.is_none() && label.is_none() && copyright.is_empty() {
        return None;
    }
    let mut attrs = String::new();
    if let Some(r) = rating {
        attrs.push_str(&format!("\n    xmp:Rating=\"{r}\""));
    }
    if let Some(l) = &label {
        attrs.push_str(&format!("\n    xmp:Label=\"{}\"", escape(l)));
    }
    let mut body = String::new();
    if !copyright.is_empty() {
        attrs.push_str("\n    xmpRights:Marked=\"True\"");
        body = format!(
            "\n   <dc:rights>\n    <rdf:Alt>\n     <rdf:li xml:lang=\"x-default\">{}</rdf:li>\n    </rdf:Alt>\n   </dc:rights>\n  ",
            escape(copyright)
        );
    }
    Some(format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Photo Selector\">\n \
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n  \
<rdf:Description rdf:about=\"\"\n    xmlns:xmp=\"{NS_XMP}\"\n    \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\"\n    \
xmlns:xmpRights=\"http://ns.adobe.com/xap/1.0/rights/\"{attrs}>{body}</rdf:Description>\n \
</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n"
    ))
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn export_packet_fields() {
        let rl = RatingLabel { rating: Some(4), label: Some("Select".into()), edited: false };
        let x = export_packet(Some(&rl), "© 小日子寫真館 <2026>").unwrap();
        assert_eq!(parse(&x), rl);
        assert!(x.contains("© 小日子寫真館 &lt;2026&gt;"));
        assert!(x.contains("xmpRights:Marked=\"True\""));
        assert!(export_packet(None, "  ").is_none());
    }
}


// ---------------------------------------------------------------- 照片方向（旋轉）

/// JPEG 的 EXIF 方向（只看檔頭）。沒有 EXIF 或沒有方向欄位時回傳 None
pub fn jpeg_exif_orientation(d: &[u8]) -> Option<u16> {
    let segs = segments(d)?;
    let (pos, le) = exif_orientation_pos(d, &segs)?;
    let v = if le { u16::from_le_bytes([d[pos], d[pos + 1]]) } else { u16::from_be_bytes([d[pos], d[pos + 1]]) };
    (1..=8).contains(&v).then_some(v)
}

/// EXIF IFD0 方向欄位數值的位置（檔案中的位移）與位元組順序
fn exif_orientation_pos(d: &[u8], segs: &[Seg]) -> Option<(usize, bool)> {
    let s = segs.iter().find(|s| s.marker == 0xE1 && d[s.body..s.end].starts_with(b"Exif\0\0"))?;
    let t = s.body + 6;
    let le = match d.get(t..t + 2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let r16 = |p: usize| -> Option<usize> {
        let b = d.get(p..p + 2)?;
        Some(if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) } as usize)
    };
    let r32 = |p: usize| -> Option<usize> {
        let b = d.get(p..p + 4)?;
        let a = [b[0], b[1], b[2], b[3]];
        Some(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) } as usize)
    };
    let ifd = t + r32(t + 4)?;
    let n = r16(ifd)?;
    for i in 0..n {
        let e = ifd + 2 + i * 12;
        if e + 12 > s.end {
            return None;
        }
        if r16(e)? == 0x0112 && r16(e + 2)? == 3 {
            return Some((e + 8, le));
        }
    }
    None
}

/// 設定 JPEG 的方向，不重新壓縮影像：
/// 有 EXIF 方向欄位 → 原地改寫 2 個位元組；沒有 EXIF → 插入只含方向的小型 EXIF 區段；
/// 有 EXIF 但沒有方向欄位 → 寫進 XMP 的 tiff:Orientation（本程式與 Adobe 軟體都會讀）。
/// XMP 裡原本就有 tiff:Orientation 時一併更新，避免兩邊不一致。
pub fn set_jpeg_orientation(path: &Path, o: u16) -> io::Result<()> {
    let bad = |m: &str| io::Error::new(io::ErrorKind::InvalidData, m.to_string());
    let data = fs::read(path)?;
    let segs = segments(&data).ok_or_else(|| bad("不是有效的 JPEG 檔"))?;
    let has_xmp_orient = find_xmp(&data, &segs)
        .map(|i| {
            let s = &segs[i];
            get_prop(&String::from_utf8_lossy(&data[s.body + XMP_SIG.len()..s.end]), "tiff:Orientation").is_some()
        })
        .unwrap_or(false);
    let has_exif = segs.iter().any(|s| s.marker == 0xE1 && data[s.body..s.end].starts_with(b"Exif\0\0"));
    if let Some((pos, le)) = exif_orientation_pos(&data, &segs) {
        let bytes = if le { o.to_le_bytes() } else { o.to_be_bytes() };
        write_at(path, pos as u64, &bytes)?;
    } else if !has_exif {
        // 最小的 EXIF：TIFF 檔頭 + 1 個欄位（方向）；插在 SOI / APP0 之後（在 MPF 之前，MPF 的相對位移不受影響）
        let mut tiff = b"MM\0\x2a\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01".to_vec();
        tiff.extend_from_slice(&o.to_be_bytes());
        tiff.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        let mut seg = vec![0xFF, 0xE1];
        seg.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
        seg.extend_from_slice(b"Exif\0\0");
        seg.extend_from_slice(&tiff);
        let at = segs.first().filter(|s| s.marker == 0xE0).map(|s| s.end).unwrap_or(2);
        let mut out = Vec::with_capacity(data.len() + seg.len());
        out.extend_from_slice(&data[..at]);
        out.extend_from_slice(&seg);
        out.extend_from_slice(&data[at..]);
        rewrite(path, &out)?;
    } else {
        return update_jpeg_with(path, |x| set_named(x, "tiff:Orientation", &o.to_string()));
    }
    if has_xmp_orient {
        update_jpeg_with(path, |x| set_named(x, "tiff:Orientation", &o.to_string()))?;
    }
    Ok(())
}

/// 讀 JPEG 內嵌 XMP 的 tiff:Orientation
pub fn jpeg_xmp_orientation(path: &Path) -> Option<u16> {
    read_jpeg_xml(path).and_then(|x| get_prop(&x, "tiff:Orientation")).and_then(|v| v.trim().parse().ok()).filter(|v| (1..=8).contains(v))
}

/// 讀附屬檔的 tiff:Orientation
pub fn sidecar_orientation(path: &Path) -> Option<u16> {
    fs::read_to_string(path).ok().and_then(|x| get_prop(&x, "tiff:Orientation")).and_then(|v| v.trim().parse().ok()).filter(|v| (1..=8).contains(v))
}
