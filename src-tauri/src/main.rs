#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

/// 读取 Windows 系统主题（读注册表 AppsUseLightTheme）
/// Tauri 2 在窗口主题为 Auto 时会把 WebView2 强制设成 Light，
/// 导致前端 matchMedia('(prefers-color-scheme: dark)') 永远读不到真实系统主题。
#[cfg(target_os = "windows")]
fn windows_system_is_dark() -> bool {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::core::w;
    unsafe {
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut _ as _),
            Some(&mut size),
        );
        if status.is_ok() {
            return data == 0; // 0 = 暗色
        }
    }
    false
}

/// 用系统默认程序打开 URL（替代 tauri-plugin-shell，省体积）
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        use windows::core::HSTRING;
        let op: HSTRING = HSTRING::from("open");
        let file: HSTRING = HSTRING::from(url);
        unsafe {
            let r = ShellExecuteW(
                None, &op, &file, None, None, SW_SHOWNORMAL,
            );
            if r.0 as isize <= 32 {
                return Err(format!("ShellExecuteW failed: {}", r.0 as isize));
            }
        }
    }
    Ok(())
}

/// 返回当前系统主题："dark" 或 "light"
#[tauri::command]
fn system_theme() -> String {
    #[cfg(target_os = "windows")]
    {
        if windows_system_is_dark() {
            return "dark".to_string();
        }
    }
    "light".to_string()
}

/// 设置 WebView2 的首选配色方案（只影响 prefers-color-scheme，不改窗口主题，
/// 这样 tao 仍能感知系统主题切换并发出 tauri://theme-changed 事件）
#[tauri::command]
fn set_webview_color_scheme(window: tauri::WebviewWindow, scheme: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_13,
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO,
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
        };
        use windows::core::Interface;
        let scheme_for_cb = scheme.clone();
        let err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let err_in = err.clone();
        window
            .with_webview(move |webview| {
                unsafe {
                    let core = match webview.controller().CoreWebView2() {
                        Ok(c) => c,
                        Err(e) => { *err_in.lock().unwrap() = Some(format!("CoreWebView2: {e}")); return; }
                    };
                    let core13: ICoreWebView2_13 = match core.cast() {
                        Ok(c) => c,
                        Err(e) => { *err_in.lock().unwrap() = Some(format!("cast ICoreWebView2_13: {e}")); return; }
                    };
                    let profile = match core13.Profile() {
                        Ok(p) => p,
                        Err(e) => { *err_in.lock().unwrap() = Some(format!("Profile: {e}")); return; }
                    };
                    let v = match scheme_for_cb.as_str() {
                        "dark" => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
                        "light" => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
                        _ => COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO,
                    };
                    if let Err(e) = profile.SetPreferredColorScheme(v) {
                        *err_in.lock().unwrap() = Some(format!("SetPreferredColorScheme: {e}"));
                    }
                }
            })
            .map_err(|e| format!("with_webview: {e}"))?;
        let opt = err.lock().unwrap().take();
        if let Some(e) = opt {
            return Err(e);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, scheme);
    }
    Ok(())
}

/// 实际执行 PrintToPdf 的核心逻辑（供 command 和自测复用）
#[cfg(target_os = "windows")]
fn do_print_to_pdf<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, path: String) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_7, ICoreWebView2Environment6,
        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
    };
    use webview2_com::PrintToPdfCompletedHandler;
    use windows::core::{Interface, PCWSTR};

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let err: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let err_in = err.clone();
    let path_for_cb = path.clone();

    window
        .with_webview(move |webview| {
            unsafe {
                let core = match webview.controller().CoreWebView2() {
                    Ok(c) => c,
                    Err(e) => { *err_in.lock().unwrap() = Some(format!("CoreWebView2: {e}")); return; }
                };
                // ICoreWebView2_7 才有 PrintToPdf
                let core7: ICoreWebView2_7 = match core.cast() {
                    Ok(c) => c,
                    Err(e) => { *err_in.lock().unwrap() = Some(format!("cast ICoreWebView2_7: {e}")); return; }
                };
                // 新建打印设置（A4 纵向：210×297mm = 8.27×11.69 inch）
                let settings = match webview.environment().cast::<ICoreWebView2Environment6>() {
                    Ok(env6) => match env6.CreatePrintSettings() {
                        Ok(s) => s,
                        Err(e) => { *err_in.lock().unwrap() = Some(format!("CreatePrintSettings: {e}")); return; }
                    },
                    Err(e) => { *err_in.lock().unwrap() = Some(format!("cast Environment6: {e}")); return; }
                };
                let _ = settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT);
                let _ = settings.SetPageWidth(8.27);
                let _ = settings.SetPageHeight(11.69);
                let _ = settings.SetScaleFactor(1.0);
                let _ = settings.SetMarginTop(0.4);
                let _ = settings.SetMarginBottom(0.4);
                let _ = settings.SetMarginLeft(0.4);
                let _ = settings.SetMarginRight(0.4);

                let tx2 = tx.clone();
                let handler = PrintToPdfCompletedHandler::create(
                    Box::new(move |hr: Result<(), windows::core::Error>, _ok: bool| {
                        if hr.is_err() {
                            let _ = tx2.send(Err(format!("PrintToPdf failed: {:?}", hr)));
                        } else {
                            let _ = tx2.send(Ok(()));
                        }
                        Ok(())
                    }),
                );
                let wpath: Vec<u16> = path_for_cb.encode_utf16().chain(std::iter::once(0)).collect();
                let r = core7.PrintToPdf(PCWSTR(wpath.as_ptr()), &settings, &handler);
                if let Err(e) = r {
                    *err_in.lock().unwrap() = Some(format!("PrintToPdf: {e}"));
                }
            }
        })
        .map_err(|e| format!("with_webview: {e}"))?;

    // 等打印完成（最多 30 秒）
    let res: Result<(), String> = rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "PrintToPdf 超时".to_string())?;
    if let Some(e) = err.lock().unwrap().take() {
        return Err(e);
    }
    res
}

/// 导出 PDF：用 WebView2 自带的 PrintToPdf（同一渲染引擎，所见即所得）
/// 必须是 async —— with_webview 会 post 到主线程事件循环并等待，
/// 同步 command 会在主线程阻塞 → 死锁。async 让它跑在 worker 线程，主线程空出来处理 COM 回调。
#[cfg(target_os = "windows")]
#[tauri::command]
async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    do_print_to_pdf(&window, path)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
async fn export_pdf(_window: tauri::WebviewWindow, _path: String) -> Result<(), String> {
    Err("PDF 导出目前只支持 Windows".to_string())
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
            export_pdf,
            system_theme,
            open_url,
            set_webview_color_scheme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}