//! 清晰度（對焦）評分：拉普拉斯變異數（Variance of Laplacian）。
//!
//! 把影像切成 4×4 區塊，各自計算拉普拉斯運算結果的變異數，取最高的兩塊平均。
//! 這樣「主體清楚、背景散景」的照片不會被誤判為模糊——只要畫面中有一塊是銳利的就好。
//! 分數是相對值：同一批照片中分數明顯偏低的，才標為「可能模糊」（門檻在前端依中位數計算）。

use image::GrayImage;

const GRID: usize = 4;

pub fn sharpness(img: &GrayImage) -> f32 {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w < 16 || h < 16 {
        return 0.0;
    }
    let px = img.as_raw();
    let mut sum = [0f64; GRID * GRID];
    let mut sq = [0f64; GRID * GRID];
    let mut cnt = [0u32; GRID * GRID];
    for y in 1..h - 1 {
        let ty = (y * GRID / h).min(GRID - 1);
        let row = y * w;
        for x in 1..w - 1 {
            let c = px[row + x] as i32;
            let lap = 4 * c - px[row + x - 1] as i32 - px[row + x + 1] as i32 - px[row - w + x] as i32
                - px[row + w + x] as i32;
            let t = ty * GRID + (x * GRID / w).min(GRID - 1);
            let l = lap as f64;
            sum[t] += l;
            sq[t] += l * l;
            cnt[t] += 1;
        }
    }
    let mut vars: Vec<f64> = (0..GRID * GRID)
        .filter(|&t| cnt[t] > 0)
        .map(|t| {
            let n = cnt[t] as f64;
            let m = sum[t] / n;
            sq[t] / n - m * m
        })
        .collect();
    vars.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let top = &vars[..vars.len().min(2)];
    (top.iter().sum::<f64>() / top.len().max(1) as f64) as f32
}

/// 整張影像的拉普拉斯變異數（用於固定尺寸的人臉區域）
pub fn laplacian_variance(img: &GrayImage) -> f32 {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w < 3 || h < 3 {
        return 0.0;
    }
    let px = img.as_raw();
    let (mut sum, mut sq, mut n) = (0f64, 0f64, 0f64);
    for y in 1..h - 1 {
        let row = y * w;
        for x in 1..w - 1 {
            let l = (4 * px[row + x] as i32
                - px[row + x - 1] as i32
                - px[row + x + 1] as i32
                - px[row - w + x] as i32
                - px[row + w + x] as i32) as f64;
            sum += l;
            sq += l * l;
            n += 1.0;
        }
    }
    let m = sum / n;
    (sq / n - m * m) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::imageops;

    #[test]
    fn sharp_scores_higher_than_blurred() {
        let img = GrayImage::from_fn(512, 384, |x, y| image::Luma([if (x / 8 + y / 8) % 2 == 0 { 230 } else { 20 }]));
        let blurred = imageops::blur(&img, 4.0);
        let (s, b) = (sharpness(&img), sharpness(&blurred));
        assert!(s > b * 10.0, "sharp={s} blurred={b}");
    }
}
