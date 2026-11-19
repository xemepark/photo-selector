//! 把選取的照片拖曳到其他程式（Finder、LINE、瀏覽器上傳欄、Photoshop…）。
//!
//! 實際的系統拖曳由 tauri-plugin-drag 處理；這裡負責
//! 1. 決定要拖出去的檔案（RAW+JPEG 預設只帶 JPEG，可選擇連 RAW 一起）
//! 2. 用縮圖做一張拖曳時跟著游標的小圖（多張時疊成一疊）

use crate::scan::{Class, Item};
use image::{imageops, Rgba, RgbaImage};
use std::path::{Path, PathBuf};

/// 要拖出去的檔案。`include_raw`：RAW+JPEG 時連 RAW 一起帶；只有 RAW 的項目一律帶 RAW。
/// XMP 側車檔不帶（其他程式通常不需要，也避免對方收到一堆 .xmp）。
pub fn files_for(items: &[&Item], include_raw: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for it in items {
        let display = it.display();
        out.push(display.path.clone());
        if include_raw {
            for f in &it.files {
                if f.class == Class::Raw && f.path != display.path {
                    out.push(f.path.clone());
                }
            }
        }
    }
    out
}

/// 拖曳圖示大小（原本 160：長寬各一半 = 面積 1/4）
const SIZE: u32 = 80;
const BORDER: u32 = 2;
/// 疊放時每張錯開的距離
const STEP: u32 = 5;
/// 拖曳圖示的不透明度（約 40%，看得到底下的分頁）
const OPACITY: f32 = 0.4;

/// 用最多三張縮圖疊成拖曳圖示（PNG，透明背景），寫到 `out`
pub fn make_icon(thumbs: &[Vec<u8>], out: &Path) -> anyhow::Result<()> {
    let layers: Vec<RgbaImage> = thumbs
        .iter()
        .take(3)
        .filter_map(|b| image::load_from_memory(b).ok())
        .map(|img| {
            let inner = SIZE - STEP * 2 - BORDER * 2 - 4; // 留一點邊
            let t = img.thumbnail(inner, inner).to_rgba8();
            let mut framed = RgbaImage::from_pixel(t.width() + BORDER * 2, t.height() + BORDER * 2, Rgba([255, 255, 255, 255]));
            imageops::overlay(&mut framed, &t, BORDER as i64, BORDER as i64);
            framed
        })
        .collect();
    let mut canvas = RgbaImage::from_pixel(SIZE, SIZE, Rgba([0, 0, 0, 0]));
    let n = layers.len();
    // 後面的先畫：第一張在最上面（左上），其餘往右下錯開
    let spread = (n.max(1) as i64 - 1) * STEP as i64;
    for (i, layer) in layers.iter().enumerate().rev() {
        let off = i as i64 * STEP as i64;
        let x = (SIZE as i64 - layer.width() as i64 - spread) / 2 + off;
        let y = (SIZE as i64 - layer.height() as i64 - spread) / 2 + off;
        imageops::overlay(&mut canvas, layer, x, y);
    }
    if n == 0 {
        // 沒有縮圖時畫一個灰色方塊，總比沒有圖示好
        canvas = RgbaImage::from_pixel(96, 96, Rgba([128, 128, 128, 200]));
    }
    for p in canvas.pixels_mut() {
        p[3] = (p[3] as f32 * OPACITY).round() as u8;
    }
    canvas.save_with_format(out, image::ImageFormat::Png)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_stack_fits() {
        let mut jpg = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(300, 200, image::Rgb([200, 30, 30])))
            .write_to(&mut std::io::Cursor::new(&mut jpg), image::ImageFormat::Jpeg)
            .unwrap();
        let out = std::env::temp_dir().join("dragout-test.png");
        make_icon(&[jpg.clone(), jpg.clone(), jpg], &out).unwrap();
        let img = image::open(&out).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (SIZE, SIZE));
        // 四個角落透明、最右下一張的右下角仍在畫布內（白框）
        assert_eq!(img.get_pixel(0, 0)[3], 0);
        let edge = (0..SIZE).rev().find(|&x| img.get_pixel(x, SIZE / 2 + 20)[3] > 0).unwrap();
        assert!(edge < SIZE - 1, "stack overflows canvas");
    }
}
