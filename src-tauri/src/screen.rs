//! 截圖相關的 macOS 功能：檢查螢幕錄影權限、從剪貼簿取得系統截圖。
//!
//! 沒有權限時先引導使用者授權一次（CI 用固定的自製憑證簽署，之後更新不必重設）；
//! 也可以改用系統自己的截圖（⌃⇧⌘4 截到剪貼簿），程式只讀剪貼簿，不需要任何權限。

#[cfg(target_os = "macos")]
mod imp {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeTIFF};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    /// 目前這一版有沒有螢幕錄影權限（只檢查，不會跳出提醒）
    pub fn has_permission() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }

    /// 要求螢幕錄影權限：會把程式加進「螢幕與系統錄音」清單（使用者只要打開開關）
    pub fn request_permission() -> bool {
        unsafe { CGRequestScreenCaptureAccess() }
    }

    pub fn change_count() -> isize {
        NSPasteboard::generalPasteboard().changeCount()
    }

    /// 剪貼簿裡的圖片，一律轉成 PNG
    pub fn image_png() -> Option<Vec<u8>> {
        let pb = NSPasteboard::generalPasteboard();
        #[allow(unused_unsafe)]
        unsafe {
            if let Some(d) = pb.dataForType(NSPasteboardTypePNG) {
                return Some(d.to_vec());
            }
            if let Some(d) = pb.dataForType(NSPasteboardTypeTIFF) {
                let img = image::load_from_memory(&d.to_vec()).ok()?;
                let mut out = std::io::Cursor::new(Vec::new());
                img.write_to(&mut out, image::ImageFormat::Png).ok()?;
                return Some(out.into_inner());
            }
        }
        None
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn has_permission() -> bool {
        false
    }
    pub fn request_permission() -> bool {
        false
    }
    pub fn change_count() -> isize {
        0
    }
    pub fn image_png() -> Option<Vec<u8>> {
        None
    }
}

pub use imp::*;
