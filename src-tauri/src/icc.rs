//! 產生精簡的 sRGB ICC v2 描述檔（約 3KB），嵌入轉存的 JPEG / TIFF / PNG。
//!
//! 用 v2 而不是 v4：網頁瀏覽器、舊版看圖軟體、印刷廠流程對 v2 的支援最普遍
//! （moxcms / LittleCMS 預設都只會寫 v4）。內容與常見的 sRGB v2 描述檔相同：
//! D50 白點、Bradford 適應後的原色、1024 點的 sRGB 色調曲線。

fn s15f16(v: f64) -> [u8; 4] {
    ((v * 65536.0).round() as i32).to_be_bytes()
}

fn xyz_tag(x: f64, y: f64, z: f64) -> Vec<u8> {
    let mut t = b"XYZ \0\0\0\0".to_vec();
    for v in [x, y, z] {
        t.extend_from_slice(&s15f16(v));
    }
    t
}

fn desc_tag(s: &str) -> Vec<u8> {
    let mut t = b"desc\0\0\0\0".to_vec();
    t.extend_from_slice(&((s.len() + 1) as u32).to_be_bytes());
    t.extend_from_slice(s.as_bytes());
    t.push(0);
    t.extend_from_slice(&[0; 8]); // Unicode：語言碼、長度 0
    t.extend_from_slice(&[0; 3]); // ScriptCode：代碼、長度 0
    t.extend_from_slice(&[0; 67]);
    t
}

fn text_tag(s: &str) -> Vec<u8> {
    let mut t = b"text\0\0\0\0".to_vec();
    t.extend_from_slice(s.as_bytes());
    t.push(0);
    t
}

fn srgb_trc() -> Vec<u8> {
    const N: usize = 1024;
    let mut t = b"curv\0\0\0\0".to_vec();
    t.extend_from_slice(&(N as u32).to_be_bytes());
    for i in 0..N {
        let v = i as f64 / (N - 1) as f64;
        let l = if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
        t.extend_from_slice(&((l * 65535.0).round() as u16).to_be_bytes());
    }
    t
}

pub fn srgb_v2() -> Vec<u8> {
    let trc = srgb_trc();
    // (標籤, 內容)；三條 TRC 共用同一份資料
    let tags: Vec<(&[u8; 4], Vec<u8>)> = vec![
        (b"desc", desc_tag("sRGB IEC61966-2.1")),
        (b"cprt", text_tag("No copyright, use freely")),
        (b"wtpt", xyz_tag(0.9642, 1.0, 0.8249)),
        (b"rXYZ", xyz_tag(0.436_074_7, 0.222_504_5, 0.013_932_2)),
        (b"gXYZ", xyz_tag(0.385_064_9, 0.716_878_6, 0.097_104_5)),
        (b"bXYZ", xyz_tag(0.143_080_4, 0.060_616_9, 0.714_173_3)),
        (b"rTRC", trc),
    ];
    let count = tags.len() + 2; // + gTRC、bTRC
    let mut data = Vec::new();
    let mut table = Vec::new();
    let mut offset = 128 + 4 + count * 12;
    let mut trc_entry = (0u32, 0u32);
    for (sig, body) in &tags {
        let len = body.len();
        table.push((**sig, offset as u32, len as u32));
        if *sig == b"rTRC" {
            trc_entry = (offset as u32, len as u32);
        }
        data.extend_from_slice(body);
        while data.len() % 4 != 0 {
            data.push(0);
        }
        offset = 128 + 4 + count * 12 + data.len();
    }
    table.push((*b"gTRC", trc_entry.0, trc_entry.1));
    table.push((*b"bTRC", trc_entry.0, trc_entry.1));

    let total = 128 + 4 + count * 12 + data.len();
    let mut p = Vec::with_capacity(total);
    p.extend_from_slice(&(total as u32).to_be_bytes());
    p.extend_from_slice(&[0; 4]); // CMM
    p.extend_from_slice(&[0x02, 0x10, 0, 0]); // 版本 2.1
    p.extend_from_slice(b"mntrRGB XYZ ");
    p.extend_from_slice(&[0x07, 0xCE, 0, 2, 0, 9, 0, 6, 0, 0x31, 0, 0]); // 1998-02-09 06:49:00（與 HP sRGB 相同）
    p.extend_from_slice(b"acsp");
    p.extend_from_slice(&[0; 4]); // 平台
    p.extend_from_slice(&[0; 4]); // flags
    p.extend_from_slice(&[0; 8]); // 製造商、型號
    p.extend_from_slice(&[0; 8]); // 屬性
    p.extend_from_slice(&[0; 4]); // 演算意圖：感知
    for v in [0.9642, 1.0, 0.8249] {
        p.extend_from_slice(&s15f16(v)); // PCS 光源 D50
    }
    p.extend_from_slice(&[0; 4]); // 建立者
    p.resize(128, 0);
    p.extend_from_slice(&(count as u32).to_be_bytes());
    for (sig, off, len) in table {
        p.extend_from_slice(&sig);
        p.extend_from_slice(&off.to_be_bytes());
        p.extend_from_slice(&len.to_be_bytes());
    }
    p.extend_from_slice(&data);
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_profile_parses() {
        let icc = srgb_v2();
        assert_eq!(u32::from_be_bytes(icc[0..4].try_into().unwrap()) as usize, icc.len());
        assert_eq!(&icc[36..40], b"acsp");
        let p = moxcms::ColorProfile::new_from_slice(&icc).expect("moxcms parses");
        // 用它轉到 moxcms 內建 sRGB 應該幾乎不變
        let t = p
            .create_transform_8bit(moxcms::Layout::Rgb, &moxcms::ColorProfile::new_srgb(), moxcms::Layout::Rgb, Default::default())
            .unwrap();
        let src = [200u8, 120, 40, 10, 250, 128];
        let mut dst = [0u8; 6];
        t.transform(&src, &mut dst).unwrap();
        for (a, b) in src.iter().zip(dst) {
            assert!((*a as i32 - b as i32).abs() <= 2, "{src:?} → {dst:?}");
        }
    }
}
