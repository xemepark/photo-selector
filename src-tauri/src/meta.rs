//! 讀取 EXIF（拍攝時間、相機、鏡頭、曝光參數、方向）與評等 / 標籤。

use crate::scan::{Class, FileEntry, Item};
use crate::{jpeg, tiff, xmp};
use exif::{Exif, In, Value};
use serde::Serialize;
use std::fs::File;
use std::io::{Cursor, Read};

#[derive(Serialize, Default, Clone, Debug)]
pub struct Meta {
    pub capture: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<u32>,
    pub aperture: Option<f32>,
    pub shutter: Option<String>,
    pub focal: Option<f32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub rating: i32,
    pub label: Option<String>,
    /// 有本程式的照片調整
    pub edited: bool,
    /// 影片長度（秒）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
}

#[derive(Default)]
struct Raw {
    make: Option<String>,
    model: Option<String>,
    lens: Option<String>,
    date: Option<String>,
    iso: Option<u32>,
    fnum: Option<f64>,
    exposure: Option<f64>,
    focal: Option<f64>,
    w: Option<u32>,
    h: Option<u32>,
    orientation: Option<u16>,
}

fn ascii(v: &Value) -> Option<String> {
    match v {
        Value::Ascii(a) => a
            .first()
            .map(|s| String::from_utf8_lossy(s).trim_matches(|c: char| c == '\0' || c.is_whitespace()).to_string())
            .filter(|s| !s.is_empty()),
        _ => None,
    }
}

fn rational(v: &Value) -> Option<f64> {
    match v {
        Value::Rational(r) => r.first().map(|x| x.to_f64()).filter(|x| x.is_finite()),
        Value::SRational(r) => r.first().map(|x| x.to_f64()).filter(|x| x.is_finite()),
        // 有些軟體把有理數錯寫成兩個整數（分子、分母）
        Value::Short(s) if s.len() == 2 && s[1] != 0 => Some(s[0] as f64 / s[1] as f64),
        Value::Long(s) if s.len() == 2 && s[1] != 0 => Some(s[0] as f64 / s[1] as f64),
        _ => None,
    }
}

/// 依 tag 編號（忽略 context）合併欄位，只補還沒有值的欄位。
/// 忽略 context 是為了能處理 CR3 的 CMT2（Exif 欄位被放在 TIFF 的 IFD0）。
fn merge(r: &mut Raw, ex: &Exif) {
    for f in ex.fields() {
        if f.ifd_num != In::PRIMARY {
            continue; // 跳過 IFD1（縮圖）的欄位
        }
        let v = &f.value;
        match f.tag.number() {
            0x010F if r.make.is_none() => r.make = ascii(v),
            0x0110 if r.model.is_none() => r.model = ascii(v),
            0xA434 if r.lens.is_none() => r.lens = ascii(v),
            0x9003 if r.date.is_none() => r.date = ascii(v),
            0x8827 if r.iso.is_none() => r.iso = v.get_uint(0),
            0x829D if r.fnum.is_none() => r.fnum = rational(v),
            0x829A if r.exposure.is_none() => r.exposure = rational(v),
            0x920A if r.focal.is_none() => r.focal = rational(v),
            0xA002 if r.w.is_none() => r.w = v.get_uint(0),
            0xA003 if r.h.is_none() => r.h = v.get_uint(0),
            0x0112 if r.orientation.is_none() => r.orientation = v.get_uint(0).map(|o| o as u16),
            _ => {}
        }
    }
}

fn exif_from_jpeg(bytes: &[u8]) -> Option<Exif> {
    exif::Reader::new().read_from_container(&mut Cursor::new(bytes)).ok()
}

fn read_prefix(f: &FileEntry, n: usize) -> Option<Vec<u8>> {
    let mut buf = vec![0u8; n];
    let mut file = File::open(&f.path).ok()?;
    let mut got = 0;
    while got < n {
        match file.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(_) => return None,
        }
    }
    buf.truncate(got);
    Some(buf)
}

fn raw_exif(f: &FileEntry, r: &mut Raw) {
    let Some(head) = read_prefix(f, 1024 * 1024) else { return };
    if tiff::is_cr3(&head) {
        for b in [b"CMT1", b"CMT2"] {
            if let Some(t) = tiff::find_box(&head, b) {
                if let Ok(ex) = exif::Reader::new().read_raw(t.to_vec()) {
                    merge(r, &ex);
                }
            }
        }
        return;
    }
    if head.starts_with(b"II") || head.starts_with(b"MM") {
        // 先只用檔頭 1MB 解析（IFD 通常都在前面），失敗才讀整個檔案
        let ok = exif::Reader::new().read_raw(head.clone()).map(|ex| merge(r, &ex)).is_ok();
        if !ok {
            if let Ok(all) = std::fs::read(&f.path) {
                if let Ok(ex) = exif::Reader::new().read_raw(all) {
                    merge(r, &ex);
                }
            }
        }
        if r.make.is_some() {
            return;
        }
    }
    // 最後手段（例如 Fuji RAF）：讀內嵌 JPEG 自己的 EXIF
    if let Ok(file) = File::open(&f.path) {
        if let Ok(map) = unsafe { memmap2::Mmap::map(&file) } {
            if let Some(j) = jpeg::pick(&jpeg::embedded_jpegs(&map, 0), 1) {
                if let Some(ex) = exif_from_jpeg(j.bytes(&map)) {
                    merge(r, &ex);
                }
            }
        }
    }
}

fn file_exif(f: &FileEntry, r: &mut Raw) {
    match f.class {
        Class::Jpeg => {
            // EXIF 在 APP1，位於檔頭 64KB 內
            if let Some(head) = read_prefix(f, 128 * 1024) {
                if let Some(ex) = exif_from_jpeg(&head) {
                    merge(r, &ex);
                }
            }
        }
        Class::Raw => raw_exif(f, r),
        _ => {
            if let Ok(file) = File::open(&f.path) {
                if let Ok(ex) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file)) {
                    merge(r, &ex);
                }
            }
        }
    }
}

fn camera_name(make: Option<String>, model: Option<String>) -> Option<String> {
    match (make, model) {
        (Some(mk), Some(md)) => {
            let first = mk.split_whitespace().next().unwrap_or("").to_lowercase();
            if md.to_lowercase().starts_with(&first) {
                Some(md)
            } else {
                Some(format!("{} {}", mk.split_whitespace().next().unwrap_or(&mk), md))
            }
        }
        (a, b) => b.or(a),
    }
}

fn shutter(t: f64) -> String {
    if t <= 0.0 {
        String::new()
    } else if t < 0.4 {
        format!("1/{}", (1.0 / t).round())
    } else {
        format!("{}s", (t * 10.0).round() / 10.0)
    }
}

pub fn read_meta(item: &Item) -> Meta {
    // 還在 iCloud 上：不讀檔（讀取會觸發下載而卡住），下載後重新整理才讀
    if item.in_cloud_now() {
        return Meta::default();
    }
    // 影片：附屬檔裡的評等 / 標籤，加上影片長度
    if item.is_video() {
        let rl = xmp::read_sidecar(&item.sidecar_path()).unwrap_or_default();
        return Meta { rating: rl.rating.unwrap_or(0), label: rl.label, duration: crate::video::duration(&item.display().path), ..Default::default() };
    }
    // 文字檔：只有附屬檔裡的評等 / 標籤
    if item.is_text() {
        let rl = xmp::read_sidecar(&item.sidecar_path()).unwrap_or_default();
        return Meta { rating: rl.rating.unwrap_or(0), label: rl.label, ..Default::default() };
    }
    let mut r = Raw::default();
    // RAW+JPEG 配對時，讀 JPEG 的 EXIF 最快也最完整
    file_exif(item.display(), &mut r);
    if r.make.is_none() {
        if let Some(raw) = item.raw() {
            file_exif(raw, &mut r);
        }
    }

    // 讀取順序與 Bridge 一致：有 RAW → 附屬檔優先；只有 JPEG → 檔案內嵌 XMP 優先
    let sidecar = || xmp::read_sidecar(&item.sidecar_path());
    let jpeg = || {
        item.files
            .iter()
            .filter(|f| f.class == Class::Jpeg)
            .find_map(|f| xmp::read_jpeg(&f.path))
    };
    let rl = if item.raw().is_some() { sidecar().or_else(jpeg) } else { jpeg().or_else(sidecar) }
        .or_else(|| xmp::read_embedded(&item.display().path))
        .unwrap_or_default();

    if crate::heic::is_heif(item.display()) {
        // HEIC 的 EXIF 方向和轉出的像素不一定一致：寬高與方向都以轉出的 JPEG 為準
        if let Ok(b) = crate::heic::jpeg_bytes(item.display()) {
            if let Some((jw, jh, _)) = crate::jpeg::jpeg_info(&b) {
                r.w = Some(jw);
                r.h = Some(jh);
            }
            r.orientation = Some(xmp::jpeg_exif_orientation(&b).unwrap_or(1));
        }
    }
    let (mut w, mut h) = (r.w, r.h);
    // 在本程式（或 Bridge）旋轉過的方向優先
    if matches!(xmp_orientation(item).or(r.orientation), Some(5..=8)) {
        std::mem::swap(&mut w, &mut h);
    }
    Meta {
        capture: r.date.map(|d| d.replacen(':', "-", 2)),
        camera: camera_name(r.make, r.model),
        lens: r.lens,
        iso: r.iso,
        aperture: r.fnum.map(|v| (v * 10.0).round() as f32 / 10.0),
        shutter: r.exposure.map(shutter),
        focal: r.focal.map(|v| v.round() as f32),
        width: w,
        height: h,
        rating: rl.rating.unwrap_or(0),
        label: rl.label,
        edited: rl.edited,
        duration: None,
    }
}

/// 旋轉後記在 XMP 的方向：RAW / 其他格式看附屬檔；JPEG 只在沒有 EXIF 方向欄位時才看內嵌 XMP
pub fn xmp_orientation(item: &Item) -> Option<u16> {
    let f = item.display();
    match f.class {
        Class::Jpeg => {
            let mut buf = vec![0u8; 256 * 1024];
            let n = std::io::Read::read(&mut std::fs::File::open(&f.path).ok()?, &mut buf).ok()?;
            if xmp::jpeg_exif_orientation(&buf[..n]).is_some() {
                return None;
            }
            xmp::jpeg_xmp_orientation(&f.path)
        }
        _ => xmp::sidecar_orientation(&item.sidecar_path()),
    }
}

/// 項目的顯示方向（含旋轉過的結果）。`data` 是顯示用檔案的內容（mmap）
pub fn item_orientation(item: &Item, data: &[u8]) -> u16 {
    let f = item.display();
    match f.class {
        Class::Jpeg => xmp::jpeg_exif_orientation(data).or_else(|| xmp::jpeg_xmp_orientation(&f.path)).unwrap_or(1),
        // HEIC：以轉成 JPEG 後的 EXIF 方向為準（與解碼出來的像素一致）
        _ if crate::heic::is_heif(f) => xmp::sidecar_orientation(&item.sidecar_path()).unwrap_or_else(|| crate::heic::orientation(f)),
        _ => xmp::sidecar_orientation(&item.sidecar_path()).unwrap_or_else(|| orientation(f.class, data)),
    }
}

/// 只取方向。`data` 是整個檔案（mmap）。
pub fn orientation(class: Class, data: &[u8]) -> u16 {
    let from_exif = |bytes: &[u8]| {
        exif_from_jpeg(bytes).and_then(|ex| {
            ex.get_field(exif::Tag::Orientation, In::PRIMARY).and_then(|f| f.value.get_uint(0)).map(|v| v as u16)
        })
    };
    let o = match class {
        Class::Jpeg | Class::Image => from_exif(data),
        _ => {
            if tiff::is_cr3(data) {
                tiff::find_box(data, b"CMT1").and_then(tiff::parse).and_then(|t| t.orientation)
            } else {
                tiff::parse(data).and_then(|t| t.orientation).or_else(|| {
                    jpeg::pick(&jpeg::embedded_jpegs(data, 0), u32::MAX).and_then(|j| from_exif(j.bytes(data)))
                })
            }
        }
    };
    o.filter(|v| (1..=8).contains(v)).unwrap_or(1)
}

