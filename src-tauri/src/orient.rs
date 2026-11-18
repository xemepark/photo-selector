//! 旋轉照片（[ 逆時針、] 順時針 90°），結果存回原檔：
//! - JPEG：改寫 EXIF 方向（不重新壓縮，畫質不變）
//! - RAW / 其他格式：寫進附屬檔的 tiff:Orientation（與 Bridge / Camera Raw 相同）

use crate::render::apply_orientation;
use crate::scan::{Class, Item};
use crate::xmp;
use image::{DynamicImage, RgbImage};
use std::io;
use std::sync::OnceLock;

/// 方向 o 的照片再旋轉 90° 後的新方向（含鏡像的方向也正確）：用一張 3×2 小圖實際套用比對
pub fn rotated(o: u16, clockwise: bool) -> u16 {
    static TABLE: OnceLock<[[u16; 2]; 9]> = OnceLock::new();
    let t = TABLE.get_or_init(|| {
        let base = DynamicImage::ImageRgb8(RgbImage::from_fn(3, 2, |x, y| image::Rgb([(x * 40) as u8, (y * 100) as u8, (x + y * 3) as u8])));
        let mut t = [[1u16; 2]; 9];
        for o in 1..=8u16 {
            let shown = apply_orientation(base.clone(), o);
            for (k, cw) in [(0, false), (1, true)] {
                let want = if cw { shown.rotate90() } else { shown.rotate270() };
                t[o as usize][k] = (1..=8u16)
                    .find(|&n| apply_orientation(base.clone(), n).to_rgb8().as_raw() == want.to_rgb8().as_raw())
                    .unwrap_or(1);
            }
        }
        t
    });
    t[o.clamp(1, 8) as usize][clockwise as usize]
}

/// 目前的顯示方向
pub fn current(item: &Item) -> u16 {
    let f = item.display();
    std::fs::File::open(&f.path)
        .ok()
        .and_then(|file| unsafe { memmap2::Mmap::map(&file) }.ok())
        .map(|data| crate::meta::item_orientation(item, &data))
        .unwrap_or(1)
}

/// 旋轉一個項目（RAW+JPEG 兩邊都寫），回傳新方向
pub fn rotate_item(item: &Item, clockwise: bool) -> io::Result<u16> {
    let new = rotated(current(item), clockwise);
    for f in item.files.iter().filter(|f| f.class == Class::Jpeg) {
        xmp::set_jpeg_orientation(&f.path, new)?;
    }
    if item.files.iter().any(|f| f.class != Class::Jpeg) {
        xmp::update_props(&item.sidecar_path(), &[("tiff:Orientation", Some(new.to_string()))])?;
    }
    Ok(new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rotation_table() {
        // 一般方向：1 → 6 → 3 → 8 → 1（順時針）
        assert_eq!(rotated(1, true), 6);
        assert_eq!(rotated(6, true), 3);
        assert_eq!(rotated(3, true), 8);
        assert_eq!(rotated(8, true), 1);
        for o in 1..=8 {
            assert_eq!(rotated(rotated(o, true), false), o, "順轉再逆轉要回到原方向");
            let mut x = o;
            for _ in 0..4 {
                x = rotated(x, true);
            }
            assert_eq!(x, o, "轉四次回到原方向");
        }
    }

    fn jpg(path: &std::path::Path) {
        let img = DynamicImage::ImageRgb8(RgbImage::from_fn(60, 40, |x, _| image::Rgb([(x * 4) as u8, 0, 0])));
        fs::write(path, crate::render::encode_jpeg(&img, 95).unwrap()).unwrap();
    }

    #[test]
    fn rotate_jpeg_without_exif_and_raw_pair() {
        let dir = std::env::temp_dir().join(format!("orient-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        jpg(&dir.join("A.jpg"));
        jpg(&dir.join("R.JPG"));
        fs::write(dir.join("R.NEF"), b"raw").unwrap();
        let orig = fs::read(dir.join("A.jpg")).unwrap();
        let (items, _) = crate::scan::scan_dir(&dir).unwrap();
        let a = items.iter().find(|i| i.name == "A").unwrap();
        assert_eq!(rotate_item(a, true).unwrap(), 6);
        // 插入了 EXIF、影像資料原封不動、可以解碼、方向讀得回來
        let d = fs::read(dir.join("A.jpg")).unwrap();
        assert_eq!(xmp::jpeg_exif_orientation(&d), Some(6));
        assert!(d.ends_with(&orig[20..]));
        assert!(image::load_from_memory(&d).is_ok());
        // 再轉：原地改寫（大小不變）
        let len = d.len();
        assert_eq!(rotate_item(a, true).unwrap(), 3);
        assert_eq!(fs::read(dir.join("A.jpg")).unwrap().len(), len);
        assert_eq!(rotate_item(a, false).unwrap(), 6);
        // 縮圖跟著轉（寬高對調）
        let thumb = crate::render::render(a, crate::render::Kind::Thumb).unwrap();
        let t = image::load_from_memory(&thumb).unwrap();
        assert!(t.height() > t.width());
        // RAW+JPEG：JPEG 寫 EXIF、附屬檔寫 tiff:Orientation
        let r = items.iter().find(|i| i.name == "R").unwrap();
        assert_eq!(rotate_item(r, false).unwrap(), 8);
        assert_eq!(xmp::jpeg_exif_orientation(&fs::read(dir.join("R.JPG")).unwrap()), Some(8));
        assert_eq!(xmp::sidecar_orientation(&dir.join("R.xmp")), Some(8));
        let _ = fs::remove_dir_all(&dir);
    }
}
