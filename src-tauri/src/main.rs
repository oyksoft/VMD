#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use windows::core::Interface;

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read failed: {}", e))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("write failed: {}", e))
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    PathBuf::from(&path).exists()
}

#[cfg(target_os = "windows")]
fn install_context_menu_handler<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    use tauri::Emitter;
    if let Some(window) = app.get_webview_window("main") {
        let app_owned = app.clone();
        let result = window.with_webview(move |webview| {
            // 取 ICoreWebView2
            let core = unsafe {
                match webview.controller().CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => { eprintln!("[vmd] CoreWebView2: {e}"); return; }
                }
            };

            // 创建 ContextMenuRequested 事件回调
            let window_clone = app_owned.clone();
            let handler = webview2_com::ContextMenuRequestedEventHandler::create(
                Box::new(move |_sender: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2>, args: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuRequestedEventArgs>| {
                    if let Some(args) = args {
                        unsafe {
                            // 告诉 WebView2 不要显示默认菜单
                            if let Err(e) = args.SetHandled(true) {
                                eprintln!("[vmd] SetHandled: {e}");
                            }
                            // 取鼠标坐标
                            let mut loc = windows::Win32::Foundation::POINT { x: 0, y: 0 };
                            if let Err(e) = args.Location(&mut loc) {
                                eprintln!("[vmd] Location: {e}");
                                return Ok(());
                            }
                            // 把坐标发给前端
                            let _ = window_clone.emit("vmd-rclick", serde_json::json!({
                                "x": loc.x, "y": loc.y
                            }));
                        }
                    }
                    Ok(())
                })
            );
            // cast core 为 ICoreWebView2_11（包含 ContextMenuRequested）
            let core11: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11 = match core.cast() {
                Ok(c) => c,
                Err(e) => { eprintln!("[vmd] cast ICoreWebView2_11: {e}"); return; }
            };
            let mut token: i64 = 0;
            let _ = unsafe { core11.add_ContextMenuRequested(&handler, &mut token) };
            eprintln!("[vmd] ContextMenuRequested handler installed");
        });
        if let Err(e) = result {
            eprintln!("[vmd] with_webview error: {e}");
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(800));
                    install_context_menu_handler(&h);
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}