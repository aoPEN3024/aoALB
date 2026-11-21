// Windowsでコンソール窓を出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() { aoalb2_app_lib::run() }
