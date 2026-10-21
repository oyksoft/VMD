//! 自己实现 `IDropTarget`，接管文件拖放。
//!
//! 为什么不用 wry 自带的那套：
//!
//! wry 把 drop target 注册在 WebView2 的子窗口（`Chrome_WidgetWin_*`）上，
//! 而且它的 `DragEnter` 在拿不到 `CF_HDROP` 时会**直接返回、不设置 `pdwEffect`** ——
//! Windows 于是沿用默认效果，显示"禁止"光标，文件也永远收不到。
//! 从 VS Code / 浏览器这类不是 shell 的来源拖文件时没有 `CF_HDROP`，正好命中这个坑。
//!
//! 我们自己注册一个：
//!   - `CF_HDROP`（资源管理器等 shell 来源）
//!   - `text/uri-list`（VS Code、浏览器）
//!   - `FileNameW`（一些老程序）
//! 三种都拿不到路径时也**明确拒绝**（显示禁止光标），拿得到就一律显示"复制"光标，
//! 并把路径通过 `vmd-drop-files` 事件发给前端。

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;

use tauri::{AppHandle, Emitter, Runtime};
use windows::core::{implement, BOOL, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, POINTL};
use windows::Win32::System::Com::{IDataObject, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL};
use windows::Win32::System::DataExchange::RegisterClipboardFormatW;
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::{
    DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE, IDropTarget, IDropTarget_Impl, CF_HDROP,
    RegisterDragDrop, ReleaseStgMedium, RevokeDragDrop,
};
use windows::Win32::System::SystemServices::MODIFIERKEYS_FLAGS;
use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
use windows::Win32::UI::WindowsAndMessaging::EnumChildWindows;

/// 前端要监听的事件名
pub const DROP_EVENT: &str = "vmd-drop-files";
/// 拖进来时（用来显示"松开打开"提示）
pub const DRAG_ENTER_EVENT: &str = "vmd-drag-enter";
/// 拖走了
pub const DRAG_LEAVE_EVENT: &str = "vmd-drag-leave";

/// 拖放过程中的消息
enum DropMsg {
    Enter(Vec<String>),
    Leave,
    Drop(Vec<String>),
}

// 拖放目标对象。
//
// 必须留在**主线程**上：COM 对象有线程亲和性，而且 `as_raw()` 返回的是接口指针
// （对象首地址处的 vtable），把它当对象指针重新解释就是野指针（会崩）。
// 用 thread_local 保存，主线程的回调里直接取。
thread_local! {
    static DROP_TARGET: std::cell::RefCell<Option<IDropTarget>> =
        const { std::cell::RefCell::new(None) };
}

/// 在窗口（含 WebView2 的子窗口）上装上 drop target
pub fn install<R: Runtime>(app: &AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    let (tx, rx) = std::sync::mpsc::channel::<DropMsg>();

    // 单独一个线程负责把消息转成事件（COM 回调里直接 emit 也行，走通道更干净）
    let app_events = app.clone();
    std::thread::spawn(move || {
        while let Ok(msg) = rx.recv() {
            match msg {
                DropMsg::Enter(paths) => {
                    let _ = app_events.emit(DRAG_ENTER_EVENT, paths);
                }
                DropMsg::Leave => {
                    let _ = app_events.emit(DRAG_LEAVE_EVENT, ());
                }
                DropMsg::Drop(paths) => {
                    if paths.is_empty() {
                        continue;
                    }
                    eprintln!("[vmd] drop: {paths:?}");
                    let _ = app_events.emit(DROP_EVENT, paths);
                }
            }
        }
    });

    let Ok(hwnd) = window.hwnd() else {
        eprintln!("[vmd] 取不到窗口句柄，拖放功能不可用");
        return;
    };

    let target: IDropTarget = FileDropTarget {
        tx,
        valid: AtomicBool::new(false),
    }
    .into();
    // 永久保存在主线程上（clone 会 AddRef）
    DROP_TARGET.with(|t| {
        let _ = t.borrow_mut().replace(target.clone());
    });

    // 顶层窗口先注册上
    register_on(hwnd, &target);

    // WebView2 的子窗口（Chrome_WidgetWin_* / Chrome_RenderWidgetHostHWND）是**异步**创建的，
    // 建窗口那一刻往往还不存在 —— 漏掉它们的话，拖放会被 WebView2 自己的处理接走。
    // 所以定期扫一遍，给新出现的子窗口补注册。
    //
    // 注意：RegisterDragDrop / RevokeDragDrop **必须在创建窗口的那个线程上调用**，
    // 在别的线程调用会直接卡死 —— 所以要派回主线程做。
    let app2 = app.clone();
    let hwnd2 = hwnd.0 as isize;
    std::thread::spawn(move || {
        let mut registered: std::collections::HashSet<isize> = std::collections::HashSet::new();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(700));
            let children = child_windows(HWND(hwnd2 as *mut std::ffi::c_void));
            let fresh: Vec<isize> = children
                .iter()
                .map(|c| c.0 as isize)
                .filter(|h| registered.insert(*h))
                .collect();
            if fresh.is_empty() {
                continue;
            }
            let app3 = app2.clone();
            let _ = app3.run_on_main_thread(move || {
                DROP_TARGET.with(|t| {
                    let target = t.borrow();
                    if let Some(target) = target.as_ref() {
                        for h in fresh {
                            register_on(HWND(h as *mut std::ffi::c_void), target);
                        }
                    }
                });
            });
        }
    });
}

fn register_on(hwnd: HWND, target: &IDropTarget) {
    unsafe {
        // 先撤掉原有的（wry/WebView2 自己注册的）。
        // 注意：RevokeDragDrop 会对已注册的对象调 Release，所以要保证我们的对象还活着
        // （thread_local 里那份引用一直在），否则会 use-after-free 崩溃。
        let _ = RevokeDragDrop(hwnd);
        if let Err(e) = RegisterDragDrop(hwnd, target) {
            eprintln!("[vmd] RegisterDragDrop 失败: {e}");
        } else {
            eprintln!("[vmd] drop target 已注册到 hwnd={:?}", hwnd.0);
        }
    }
}

/// 列出窗口的所有子窗口
fn child_windows(hwnd: HWND) -> Vec<HWND> {
    unsafe extern "system" fn collect(child: HWND, lparam: LPARAM) -> BOOL {
        let v = &mut *(lparam.0 as *mut Vec<HWND>);
        v.push(child);
        BOOL(1)
    }
    let mut children: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(
            Some(hwnd),
            Some(collect),
            LPARAM(&mut children as *mut Vec<HWND> as isize),
        );
    }
    children
}

#[implement(IDropTarget)]
struct FileDropTarget {
    tx: Sender<DropMsg>,
    valid: AtomicBool,
}

#[allow(non_snake_case)]
impl IDropTarget_Impl for FileDropTarget_Impl {
    fn DragEnter(
        &self,
        pdataobj: windows::core::Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let paths = extract_paths(&pdataobj);
        let ok = !paths.is_empty();
        self.valid.store(ok, Ordering::Relaxed);
        unsafe {
            *pdweffect = if ok { DROPEFFECT_COPY } else { DROPEFFECT_NONE };
        }
        if ok {
            let _ = self.tx.send(DropMsg::Enter(paths));
        }
        Ok(())
    }

    fn DragOver(
        &self,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        unsafe {
            *pdweffect = if self.valid.load(Ordering::Relaxed) {
                DROPEFFECT_COPY
            } else {
                DROPEFFECT_NONE
            };
        }
        Ok(())
    }

    fn DragLeave(&self) -> windows::core::Result<()> {
        self.valid.store(false, Ordering::Relaxed);
        let _ = self.tx.send(DropMsg::Leave);
        Ok(())
    }

    fn Drop(
        &self,
        pdataobj: windows::core::Ref<'_, IDataObject>,
        _grfkeystate: MODIFIERKEYS_FLAGS,
        _pt: &POINTL,
        pdweffect: *mut DROPEFFECT,
    ) -> windows::core::Result<()> {
        let paths = extract_paths(&pdataobj);
        unsafe {
            *pdweffect = if paths.is_empty() {
                DROPEFFECT_NONE
            } else {
                DROPEFFECT_COPY
            };
        }
        if !paths.is_empty() {
            let _ = self.tx.send(DropMsg::Drop(paths));
        }
        self.valid.store(false, Ordering::Relaxed);
        Ok(())
    }
}

/// 从拖拽数据里提取文件路径（依次尝试几种格式）
fn extract_paths(data: &windows::core::Ref<'_, IDataObject>) -> Vec<String> {
    // 先把拖拽源提供的所有格式打印出来，排查用
    log_formats(data);

    // 1) CF_HDROP —— 资源管理器等 shell 来源
    let paths = unsafe { read_cf_hdrop(data) };
    if !paths.is_empty() {
        return paths;
    }
    // 2) text/uri-list —— VS Code、浏览器
    let paths = unsafe { read_text_format(data, "text/uri-list") };
    if !paths.is_empty() {
        return paths;
    }
    // 3) FileNameW / UniformTextLocator —— 一些老程序
    for name in ["FileNameW", "UniformTextLocator"] {
        let paths = unsafe { read_text_format(data, name) };
        if !paths.is_empty() {
            return paths;
        }
    }
    // 4) CF_TEXT —— 纯文本路径
    unsafe { read_cf_text(data) }
}

/// 读 CF_TEXT（ANSI 纯文本，里面可能是路径）
unsafe fn read_cf_text(data: &windows::core::Ref<'_, IDataObject>) -> Vec<String> {
    use windows::Win32::System::Ole::CF_TEXT;

    let fmt = FORMATETC {
        cfFormat: CF_TEXT.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let medium = match data.as_ref() {
        Some(d) => d.GetData(&fmt),
        None => return Vec::new(),
    };
    let mut medium = match medium {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };
    let hglobal = medium.u.hGlobal;
    let text = if hglobal.0.is_null() {
        String::new()
    } else {
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            String::new()
        } else {
            let bytes = std::slice::from_raw_parts(ptr as *const u8, 1 << 16);
            let end = bytes.iter().position(|&b| b == 0).unwrap_or(0);
            let s = String::from_utf8_lossy(&bytes[..end]).to_string();
            let _ = GlobalUnlock(hglobal);
            s
        }
    };
    let _ = ReleaseStgMedium(&mut medium);
    parse_paths_from_text(&text)
}

/// 把拖拽源提供的格式都列出来（写到 stderr，方便排查"为什么拖不进来"）
fn log_formats(data: &windows::core::Ref<'_, IDataObject>) {
    use windows::Win32::System::DataExchange::GetClipboardFormatNameW;

    let Some(d) = data.as_ref() else { return };
    // DATADIR_GET = 1
    let Ok(enum_etc) = (unsafe { d.EnumFormatEtc(1) }) else {
        eprintln!("[vmd] EnumFormatEtc 失败");
        return;
    };
    let mut list: Vec<String> = Vec::new();
    unsafe {
        for _ in 0..32 {
            let fmt = FORMATETC::default();
            let mut fetched = 0u32;
            if enum_etc.Next(&mut [fmt], Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let mut name_buf = [0u16; 128];
            let len = GetClipboardFormatNameW(fmt.cfFormat as u32, &mut name_buf);
            let name = if len > 0 {
                String::from_utf16_lossy(&name_buf[..len as usize])
            } else {
                String::new()
            };
            list.push(format!("{}({})", fmt.cfFormat, name));
        }
    }
    eprintln!("[vmd] drag formats: {list:?}");
}

/// 读 CF_HDROP（真正的 shell 文件拖放）
unsafe fn read_cf_hdrop(data: &windows::core::Ref<'_, IDataObject>) -> Vec<String> {
    let fmt = FORMATETC {
        cfFormat: CF_HDROP.0,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let medium = match data.as_ref() {
        Some(d) => d.GetData(&fmt),
        None => return Vec::new(),
    };
    let mut medium = match medium {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[vmd] 拖入的数据里没有 CF_HDROP: {e}");
            return Vec::new();
        }
    };

    let hdrop = HDROP(medium.u.hGlobal.0 as _);
    let count = DragQueryFileW(hdrop, u32::MAX, None);
    let mut out = Vec::new();
    for i in 0..count {
        let len = DragQueryFileW(hdrop, i, None) as usize;
        let mut buf = vec![0u16; len + 1];
        DragQueryFileW(hdrop, i, Some(&mut buf));
        let s = String::from_utf16_lossy(&buf[..len]);
        if !s.is_empty() {
            out.push(s);
        }
    }
    let _ = ReleaseStgMedium(&mut medium);
    out
}

/// 读一个"注册过的"文本格式（如 text/uri-list、FileNameW）
unsafe fn read_text_format(data: &windows::core::Ref<'_, IDataObject>, name: &str) -> Vec<String> {
    let wide = name.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let cf = RegisterClipboardFormatW(PCWSTR(wide.as_ptr()));
    if cf == 0 {
        return Vec::new();
    }
    let fmt = FORMATETC {
        cfFormat: cf as u16,
        ptd: std::ptr::null_mut(),
        dwAspect: DVASPECT_CONTENT.0,
        lindex: -1,
        tymed: TYMED_HGLOBAL.0 as u32,
    };
    let medium = match data.as_ref() {
        Some(d) => d.GetData(&fmt),
        None => return Vec::new(),
    };
    let mut medium = match medium {
        Ok(m) => m,
        Err(_) => return Vec::new(),
    };

    let hglobal = medium.u.hGlobal;
    let text = if hglobal.0.is_null() {
        String::new()
    } else {
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() {
            String::new()
        } else {
            // 这些格式可能是 UTF-16（FileNameW）也可能是 UTF-8（text/uri-list），两种都试
            let bytes = std::slice::from_raw_parts(ptr as *const u8, 1 << 16);
            let end = bytes.iter().position(|&b| b == 0).unwrap_or(0);
            let raw = &bytes[..end];
            let s8 = String::from_utf8_lossy(raw).to_string();
            let s16 = String::from_utf16_lossy(std::slice::from_raw_parts(ptr as *const u16, end / 2 + 1));
            let _ = GlobalUnlock(hglobal);
            if s8.contains("://") || s8.contains('\\') {
                s8
            } else {
                s16
            }
        }
    };
    let _ = ReleaseStgMedium(&mut medium);

    parse_paths_from_text(&text)
}

/// 从文本里解析出文件路径（支持 file:// URI 和普通路径）
fn parse_paths_from_text(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with("file://") {
            if let Ok(url) = tauri::Url::parse(line) {
                if let Ok(path) = url.to_file_path() {
                    out.push(path.to_string_lossy().to_string());
                    continue;
                }
            }
            // 解析不了就手工去掉前缀
            let p = line.trim_start_matches("file://").trim_start_matches('/');
            if !p.is_empty() {
                out.push(format!("C:{}", p.replace('/', "\\")));
            }
        } else if line.contains('\\') || line.contains('/') {
            out.push(line.to_string());
        }
    }
    out
}
