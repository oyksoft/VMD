#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows::core::Interface;

#[cfg(target_os = "windows")]
mod assoc;
#[cfg(target_os = "windows")]
mod drop;

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

/// 系统是不是暗色主题（跨平台版本：非 Windows 一律按亮色处理）
fn system_is_dark() -> bool {
    #[cfg(target_os = "windows")]
    {
        windows_system_is_dark()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 主题对应的底色（窗口底色 + WebView2 背景色）
///
/// ⚠️ 这里的色值要和 `src/theme.js` 里同名主题的 `--bg` 保持一致 ——
/// 不一致的话启动时窗口底色和页面首帧颜色对不上，会闪一下。
fn theme_bg_color(theme: &str) -> tauri::window::Color {
    match theme {
        "light"  => tauri::window::Color(0xff, 0xff, 0xff, 0xff),
        "gray"   => tauri::window::Color(0x26, 0x28, 0x2b, 0xff),   // 灰色（中性灰，不带蓝调）
        "sepia"  => tauri::window::Color(0xf7, 0xf0, 0xe2, 0xff),   // 暖阳
        "bamboo" => tauri::window::Color(0xec, 0xf4, 0xea, 0xff),   // 青竹
        "mist"   => tauri::window::Color(0xe9, 0xf0, 0xf8, 0xff),   // 雾蓝
        "dusk"   => tauri::window::Color(0xf1, 0xea, 0xf8, 0xff),   // 暮紫
        _        => tauri::window::Color(0x0d, 0x11, 0x17, 0xff),    // dark
    }
}

/// 同步窗口底色 + WebView2 的 DefaultBackgroundColor
///
/// 两个都要设：
///   - 窗口底色：窗口边框内的空白区域
///   - DefaultBackgroundColor：WebView2 在页面画出第一帧之前画的那层底色
///     （不设的话默认是白色，浅色系统上白闪、深色系统上也是白闪）
fn apply_background_color<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, theme: &str) {
    let color = theme_bg_color(theme);
    let _ = window.set_background_color(Some(color));
    #[cfg(target_os = "windows")]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_COLOR, ICoreWebView2Controller2,
        };
        let (r, g, b, a) = (color.0, color.1, color.2, color.3);
        let _ = window.with_webview(move |webview| {
            unsafe {
                let controller = webview.controller();
                if let Ok(c2) = controller.cast::<ICoreWebView2Controller2>() {
                    let _ = c2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                        A: a, R: r, G: g, B: b,
                    });
                }
            }
        });
    }
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
fn apply_webview_color_scheme(window: &tauri::WebviewWindow, scheme: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_13,
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_AUTO,
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_DARK,
            COREWEBVIEW2_PREFERRED_COLOR_SCHEME_LIGHT,
        };
        use windows::core::Interface;
        let scheme_for_cb = scheme.to_string();
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

/// 设置 WebView2 的首选配色方案（前端切换主题时调用）
#[tauri::command]
fn set_webview_color_scheme(window: tauri::WebviewWindow, scheme: String) -> Result<(), String> {
    apply_webview_color_scheme(&window, &scheme)
}

/// 读取文件的修改时间 + 大小，用来判断文件是不是被外部程序改过
/// 返回 null 表示文件不存在
#[tauri::command]
fn file_stamp(path: String) -> Option<serde_json::Value> {
    let meta = fs::metadata(&path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos() as u64;
    Some(serde_json::json!({ "mtime": mtime, "size": meta.len() }))
}

/// 注册 / 取消文件关联（.md / .markdown 用 VMD 打开）
#[tauri::command]
fn set_file_association(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if enable {
            crate::assoc::register()?;
        } else {
            crate::assoc::unregister()?;
        }
    }
    Ok(())
}

/// 文件关联状态：{ linked: 是否已关联, exe: 当前程序路径 }
#[tauri::command]
fn file_association_status() -> serde_json::Value {
    #[cfg(target_os = "windows")]
    {
        let (linked, exe) = crate::assoc::status();
        return serde_json::json!({ "linked": linked, "exe": exe });
    }
    #[cfg(not(target_os = "windows"))]
    {
        serde_json::json!({ "linked": false, "exe": "" })
    }
}

/// 启动时命令行里带的文件路径
///
/// 用文件关联双击 `.md` 打开时，Windows 会把路径作为参数传给 exe（`"exe" "%1"`）。
fn startup_file_path() -> Option<String> {
    let cwd = std::env::current_dir().unwrap_or_default();
    std::env::args()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .find_map(|a| {
            let p = PathBuf::from(&a);
            let p = if p.is_absolute() { p } else { cwd.join(p) };
            if p.is_file() {
                Some(p.to_string_lossy().to_string())
            } else {
                None
            }
        })
}

/// 启动时命令行里带的文件路径（给前端用）
#[tauri::command]
fn startup_files() -> Vec<String> {
    startup_file_path().into_iter().collect()
}

/// 设置窗口标题（打开文件后显示"文件名 - VMD"）
#[tauri::command]
fn set_window_title(window: tauri::WebviewWindow, title: String) {
    let _ = window.set_title(&title);
}

/// 当前版本号（设置面板里显示）
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// 自定义右键菜单是否启用（关掉后恢复 WebView2 原生菜单）
static CTX_MENU_ENABLED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(true);

/// 启用/停用 VMD 自己的右键菜单
#[tauri::command]
fn set_context_menu_enabled(enabled: bool) {
    CTX_MENU_ENABLED.store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// 设置文件的位置（Rust 侧权威数据源）
///
/// 用文件而不是 localStorage，是因为**窗口底色在页面加载之前就要定下来** ——
/// Rust 得同步读到设置，否则启动时会先闪一下系统主题的底色再切到用户选的主题。
fn settings_file() -> std::path::PathBuf {
    // identifier 来自 tauri.conf.json（com.vmd.app）
    let base = std::env::var("LOCALAPPDATA").unwrap_or_default();
    std::path::PathBuf::from(base)
        .join("com.vmd.app")
        .join("settings.json")
}

/// 读设置文件（读不到就是没设置过）
fn read_settings() -> serde_json::Value {
    fs::read_to_string(settings_file())
        .ok()
        // 去掉 BOM（有些编辑器写 UTF-8 BOM，带 BOM 会让 JSON 解析直接失败）
        .map(|s| s.trim_start_matches('\u{feff}').to_string())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// 保存设置（前端调用）
#[tauri::command]
fn save_settings(settings: serde_json::Value) -> Result<(), String> {
    let path = settings_file();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let text = serde_json::to_string_pretty(&settings).unwrap_or_default();
    fs::write(&path, text).map_err(|e| format!("保存设置失败：{e}"))
}

/// 设置文件路径（设置面板里显示）
#[tauri::command]
fn settings_path() -> String {
    settings_file().to_string_lossy().to_string()
}

/// 添加/移除系统右键菜单里的「用 VMD 打开」
#[tauri::command]
fn set_shell_menu(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if enable {
            crate::assoc::register_menu()?;
        } else {
            crate::assoc::unregister_menu()?;
        }
    }
    Ok(())
}

/// 系统右键菜单项是否已添加
#[tauri::command]
fn shell_menu_status() -> bool {
    #[cfg(target_os = "windows")]
    {
        return crate::assoc::menu_status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// 设置窗口 + WebView2 的背景色（消除启动白闪；主题切换时也要跟着变，否则会有色差）
#[tauri::command]
fn set_window_background<R: tauri::Runtime>(window: tauri::WebviewWindow<R>, theme: String) {
    apply_background_color(&window, &theme);
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
                    // 关掉了自定义菜单 → 不处理，让 WebView2 显示原生菜单
                    if !CTX_MENU_ENABLED.load(std::sync::atomic::Ordering::Relaxed) {
                        return Ok(());
                    }
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

#[cfg(test)]
mod tests {
    use super::theme_bg_color;

    /// 窗口底色和 `src/theme.js` 里的 `--bg` 必须一致，
    /// 否则启动时窗口底色和页面首帧颜色对不上，会闪一下。
    #[test]
    fn theme_bg_matches_theme_js() {
        let js = include_str!("../../src/theme.js");
        for name in [
            "light", "gray", "dark", "sepia", "bamboo", "mist", "dusk",
        ] {
            let marker = format!("\n    {}: {{", name);
            let start = js
                .find(&marker)
                .unwrap_or_else(|| panic!("theme.js 里找不到主题 {}", name));
            let block = &js[start..];
            let end = block.find("\n    },").unwrap_or(0);
            let block = &block[..end];
            let c = theme_bg_color(name);
            let hex = format!("#{:02x}{:02x}{:02x}", c.0, c.1, c.2);
            assert!(
                block.contains(&format!("'--bg': '{}'", hex)),
                "主题 {} 在 theme.js 里的 --bg 应为 {}",
                name,
                hex
            );
        }
    }
}

fn main() {
    // 启动时读设置：窗口底色、WebView2 背景色、前端首帧配色都要用它，必须在建窗口之前就知道。
    // 设置的是"跟随系统"时，才退回读注册表的系统主题。
    let saved = read_settings();
    let saved_theme = saved
        .get("theme")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let sys_theme = if system_is_dark() { "dark" } else { "light" };
    let startup_theme = if saved_theme.is_empty() || saved_theme == "auto" {
        sys_theme.to_string()
    } else {
        saved_theme.clone()
    };
    let bg_color = theme_bg_color(&startup_theme);
    let saved_json = serde_json::to_string(&saved).unwrap_or_else(|_| "null".to_string());

    // 用文件关联双击打开的文件：路径 + 内容一起注入页面。
    // 内容小的直接塞进去 → **首帧就是文件内容**，不会先闪一下欢迎页再跳到文件。
    let startup_path = startup_file_path();
    let startup_content: Option<String> = startup_path
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .filter(|c| c.len() < 512 * 1024);   // 太大的文件前端再异步读
    let startup_json = serde_json::to_string(&serde_json::json!({
        "path": startup_path,
        "content": startup_content,
    }))
    .unwrap_or_else(|_| "null".to_string());
    // 启动模式也一起定好：首帧就是阅读模式或编辑模式，不会先显示一种再跳到另一种
    let start_in_read_mode = saved.get("mode").and_then(|v| v.as_str()) != Some("edit");
    let mode_js = if start_in_read_mode {
        "document.documentElement.classList.add('read-mode');"
    } else {
        "document.documentElement.classList.remove('read-mode');"
    };
    eprintln!(
        "[vmd] 启动主题 = {}（设置里的 theme = {}，系统主题 = {}）",
        startup_theme,
        if saved_theme.is_empty() { "未设置".to_string() } else { saved_theme },
        sys_theme
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            #[cfg(target_os = "windows")]
            {
                let h = app.handle().clone();
                // 自己创建主窗口（tauri.conf.json 里是 "create": false）：
                // 这样窗口底色和 WebView2 的 DefaultBackgroundColor 能在创建的那一刻
                // 就设成用户设置的主题色 —— 否则会先闪一下别的颜色再切过来。
                if let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() {
                    let win = tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?
                        .background_color(bg_color)
                        // 关掉 wry 自带的拖放处理：它注册在 WebView2 的子窗口上，
                        // 拿不到 CF_HDROP 时会显示"禁止"光标。我们自己接管（见 drop.rs）。
                        .disable_drag_drop_handler()
                        // 把设置和启动主题告诉前端：前端在首帧绘制前就用它们定配色（见 src/theme.js）
                        .initialization_script(format!(
                            "window.__VMD_SETTINGS__ = {}; window.__VMD_INIT_THEME__ = \"{}\"; window.__VMD_STARTUP__ = {}; {}",
                            saved_json, sys_theme, startup_json, mode_js
                        ))
                        .build()?;
                    // WebView2 首选配色方案：让 prefers-color-scheme 跟系统一致
                    let _ = apply_webview_color_scheme(&win, sys_theme);
                    // 自己接管文件拖放（wry 那套在非 shell 来源拖文件时会显示"禁止"光标）
                    crate::drop::install(app.handle(), &win);
                }

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
            set_window_background,
            set_window_title,
            file_stamp,
            set_file_association,
            file_association_status,
            app_version,
            set_shell_menu,
            shell_menu_status,
            set_context_menu_enabled,
            settings_path,
            save_settings,
            startup_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}