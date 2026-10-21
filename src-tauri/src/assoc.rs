//! Windows 文件关联 + 系统右键菜单项
//!
//! 两件独立的事：
//!   1. **文件关联**：把 `.md` / `.markdown` 的默认打开方式设成 VMD（双击生效）
//!   2. **系统右键菜单**：往 `.md` / `.markdown` 的右键菜单里加一个「用 VMD 打开」项
//!      （不影响双击的默认打开方式）
//!
//! 全部写在 **HKCU\Software\Classes**（当前用户），所以：
//!   - 不需要管理员权限
//!   - 不影响别的用户
//!   - 卸载时删掉这几个键就干净了
//!
//! 注意：Windows 10/11 有 "UserChoice" 机制 —— 如果用户以前在"打开方式"里
//! 选过别的程序，那个记录优先级更高，得去「右键 → 打开方式 → 选 VMD → 勾选始终」
//! 才能真正改过来。所以 UI 上要把这点提示清楚。

#![cfg(target_os = "windows")]

use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegDeleteValueW, RegGetValueW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
};
use windows::Win32::UI::Shell::{SHChangeNotify, SHCNE_ASSOCCHANGED, SHCNF_IDLIST};

/// 关联用的 ProgID
const PROGID: &str = "VMD.Markdown";
/// 关联的扩展名
const EXTS: [&str; 2] = [".md", ".markdown"];
/// 右键菜单项的动词名（注册表里的 key 名）
const MENU_VERB: &str = "VMDOpen";
/// 右键菜单项显示的文字
const MENU_VERB_TEXT: &str = "用 VMD 打开";
/// 注册表根：HKCU\Software\Classes
const CLASSES: &str = r"Software\Classes";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 写一个字符串值（value_name 为 None 表示写默认值）
unsafe fn set_str(
    hkey: HKEY,
    subkey: &str,
    value_name: Option<&str>,
    data: &str,
) -> Result<(), String> {
    let sub = wide(subkey);
    let mut h = HKEY::default();
    let st = RegCreateKeyExW(
        hkey,
        PCWSTR(sub.as_ptr()),
        None,
        PCWSTR::null(),
        REG_OPTION_NON_VOLATILE,
        KEY_WRITE,
        None,
        &mut h,
        None,
    );
    if st != ERROR_SUCCESS {
        return Err(format!("创建注册表项 {subkey} 失败（错误码 {}）", st.0));
    }
    let name = value_name.map(wide);
    let name_ptr = match &name {
        Some(n) => PCWSTR(n.as_ptr()),
        None => PCWSTR::null(),
    };
    // REG_SZ 的数据必须以 \0 结尾
    let mut bytes: Vec<u8> = data.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    bytes.extend_from_slice(&[0, 0]);
    let st = RegSetValueExW(h, name_ptr, None, REG_SZ, Some(&bytes));
    let _ = RegCloseKey(h);
    if st != ERROR_SUCCESS {
        return Err(format!("写注册表值 {subkey} 失败（错误码 {}）", st.0));
    }
    Ok(())
}

/// 删一个键（键不存在不算错）
unsafe fn delete_key(subkey: &str) {
    let sub = wide(subkey);
    let _ = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(sub.as_ptr()));
}

/// 删某个键的默认值（不动它的子键）
unsafe fn delete_default_value(subkey: &str) {
    let sub = wide(subkey);
    let mut h = HKEY::default();
    let st = RegCreateKeyExW(
        HKEY_CURRENT_USER,
        PCWSTR(sub.as_ptr()),
        None,
        PCWSTR::null(),
        REG_OPTION_NON_VOLATILE,
        KEY_WRITE,
        None,
        &mut h,
        None,
    );
    if st == ERROR_SUCCESS {
        let _ = RegDeleteValueW(h, PCWSTR::null());
        let _ = RegCloseKey(h);
    }
}

/// 读 HKCU\Software\Classes\<sub> 的默认值
unsafe fn get_default(subkey: &str) -> Option<String> {
    let sub = wide(subkey);
    let mut buf = [0u16; 260];
    let mut size = (buf.len() * 2) as u32;
    let st = RegGetValueW(
        HKEY_CURRENT_USER,
        PCWSTR(sub.as_ptr()),
        PCWSTR::null(),
        RRF_RT_REG_SZ,
        None,
        Some(&mut buf as *mut _ as _),
        Some(&mut size),
    );
    if st != ERROR_SUCCESS {
        return None;
    }
    let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
    Some(String::from_utf16_lossy(&buf[..n]))
}

/// 当前 exe 路径
fn exe_path() -> Result<String, String> {
    std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| format!("取不到程序路径：{e}"))
}

/// 通知资源管理器"关联变了"，让"打开方式"列表立刻刷新
fn notify_shell() {
    unsafe {
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
}

/// 注册文件关联
pub fn register() -> Result<String, String> {
    let exe = exe_path()?;
    unsafe {
        for ext in EXTS {
            // .md → VMD.Markdown
            set_str(
                HKEY_CURRENT_USER,
                &format!("{}\\{}", CLASSES, ext),
                None,
                PROGID,
            )?;
        }
        // 程序的 ProgID：名字 + 图标 + 打开命令
        // （"打开方式"列表里那个 VMD 条目由 register_menu 单独管，两边互不干扰）
        set_str(
            HKEY_CURRENT_USER,
            &format!("{}\\{}", CLASSES, PROGID),
            None,
            "Markdown 文档",
        )?;
        set_str(
            HKEY_CURRENT_USER,
            &format!("{}\\{}\\DefaultIcon", CLASSES, PROGID),
            None,
            &format!("\"{}\",0", exe),
        )?;
        set_str(
            HKEY_CURRENT_USER,
            &format!("{}\\{}\\shell\\open\\command", CLASSES, PROGID),
            None,
            &format!("\"{}\" \"%1\"", exe),
        )?;
    }
    notify_shell();
    Ok(exe)
}

/// 取消文件关联
///
/// 只删"默认打开方式"和 VMD 自己的 ProgID —— **不碰 `Applications\VMD.exe`**
/// （那是"打开方式"列表，独立开关）。
pub fn unregister() -> Result<(), String> {
    unsafe {
        for ext in EXTS {
            // 只有默认值确实指向我们时才删，避免误删别人的设置
            if get_default(&format!("{}\\{}", CLASSES, ext)).as_deref() == Some(PROGID) {
                delete_default_value(&format!("{}\\{}", CLASSES, ext));
            }
        }
        // 从深到浅删
        for key in [
            format!("{}\\{}\\shell\\open\\command", CLASSES, PROGID),
            format!("{}\\{}\\shell\\open", CLASSES, PROGID),
            format!("{}\\{}\\shell", CLASSES, PROGID),
            format!("{}\\{}\\DefaultIcon", CLASSES, PROGID),
            format!("{}\\{}", CLASSES, PROGID),
            format!("{}\\Applications\\VMD.exe\\shell\\open\\command", CLASSES),
            format!("{}\\Applications\\VMD.exe\\shell\\open", CLASSES),
            format!("{}\\Applications\\VMD.exe\\shell", CLASSES),
            format!("{}\\Applications\\VMD.exe\\DefaultIcon", CLASSES),
            format!("{}\\Applications\\VMD.exe\\SupportedTypes", CLASSES),
            format!("{}\\Applications\\VMD.exe", CLASSES),
        ] {
            delete_key(&key);
        }
    }
    notify_shell();
    Ok(())
}

/// 往文件右键菜单里加「用 VMD 打开」（自定义动词）
///
/// 写成 `shell\VMDOpen`（而不是改「打开方式」列表）—— 要的就是菜单里那一项。
/// `NeverDefault` 保证它不会被当成默认操作（否则没有默认关联时，双击就跑它）。
pub fn register_menu() -> Result<(), String> {
    let exe = exe_path()?;
    unsafe {
        for ext in EXTS {
            // .md\shell\VMDOpen → 菜单项显示的文字
            set_str(
                HKEY_CURRENT_USER,
                &format!("{}\\{}\\shell\\{}", CLASSES, ext, MENU_VERB),
                None,
                MENU_VERB_TEXT,
            )?;
            // NeverDefault：这个动词不作为该文件类型的默认操作
            set_str(
                HKEY_CURRENT_USER,
                &format!("{}\\{}\\shell\\{}\\NeverDefault", CLASSES, ext, MENU_VERB),
                None,
                "",
            )?;
            // Extended：让它排到菜单靠后那一组（不跟"剪切/复制/删除"挤一起）
            set_str(
                HKEY_CURRENT_USER,
                &format!("{}\\{}\\shell\\{}\\Extended", CLASSES, ext, MENU_VERB),
                None,
                "",
            )?;
            // .md\shell\VMDOpen\command → 点了之后执行什么
            set_str(
                HKEY_CURRENT_USER,
                &format!("{}\\{}\\shell\\{}\\command", CLASSES, ext, MENU_VERB),
                None,
                &format!("\"{}\" \"%1\"", exe),
            )?;
        }
    }
    notify_shell();
    Ok(())
}

/// 移除文件右键菜单里的「用 VMD 打开」
pub fn unregister_menu() -> Result<(), String> {
    unsafe {
        for ext in EXTS {
            for sub in ["NeverDefault", "Extended", "command"] {
                delete_key(&format!(
                    "{}\\{}\\shell\\{}\\{}",
                    CLASSES, ext, MENU_VERB, sub
                ));
            }
            delete_key(&format!("{}\\{}\\shell\\{}", CLASSES, ext, MENU_VERB));
        }
    }
    notify_shell();
    Ok(())
}

/// 文件右键菜单里有没有「用 VMD 打开」
pub fn menu_status() -> bool {
    unsafe {
        for ext in EXTS {
            let key = format!("{}\\{}\\shell\\{}\\command", CLASSES, ext, MENU_VERB);
            if get_default(&key).is_some() {
                return true;
            }
        }
        false
    }
}

/// 当前状态：是否已关联、关联到哪个 exe
pub fn status() -> (bool, String) {
    unsafe {
        let linked = get_default(&format!("{}\\.md", CLASSES)).as_deref() == Some(PROGID);
        let exe = exe_path().unwrap_or_default();
        (linked, exe)
    }
}
