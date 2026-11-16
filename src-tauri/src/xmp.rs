//! 讀寫 XMP 的評等（xmp:Rating）與色彩標籤（xmp:Label）。
//!
//! 寫入一律使用附屬檔（IMG_0001.xmp），不修改原始照片——這是 Adobe Bridge / Lightroom
//! 對 RAW 檔的相同慣例，所以在這裡評的星等，Bridge / Lightroom 打開也看得到。
//! 已存在的 .xmp 只會改動這兩個屬性，其他內容（Camera Raw 調整、關鍵字…）原封不動。

use std::fs;
use std::io;
use std::path::Path;

const NS_XMP: &str = "http://ns.adobe.com/xap/1.0/";

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
        if !xml.contains("xmlns:xmp=") {
            ins.push_str(&format!("\n    xmlns:xmp=\"{NS_XMP}\""));
        }
        ins.push_str(&format!("\n    {name}=\"{}\"", escape(v)));
        xml.insert_str(at, &ins);
    }
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct RatingLabel {
    pub rating: Option<i32>,
    pub label: Option<String>,
}

pub fn parse(xml: &str) -> RatingLabel {
    RatingLabel {
        rating: get_prop(xml, "xmp:Rating").and_then(|v| v.parse::<f32>().ok()).map(|v| v as i32),
        label: get_prop(xml, "xmp:Label").filter(|s| !s.is_empty()),
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

/// `rating` / `label`：None = 不變更；Some(None) = 清除（只適用 label）
pub fn update(path: &Path, rating: Option<i32>, label: Option<Option<&str>>) -> io::Result<()> {
    let mut xml = fs::read_to_string(path).unwrap_or_else(|_| template());
    if !xml.contains("<rdf:Description") {
        xml = template();
    }
    if let Some(r) = rating {
        set_prop(&mut xml, "xmp:Rating", Some(&r.to_string()));
    }
    if let Some(l) = label {
        set_prop(&mut xml, "xmp:Label", l);
    }
    // 先寫暫存檔再改名，避免寫到一半當機把附屬檔弄壞
    let tmp = path.with_extension("xmp.tmp");
    fs::write(&tmp, xml.as_bytes())?;
    fs::rename(&tmp, path)
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
        assert_eq!(read_sidecar(&p).unwrap(), RatingLabel { rating: Some(3), label: Some("Red".into()) });

        update(&p, Some(-1), Some(None)).unwrap();
        assert_eq!(read_sidecar(&p).unwrap(), RatingLabel { rating: Some(-1), label: None });

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
