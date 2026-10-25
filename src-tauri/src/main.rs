#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows::core::Interface;

#[cfg(target_os = "windows")]
mod assoc;
#[cfg(target_os = "windows")]
mod drop;

// ============ 文本文件读写（编码感知 + 原子写入）============

/// 读出来的文本 + 原文件编码。保存时按原编码写回。
///
/// 为什么不统一转成 UTF-8 存：中文 Windows 上不少 `.txt` 是 GBK，
/// 悄悄改成 UTF-8 会让 git diff 满屏、别的工具也可能不认。BOM 同理。
#[derive(serde::Serialize)]
struct FileText {
    content: String,
    /// utf-8 / utf-8-bom / utf-16le / utf-16be / ansi（ansi = 系统代码页，中文系统就是 GBK）
    encoding: String,
}

/// 把原始字节解成文本，同时告诉前端这是什么编码
fn decode_text(bytes: &[u8]) -> Result<(String, String), String> {
    // 1. BOM 最权威，BOM 本身不留在内容里
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec())
            .map(|s| (s, "utf-8-bom".to_string()))
            .map_err(|_| "文件声明自己是 UTF-8 BOM，内容却不是合法 UTF-8".to_string());
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return Ok((utf16_to_string(rest, true), "utf-16le".to_string()));
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return Ok((utf16_to_string(rest, false), "utf-16be".to_string()));
    }
    // 2. 没有 BOM，先按 UTF-8 试（现行标准）
    if let Ok(s) = std::str::from_utf8(bytes) {
        return Ok((s.to_string(), "utf-8".to_string()));
    }
    // 3. 退回系统 ANSI 代码页（中文 Windows = GBK/GB18030 系列）
    #[cfg(target_os = "windows")]
    if let Some(s) = ansi_to_string(bytes) {
        return Ok((s, "ansi".to_string()));
    }
    Err("这个文件不是 UTF-8 / UTF-16 编码，按系统编码也读不出来（可能是二进制文件）".to_string())
}

/// UTF-16 字节 → String（不合法代理对用 U+FFFD 代替，不报错）
fn utf16_to_string(bytes: &[u8], little_endian: bool) -> String {
    let mut units = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        units.push(if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        });
    }
    String::from_utf16_lossy(&units)
}

/// 文本 → 要写进磁盘的字节（按 encoding 还原 BOM / UTF-16 / ANSI）
fn encode_text(content: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "utf-8-bom" => {
            let mut out = vec![0xEF, 0xBB, 0xBF];
            out.extend_from_slice(content.as_bytes());
            Ok(out)
        }
        "utf-16le" => {
            let mut out = vec![0xFF, 0xFE];
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_le_bytes());
            }
            Ok(out)
        }
        "utf-16be" => {
            let mut out = vec![0xFE, 0xFF];
            for u in content.encode_utf16() {
                out.extend_from_slice(&u.to_be_bytes());
            }
            Ok(out)
        }
        "ansi" => {
            #[cfg(target_os = "windows")]
            {
                string_to_ansi(content)
                    .ok_or_else(|| "按系统编码保存失败（内容里有 GBK 表示不了的字符）".to_string())
            }
            #[cfg(not(target_os = "windows"))]
            {
                Ok(content.as_bytes().to_vec())
            }
        }
        // 默认（以及任何不认识的编码名）都按 UTF-8 写
        _ => Ok(content.as_bytes().to_vec()),
    }
}

/// 系统 ANSI 代码页 → String
#[cfg(target_os = "windows")]
fn ansi_to_string(bytes: &[u8]) -> Option<String> {
    use windows::Win32::Globalization::{MultiByteToWideChar, CP_ACP, MULTI_BYTE_TO_WIDE_CHAR_FLAGS};
    if bytes.is_empty() {
        return Some(String::new());
    }
    let flags = MULTI_BYTE_TO_WIDE_CHAR_FLAGS(0);
    let need = unsafe { MultiByteToWideChar(CP_ACP, flags, bytes, None) };
    if need <= 0 {
        return None;
    }
    let mut buf = vec![0u16; need as usize];
    let got = unsafe { MultiByteToWideChar(CP_ACP, flags, bytes, Some(&mut buf)) };
    if got <= 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(String::from_utf16_lossy(&buf))
}

/// String → 系统 ANSI 代码页字节（表示不了的字符会被换成 '?'，和别的记事本类工具一致）
#[cfg(target_os = "windows")]
fn string_to_ansi(s: &str) -> Option<Vec<u8>> {
    use windows::core::PCSTR;
    use windows::Win32::Globalization::{WideCharToMultiByte, CP_ACP};
    if s.is_empty() {
        return Some(Vec::new());
    }
    let wide: Vec<u16> = s.encode_utf16().collect();
    let need = unsafe { WideCharToMultiByte(CP_ACP, 0, &wide, None, PCSTR::null(), None) };
    if need <= 0 {
        return None;
    }
    let mut buf = vec![0u8; need as usize];
    let got = unsafe {
        WideCharToMultiByte(CP_ACP, 0, &wide, Some(&mut buf), PCSTR::null(), None)
    };
    if got <= 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(buf)
}

/// 原子写入：先写同目录临时文件 → fsync → rename 覆盖目标。
///
/// 直接 `fs::write` 是「截断 + 写」，中途崩溃/断电/被杀软锁住会留下**半截文档**。
/// 改名是原子操作，所以目标文件要么是旧的完整版本，要么是新的完整版本。
fn write_atomic(path: &str, bytes: &[u8]) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    let target = PathBuf::from(path);
    let name = target
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "无效的文件路径"))?
        .to_string_lossy()
        .to_string();
    let dir = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    // 临时文件名带 PID + 序号：多开实例、同一进程连续保存都不会撞名
    let tmp = dir.join(format!(
        ".{}.{}.{}.vmd-tmp",
        name,
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // 先保证数据真的落盘，再改名 —— 否则改名成功但内容还在缓存里，断电就是空文件
        f.sync_all()?;
        drop(f);
        // Windows 上 std 的 rename 用 MOVEFILE_REPLACE_EXISTING，可以直接覆盖
        fs::rename(&tmp, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);   // 失败别把临时文件留在用户目录里
    }
    result
}

#[tauri::command]
fn read_file(path: String) -> Result<FileText, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, encoding) = decode_text(&bytes)?;
    Ok(FileText { content, encoding })
}

#[tauri::command]
fn write_file(path: String, content: String, encoding: Option<String>) -> Result<(), String> {
    let encoding = encoding.unwrap_or_else(|| "utf-8".to_string());
    let bytes = encode_text(&content, &encoding)?;
    write_atomic(&path, &bytes).map_err(|e| e.to_string())
}

/// 导出 HTML：把正文里的本地图片换成 base64 内嵌，输出自包含的单文件
/// （不引任何依赖：base64 编码和 img 替换都是自己实现的）
#[tauri::command]
fn export_html(path: String, html: String, base_dir: String) -> Result<(), String> {
    let html = inline_local_images(&html, &base_dir);
    write_atomic(&path, html.as_bytes()).map_err(|e| e.to_string())
}

/// base64 编码（不引 base64 crate，省体积）
fn base64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b0 = c[0] as u32;
        let b1 = *c.get(1).unwrap_or(&0) as u32;
        let b2 = *c.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 按扩展名猜 MIME
fn mime_of(path: &str) -> &'static str {
    let p = path.to_ascii_lowercase();
    if p.ends_with(".png") {
        "image/png"
    } else if p.ends_with(".jpg") || p.ends_with(".jpeg") {
        "image/jpeg"
    } else if p.ends_with(".gif") {
        "image/gif"
    } else if p.ends_with(".webp") {
        "image/webp"
    } else if p.ends_with(".svg") {
        "image/svg+xml"
    } else if p.ends_with(".bmp") {
        "image/bmp"
    } else if p.ends_with(".ico") {
        "image/x-icon"
    } else if p.ends_with(".avif") {
        "image/avif"
    } else {
        "application/octet-stream"
    }
}

/// percent 解码（marked 会把图片路径里的中文/空格编码成 %XX，
/// 直接拿编码后的路径去磁盘读会读不到 —— 中文名图片全中招）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 取标签里某个属性值在标签中的位置（返回值的起止下标）
fn attr_span(tag: &str, name: &str) -> Option<(usize, usize)> {
    for q in ['"', '\''] {
        let pat = format!("{}={}", name, q);
        if let Some(i) = tag.find(&pat) {
            let s = i + pat.len();
            if let Some(e) = tag[s..].find(q) {
                return Some((s, s + e));
            }
        }
    }
    None
}

/// 读一张本地图片，转成 data URI（相对路径按 markdown 文件所在目录找）
fn img_to_data_uri(base_dir: &str, src: &str) -> Option<String> {
    let p = PathBuf::from(src);
    let full = if p.is_absolute() {
        p
    } else {
        PathBuf::from(base_dir).join(p)
    };
    let data = fs::read(&full).ok()?;
    Some(format!(
        "data:{};base64,{}",
        mime_of(&full.to_string_lossy()),
        base64_encode(&data)
    ))
}

/// 把 HTML 里 <img src="本地路径"> 换成 base64 内嵌（远程图片和 data: 原样保留）
fn inline_local_images(html: &str, base_dir: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(pos) = rest.find("<img") {
        let (head, tail) = rest.split_at(pos);
        out.push_str(head);
        let tag_end = match tail.find('>') {
            Some(i) => i + 1,
            None => {
                out.push_str(tail);
                return out;
            }
        };
        let tag = &tail[..tag_end];
        let after = &tail[tag_end..];
        let mut new_tag = tag.to_string();
        if let Some((s, e)) = attr_span(tag, "src") {
            let src = &tag[s..e];
            let remote = src.starts_with("http://")
                || src.starts_with("https://")
                || src.starts_with("data:")
                || src.starts_with("//");
            if !remote && !src.is_empty() {
                if let Some(data) = img_to_data_uri(base_dir, &percent_decode(src)) {
                    let mut buf = String::with_capacity(tag.len() + data.len());
                    buf.push_str(&tag[..s]);
                    buf.push_str(&data);
                    buf.push_str(&tag[e..]);
                    new_tag = buf;
                }
            }
        }
        out.push_str(&new_tag);
        rest = after;
    }
    out.push_str(rest);
    out
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

/// 屏蔽 F5 刷新 + 接管 Ctrl+F / Ctrl+H / Ctrl+R / Ctrl+P
///
/// **F5**：WebView2 里的"浏览器加速键"，默认行为是刷新整个页面 ——
/// 编辑区里没保存的内容直接没了（连"要不要保存"都不问）。
///
/// **Ctrl+F / Ctrl+H / Ctrl+R / Ctrl+P**：这些是**浏览器保留快捷键**，
/// Chromium 会在把按键交给渲染器之前就自己处理掉（Ctrl+H = 历史记录），
/// 所以前端的 keydown 压根收不到 → 必须在这一层拦。
///
/// ⚠️ SetHandled(true) 的副作用：**渲染器收不到这个按键**，
///    所以拦掉之后得自己 emit 一下，通知前端该做什么。
///
/// ⚠️ 修饰键状态用 `GetAsyncKeyState` 直接问系统 —— 不要自己跟踪按下/抬起：
///    keyup 万一没上报，状态就卡住 → 之后这个窗口的快捷键全被吞
///    （双开时特别明显：其中一个窗口的 Ctrl+F 死活不出现）。
#[cfg(target_os = "windows")]
fn install_reload_blocker(window: &tauri::WebviewWindow) {
    use webview2_com::AcceleratorKeyPressedEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2AcceleratorKeyPressedEventArgs;
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;

    const VK_CONTROL: i32 = 0x11;
    const VK_F: i32 = 0x46;
    const VK_H: i32 = 0x48;
    const VK_P: i32 = 0x50;
    const VK_R: i32 = 0x52;
    const VK_F5: u32 = 0x74;   // F5 的虚拟键码

    let win_emit = window.clone();

    let _ = window.with_webview(move |webview| {
        let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
            move |_sender: Option<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller>,
                  args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut vk: u32 = 0;
                unsafe { args.VirtualKey(&mut vk)?; }

                // F5：屏蔽刷新
                if vk == VK_F5 {
                    unsafe { args.SetHandled(true)?; }
                    return Ok(());
                }

                // Ctrl 按着吗？（GetAsyncKeyState 读的是全局状态，任何线程都准）
                let ctrl = unsafe { (GetAsyncKeyState(VK_CONTROL) as u16 & 0x8000) != 0 };
                if !ctrl {
                    return Ok(());
                }
                let key = vk as i32;
                if key != VK_F && key != VK_H && key != VK_R && key != VK_P {
                    return Ok(());
                }
                // 拦下浏览器保留键 → 渲染器收不到了，得自己通知前端
                unsafe { args.SetHandled(true)?; }
                if key == VK_F || key == VK_H {
                    // 查找 / 替换：payload = 是否带替换框
                    use tauri::Emitter;
                    let _ = win_emit.emit("vmd-find", key == VK_H);
                }
                // Ctrl+R（刷新）/ Ctrl+P（打印）就是单纯要拦掉，不用通知前端
                Ok(())
            },
        ));
        unsafe {
            let controller = webview.controller();
            let mut token: i64 = 0;
            if let Err(e) = controller.add_AcceleratorKeyPressed(&handler, &mut token) {
                eprintln!("[vmd] add_AcceleratorKeyPressed 失败：{e}");
            }
        }
    });
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

/// 真正关闭窗口（前端确认过"要不要保存"之后才调）
#[tauri::command]
fn close_window(window: tauri::WebviewWindow) {
    // 用 destroy() 而不是 close()：close() 会再发一次 CloseRequested，
    // 又被拦截住，窗口就永远关不掉了。
    eprintln!("[vmd] close_window → destroy");
    let _ = window.destroy();
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
    write_atomic(&path.to_string_lossy(), text.as_bytes()).map_err(|e| format!("保存设置失败：{e}"))
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

/// 给当前实例抢一个"槽位"（0 = 第一个实例，1 = 第二个，以此类推）
///
/// **为什么需要槽位**：WebView2 的用户数据目录（UDF）不能跨进程共用 ——
/// 共用时 WebView2 会把两个实例挂到**同一个 browser process** 上，
/// 后启动的那个实例收不到键盘输入（症状：进编辑模式打不了字）。
/// 所以每个实例必须用自己的 UDF，槽位就是用来区分的。
///
/// 用命名互斥体实现：进程退出（哪怕是崩溃）时系统自动关闭句柄 → 名字消失 →
/// 下次启动又能拿到 0 号槽，不会像"PID 命名目录"那样每次留一堆垃圾。
#[cfg(target_os = "windows")]
fn claim_instance_slot() -> u32 {
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;
    use windows::core::{HSTRING, PCWSTR};

    const MAX_SLOTS: u32 = 64;
    for i in 0..MAX_SLOTS {
        let name = HSTRING::from(format!("Local\\VMD.instance.{i}"));
        let handle = match unsafe { CreateMutexW(None, true, PCWSTR(name.as_ptr())) } {
            Ok(h) => h,
            Err(_) => continue,
        };
        if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
            // 这个槽位被别人占了 → 试下一个
            unsafe { let _ = CloseHandle(handle); };
            continue;
        }
        // 抢到了。句柄**故意不关**：进程活着它就在，进程死了系统会收走
        // （这样别的实例才知道这个槽位还占着）。
        return i;
    }
    0
}

/// 当前实例用的 WebView2 用户数据目录
///
/// 每个实例一个目录 —— 见 `claim_instance_slot()` 的说明。
/// 放在 `%LOCALAPPDATA%\vmd\<槽位>\\` 下面（而不是默认的
/// `%LOCALAPPDATA%\com.vmd.app\`），免得跟别的程序撞车，也跟 identifier 解耦。
///
/// ⚠️ 注意：Tauri 传下去的是**根目录**，Chromium 会在里面再自己建一层 `EBWebView`
/// —— 所以真正用到的 UDF 是 `%LOCALAPPDATA%\vmd\<槽位>\EBWebView`。
#[cfg(target_os = "windows")]
fn instance_data_directory(slot: u32) -> Option<std::path::PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    Some(std::path::PathBuf::from(base).join("vmd").join((slot + 1).to_string()))
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

    mod text_io {
        use super::super::*;

        #[test]
        fn decode_plain_utf8() {
            let (s, enc) = decode_text("中文 abc".as_bytes()).unwrap();
            assert_eq!(s, "中文 abc");
            assert_eq!(enc, "utf-8");
        }

        #[test]
        fn decode_utf8_with_bom_strips_it() {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice("你好".as_bytes());
            let (s, enc) = decode_text(&bytes).unwrap();
            assert_eq!(s, "你好");           // BOM 不能留在内容里
            assert_eq!(enc, "utf-8-bom");
        }

        #[test]
        fn decode_utf16_both_endians() {
            let text = "中文 😄";
            for (bom, le) in [([0xFFu8, 0xFE], true), ([0xFE, 0xFF], false)] {
                let mut bytes = bom.to_vec();
                for u in text.encode_utf16() {
                    let b = if le { u.to_le_bytes() } else { u.to_be_bytes() };
                    bytes.extend_from_slice(&b);
                }
                let (s, enc) = decode_text(&bytes).unwrap();
                assert_eq!(s, text);
                assert_eq!(enc, if le { "utf-16le" } else { "utf-16be" });
            }
        }

        /// 系统 ANSI 代码页（中文 Windows = GBK）往返
        #[cfg(target_os = "windows")]
        #[test]
        fn ansi_roundtrip() {
            let text = "中文测试，逗号。";
            let bytes = string_to_ansi(text).unwrap();
            let back = ansi_to_string(&bytes).unwrap();
            assert_eq!(back, text);
            // 无 BOM、非合法 UTF-8（除非系统 ACP 就是 UTF-8）
            if bytes != text.as_bytes() {
                assert!(std::str::from_utf8(&bytes).is_err());
                let (s, enc) = decode_text(&bytes).unwrap();
                assert_eq!(s, text);
                assert_eq!(enc, "ansi");
            }
        }

        #[test]
        fn encode_roundtrips_every_encoding() {
            let text = "# 标题\n正文 中文\n";
            for enc in ["utf-8", "utf-8-bom", "utf-16le", "utf-16be"] {
                let bytes = encode_text(text, enc).unwrap();
                let (back, got) = decode_text(&bytes).unwrap();
                assert_eq!(back, text, "{} 往返失败", enc);
                assert_eq!(got, enc);
            }
        }

        /// 原子写：目标文件已是旧内容，写新内容后旧内容必须完整消失、
        /// 且不能留下临时文件
        #[test]
        fn write_atomic_replaces_file() {
            let dir = std::env::temp_dir().join(format!("vmd-atomic-test-{}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            let path = dir.join("doc.md");
            let path_s = path.to_string_lossy().to_string();
            fs::write(&path, "旧内容，比新内容长很多很多很多很多很多").unwrap();
            write_atomic(&path_s, "新内容".as_bytes()).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), "新内容");
            // 目录里只应该有目标文件，临时文件已被改名或被清掉
            let left: Vec<String> = fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
                .collect();
            assert_eq!(left, vec!["doc.md".to_string()], "留下了临时文件：{:?}", left);
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

/// 最近一次“放行”的导航 URL
///
/// 用来识别“刷新”：刷新（F5 / Ctrl+R）也是一次导航，而且 URL 和当前页面一模一样。
/// 页内锚点跳转（#xxx）URL 不一样，不会被误伤。
static LAST_NAV_URL: Mutex<String> = Mutex::new(String::new());

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
    // 启动文件也用同一套编码探测 → GBK / UTF-16 文件首帧就能正确显示，
    // 不会"先闪一下欢迎页再跳到文件"（两跳）。
    let startup_text: Option<(String, String)> = startup_path
        .as_ref()
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| decode_text(&b).ok())
        .filter(|(content, _)| content.len() < 512 * 1024);   // 太大的文件前端再异步读
    let startup_json = serde_json::to_string(&serde_json::json!({
        "path": startup_path,
        "content": startup_text.as_ref().map(|(c, _)| c.clone()),
        "encoding": startup_text.as_ref().map(|(_, e)| e.clone()),
    }))
    .unwrap_or_else(|_| "null".to_string());
    // 注意：注入脚本在"文档刚创建"时执行，那时 document.documentElement 可能还是 null，
    // 所以这里只做纯赋值，不碰 DOM —— 模式由 src/theme.js 在 head 里同步设置。
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
                // 抢一个实例槽位 —— 每个实例必须用自己的 WebView2 UDF，
                // 共用会挂到同一个 browser process 上，后启动的那个就收不到键盘输入
                let slot = claim_instance_slot();
                // 自己创建主窗口（tauri.conf.json 里是 "create": false）：
                // 这样窗口底色和 WebView2 的 DefaultBackgroundColor 能在创建的那一刻
                // 就设成用户设置的主题色 —— 否则会先闪一下别的颜色再切过来。
                if let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == "main").cloned() {
                    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &cfg)?
                        .background_color(bg_color)
                        // 关掉 wry 自带的拖放处理：它注册在 WebView2 的子窗口上，
                        // 拿不到 CF_HDROP 时会显示"禁止"光标。我们自己接管（见 drop.rs）。
                        .disable_drag_drop_handler();
                    // 每个实例用自己的 WebView2 UDF —— 共用会挂到同一个 browser process 上，
                    // 后启动的那个实例就收不到键盘输入（进编辑模式打不了字）
                    if let Some(dir) = instance_data_directory(slot) {
                        builder = builder.data_directory(dir);
                    }
                    let win = builder
                        // 拦掉“刷新”：刷新 = 整个页面重新加载 = 编辑区里没保存的内容全丢，
                        // 而且不会问用户。判断方式：导航目标和当前页面完全同址 → 那就是刷新。
                        .on_navigation(|url| {
                            let mut last = LAST_NAV_URL.lock().unwrap();
                            let target = url.as_str().to_string();
                            if !last.is_empty() && *last == target {
                                eprintln!("[vmd] 已拦截刷新：{target}");
                                return false;
                            }
                            *last = target;
                            true
                        })
                        // 把设置和启动主题告诉前端：前端在首帧绘制前就用它们定配色（见 src/theme.js）
                        .initialization_script(format!(
                            "window.__VMD_SETTINGS__ = {}; window.__VMD_INIT_THEME__ = \"{}\"; window.__VMD_STARTUP__ = {};",
                            saved_json, sys_theme, startup_json
                        ))
                        .build()?;
                    // WebView2 首选配色方案：让 prefers-color-scheme 跟系统一致
                    let _ = apply_webview_color_scheme(&win, sys_theme);
                    // 屏蔽 F5 刷新（页面上没保存的内容不能因为一下 F5 就没了）
                    install_reload_blocker(&win);
                    // 自己接管文件拖放（wry 那套在非 shell 来源拖文件时会显示"禁止"光标）
                    crate::drop::install(app.handle(), &win);
                    // 拦截关闭：先问前端"要不要保存"，前端确认后调 close_window 真正关窗。
                    // 不拦的话点 X 直接退，编辑区的内容全丢。
                    {
                        use tauri::Emitter;
                        let win2 = win.clone();
                        win.on_window_event(move |event| {
                            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                                api.prevent_close();   // 先挡住，别真关
                                eprintln!("[vmd] CloseRequested → 通知前端询问是否保存");
                                let _ = win2.emit("vmd-close-requested", ());
                            }
                        });
                    }
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
            export_html,
            file_exists,
            export_pdf,
            system_theme,
            open_url,
            set_webview_color_scheme,
            set_window_background,
            set_window_title,
            close_window,
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