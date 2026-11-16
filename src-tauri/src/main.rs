// Windows release 版不要跳出主控台視窗
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    photo_selector_lib::run()
}
