// VMD - 前端
// - 用 marked.js 把 markdown → HTML
// - 用 highlight.js 高亮代码块
// - emoji 用系统字体渲染（Segoe UI Emoji / Apple Color Emoji）
// - Tauri 后端只做文件 I/O

// Tauri API（带兜底，方便在普通浏览器里调试前端）
const T = window.__TAURI__ || {};
const invoke = (T.core && T.core.invoke) ? T.core.invoke : async () => { throw new Error('Tauri not available'); };
const { open, save } = T.dialog || { open: async () => null, save: async () => null };

// ============ 主题 ============

// 调色板在 src/theme.js 里（要在首帧前应用，所以放在 <head> 里加载）
const THEMES = window.VMD_THEMES;

// 主题循环顺序
const THEME_ORDER = ['auto', 'dark', 'gray', 'light', 'sepia', 'bamboo', 'mist', 'dusk'];

let currentTheme = 'auto';   // 用户选的（可能是 auto）
let activeTheme = 'dark';    // 实际生效的（auto 时是系统决定的）
let currentAppTheme = 'dark'; // 供 Mermaid 选择配色用
let systemTheme = 'dark';    // 系统当前是亮还是暗（"自动"主题的悬停预览要用）

/** 读系统当前是亮还是暗（读不到就退回 matchMedia） */
async function fetchSystemTheme() {
    let sys;
    try {
        sys = await invoke('system_theme');
    } catch (e) {
        sys = systemPrefersDark() ? 'dark' : 'light';
    }
    systemTheme = sys;
    return sys;
}

/** 读系统当前是亮还是暗 */
function systemPrefersDark() {
    return !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
}

/** 把某个具体主题的 CSS 变量和 hljs 样式应用上去（瞬间换，不做渐变过渡） */
function applyConcreteTheme(key) {
    const t = THEMES[key];
    const root = document.documentElement;
    // 标记当前主题，CSS 里可以用 :root[data-theme="..."] 做主题专属样式
    root.dataset.theme = key;
    for (const [k, v] of Object.entries(t.vars)) {
        root.style.setProperty(k, v);
    }
    // 画布/滚动条跟着主题走（浅色主题下浏览器默认画布是黑的）
    root.style.colorScheme = (key === 'light') ? 'light' : 'dark';
    // 切换 highlight.js 配色
    document.querySelectorAll('link[data-hljs]').forEach(l => l.remove());
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = t.css;
    link.dataset.hljs = '1';
    document.head.appendChild(link);
    // Mermaid 图的线条/文字颜色在渲染时就固化了 —— 换主题必须重渲染
    currentAppTheme = key;
    rerenderMermaid();
}

/** 用户选主题（可能是 auto） */
async function applyTheme(key) {
    currentTheme = key;
    if (key === 'auto') {
        // Tauri 2 在窗口主题为 Auto 时会把 WebView2 强制设成 Light，
        // 所以 matchMedia 读不到真实系统主题 —— 改从 Rust 读注册表。
        activeTheme = await fetchSystemTheme();
    } else {
        activeTheme = key;
    }
    // 同步 WebView2 的配色方案，让 prefers-color-scheme 与实际显示一致
    // （gray 是暗色系，WebView2 侧用 dark）
    const webviewScheme = (key === 'auto')
        ? activeTheme
        : (key === 'gray' ? 'dark' : key);
    try {
        await invoke('set_webview_color_scheme', { scheme: webviewScheme });
    } catch (e) { /* 忽略：不影响配色变量 */ }
    // 同步窗口 + WebView2 背景色，避免切换主题的瞬间露出旧底色
    try {
        await invoke('set_window_background', { theme: activeTheme });
    } catch (e) { /* 忽略 */ }
    applyConcreteTheme(activeTheme);
    renderPreview();
    updateThemeButton();
}
// ---- 悬停预览主题（设置面板的色块 + 工具栏的主题菜单共用） ----
// 鼠标停在某个主题上 → 整个窗体渲染成那个主题；移开 → 恢复当前生效的主题。
// 只改"当前显示"：不写设置文件、不动 currentTheme / activeTheme。
// 延迟一点再切：鼠标扫过一排色块时不会一路闪过去。
// 切换本身是瞬间的 —— 试过"淡出→换→淡入"和"颜色渐变"，用户都觉得难受，不要再加过渡。
const PREVIEW_DELAY = 140;
let previewTimer = null;
let previewing = false;

function schedulePreview(key) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
        previewTimer = null;
        applyPreview(key);
    }, PREVIEW_DELAY);
}

/** 离开预览区：恢复当前生效的主题 */
function endPreview() {
    // 取消还没触发的预览（鼠标只是扫过）
    if (previewTimer) {
        clearTimeout(previewTimer);
        previewTimer = null;
    }
    // 注意：即使还有/刚取消定时器，也可能早就预览过了（比如扫过上一个色块）——
    // 这里必须照样恢复，不能因为"有定时器"就早退，否则颜色会卡在某个主题上。
    if (!previewing) return;
    previewing = false;
    applyConcreteTheme(activeTheme);
}

function applyPreview(key) {
    if (key === 'auto') key = systemTheme;   // "自动" = 系统当前主题
    const t = THEMES[key];
    if (!t || !t.vars) return;
    if (!previewing && key === activeTheme) return;   // 已经是这个主题了
    previewing = true;
    applyConcreteTheme(key);
}

// 跟随系统时，系统主题变化要实时响应
// 监听 Tauri 的 tauri://theme-changed（窗口主题保持 Auto，tao 仍能感知系统变化）
if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('tauri://theme-changed', () => {
        if (currentTheme === 'auto') applyTheme('auto');
    });
}

// ============ 拖放打开文件 ============

// 能打开的文件类型（和"打开"对话框的 filters 保持一致）
const OPENABLE_EXT = ['md', 'markdown', 'txt'];

function extOf(path) {
    const m = String(path).match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : '';
}

/** 拖进来的文件：只打开符合类型的第一个 */
async function openDroppedFiles(paths) {
    const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
    const ok = list.filter(p => OPENABLE_EXT.includes(extOf(p)));
    if (!ok.length) {
        const names = list.map(p => p.replace(/^.*[\\\/]/, '')).join('、');
        showError('打不开这个文件', '只能打开 .md / .markdown / .txt 文件' + (names ? '。\n' + names : ''));
        return;
    }
    if (ok.length > 1) {
        showToast('一次只能打开一个文件，已打开「' + ok[0].replace(/^.*[\\\/]/, '') + '」', 3000);
    }
    // 拖放打开也要过「未保存修改」这一关 —— 以前只有 Ctrl+O 检查，
    // 拖一个文件进来会把正在写的内容静默覆盖掉
    if (!(await confirmDiscardCurrent())) return;
    try {
        await openPath(ok[0]);
    } catch (e) {
        showError('打不开这个文件', e);
    }
}

// Tauri 在 Win32 层面接管了拖放（所以网页里的 HTML5 drop 不会触发），
// 路径由 Rust 端的 drop target 通过 vmd-drop-files 事件送来
if (window.__TAURI__ && window.__TAURI__.event) {
    // 拖进来的是能打开的类型时才给提示
    window.__TAURI__.event.listen('vmd-drag-enter', (e) => {
        const paths = (e && e.payload && e.payload.paths) || [];
        if (paths.some(p => OPENABLE_EXT.includes(extOf(p)))) {
            document.body.classList.add('drag-over');
        }
    });
    window.__TAURI__.event.listen('vmd-drag-leave', () => {
        document.body.classList.remove('drag-over');
    });
    window.__TAURI__.event.listen('vmd-drop-files', (e) => {
        document.body.classList.remove('drag-over');
        const paths = (e && e.payload) || [];
        openDroppedFiles(paths);
    });
}

// 兜底：万一 WebView2 自己也派发了 HTML5 的 drag/drop 事件，
// 阻止浏览器默认行为（否则拖进来的文件会被当成网页打开，把当前文档顶掉）
document.addEventListener('dragover', (e) => { e.preventDefault(); });
document.addEventListener('drop', (e) => { e.preventDefault(); });

// ============ 关闭窗口前询问是否保存 ============
// Rust 端拦截了窗口关闭（CloseRequested → prevent_close），
// 把事件发过来；有未保存的修改就问用户要不要保存。
if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('vmd-close-requested', () => { askBeforeClose(); });
}

// 正在询问中（避免连点 X 弹多个框）
let closeAskOpen = false;

/**
 * 有未保存的修改时问用户怎么办。
 * 返回 'save'（保存）/ 'discard'（丢弃）/ 'cancel'（取消，什么都不做）
 * 按钮排布跟 Windows 一致：不保存在左，保存在右边（主按钮）。
 * Esc / 点遮罩 = 取消（不会误丢数据）。
 */
async function askSaveChanges() {
    const name = currentFile ? currentFile.replace(/^.*[\\\/]/, '') : '未保存的内容';
    const body = document.createElement('div');
    // 文件名加重：一眼看出是在说哪个文件
    const file = document.createElement('span');
    file.className = 'modal-file';
    file.textContent = '「' + name + '」';
    body.appendChild(file);
    const rest = document.createElement('span');
    rest.textContent = '有未保存的修改。';
    body.appendChild(rest);
    const choice = await showDialog({
        title: '要保存修改吗？',
        icon: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
        body: body,
        okText: '保存',
        cancelText: '取消',
        alwaysText: '不保存',
        alwaysDanger: true,
    });
    if (choice === true) return 'save';
    if (choice === 'always') return 'discard';
    return 'cancel';
}

async function askBeforeClose() {
    if (closeAskOpen) return;
    closeAskOpen = true;
    try {
        if (!dirty) { await doClose(); return; }
        const r = await askSaveChanges();
        if (r === 'save') {
            // 保存成功才关；保存失败（用户取消了"另存为"）就留在窗口里
            if (await saveFile()) await doClose();
        } else if (r === 'discard') {
            await doClose();   // 不保存，直接关
        }
        // 'cancel' → 什么都不做，窗口留着
    } finally {
        closeAskOpen = false;
    }
}

/** 真正关窗（Rust 端用 destroy，绕开拦截） */
async function doClose() {
    // 窗口真要关了 → 草稿没意义了（用户已经选过保存/丢弃）
    await dropDraft();
    try {
        await invoke('close_window');
    } catch (e) {
        console.warn('close failed:', e);
    }
}

// ============ 配置 ============

// 配置 marked
marked.setOptions({
    gfm: true,
    breaks: false,
    headerIds: false,
    mangle: false,
});

// 不动 marked v13 的 renderer（避免偶发破坏粗体/斜体）
// 改为渲染后 post-process 高亮（详见 highlightCodeBlocks）

// 渲染后高亮代码块
function highlightCodeBlocks(root = preview) {
    if (!window.hljs) return;
    const pres = sel(root, 'pre');
    pres.forEach(pre => {
        if (pre.dataset.codeBlockDone) return;   // 避免重复处理
        const code = pre.querySelector('code');
        if (!code) return;
        const cls = code.className || '';
        const lang = (cls.match(/language-([\w+#.-]+)/) || [])[1] || '';
        // 跳过 KaTeX / Mermaid 专用代码块——它们有各自的渲染器
        if (/^(latex|math|tex|katex|mermaid|seq|flow|sequence|diagram)$/i.test(lang)) {
            pre.dataset.codeBlockDone = '1';
            return;
        }
        const text = code.textContent;
        let result = null;
        try {
            result = (lang && hljs.getLanguage(lang))
                ? hljs.highlight(text, { language: lang })
                : hljs.highlightAuto(text);
        } catch (e) { /* 高亮失败就保持原样 */ }
        if (result) {
            code.innerHTML = result.value;
            code.className = 'hljs' + (result.language ? ' language-' + result.language : '');
        }
        // 套一层：右上角显示语言名 + 复制按钮
        wrapCodeBlock(pre, lang);
        pre.dataset.codeBlockDone = '1';
    });
}

// 复制按钮图标（内联 SVG，避免 emoji 风格不统一）
const ICON_COPY = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

// 表格外套一个可横向滚动的容器（table 本身保持 table 布局，border-collapse 才生效）
function wrapTables(root = preview) {
    const tables = sel(root, 'table');
    tables.forEach(table => {
        if (table.parentNode && table.parentNode.classList.contains('table-wrap')) return;
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        table.parentNode.insertBefore(wrap, table);
        wrap.appendChild(table);
    });
}

// 给代码块加"头部"：语言标签 + 复制按钮
function wrapCodeBlock(pre, lang) {
    const parent = pre.parentNode;
    if (!parent || parent.classList.contains('code-block')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    // 语言名（源码里没指定就不显示）
    if (lang) {
        const label = document.createElement('span');
        label.className = 'code-lang';
        label.textContent = lang;
        header.appendChild(label);
    }

    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.type = 'button';
    btn.title = '复制代码';
    btn.setAttribute('aria-label', '复制代码');
    btn.innerHTML = ICON_COPY;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const codeEl = pre.querySelector('code');
        const text = codeEl ? codeEl.textContent : '';
        copyToClipboard(text).then(ok => {
            btn.innerHTML = ok ? ICON_CHECK : ICON_COPY;
            btn.classList.toggle('copied', ok);
            btn.classList.toggle('failed', !ok);
            btn.title = ok ? '已复制' : '复制失败';
            setTimeout(() => {
                btn.innerHTML = ICON_COPY;
                btn.classList.remove('copied', 'failed');
                btn.title = '复制代码';
            }, 1600);
        });
    });
    header.appendChild(btn);

    parent.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
}

// 复制到剪贴板（优先用 Clipboard API，失败则退回 execCommand）
function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text)
            .then(() => true)
            .catch(() => legacyCopy(text));
    }
    return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return !!ok;
    } catch (e) {
        return false;
    }
}

// ============ DOM ============

const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const tocList = document.getElementById('toc-list');
// 目录项点击走事件委托（目录可能有上万个节点，逐个 addEventListener 太贵）
tocList.addEventListener('click', onTocItemClick);
const filenameEl = document.getElementById('filename');
const toolbarEl = document.getElementById('toolbar');
const toastEl = document.getElementById('toast');

// ============ 浮动提示条 ============
// 临时消息（已保存 / 已导出 / 自动重载已关闭…）浮在窗口上方居中，不占工具栏的位置。
let toastTimer = null;

/** 显示一条提示；ms <= 0 表示常驻，等下一条提示替换 */
function showToast(msg, ms = 2000) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    if (ms > 0) toastTimer = setTimeout(hideToast, ms);
}

function hideToast() {
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    toastEl.classList.remove('show');
}

// 预览中的链接点击 → 外部调系统浏览器打开，避免 WebView 被跳走
preview.addEventListener('click', async (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (!href) return;
    if (href.startsWith('#')) return;   // 锚点不处理（marked 会渲染成普通链接）
    // ⚠️ 只把 **网址** 交给系统打开 ——
    //    open_url 底层是 ShellExecuteW("open")，会用系统默认程序「打开」任何东西
    //    （.exe 直接就执行了）。md 可能来自别人，里面的链接不可信。
    if (!/^(?:https?|mailto|tel):/i.test(href)) {
        showToast('这不是网址，没有自动打开（需要的话请复制到浏览器里）', 3200);
        return;
    }
    try {
        await invoke('open_url', { url: href });
    } catch (err) {
        console.warn('open url failed:', err);
    }
});

// 启动文件：用文件关联双击打开时，Rust 端会把路径（和内容）注入进来。
// 内容直接用注入的 → 首帧就是文件，不会先闪欢迎页再跳到文件。
const STARTUP = window.__VMD_STARTUP__ || {};

let currentFile = STARTUP.path || null;
// 当前文件的编码（utf-8 / utf-8-bom / utf-16le / utf-16be / ansi）——
// 保存时按原编码写回，不悄悄把 GBK 转成 UTF-8。见 main.rs 的 decode_text()。
let currentEncoding = STARTUP.encoding || 'utf-8';
let dirty = false;

const WELCOME = `# 欢迎使用 VMD 👋

一个用 Tauri + 系统 WebView 写的 **Markdown 编辑器**：左边写，右边实时看。

## 主要特性

- ✨ 实时预览，所见即所得
- 💾 保存 / 另存为，还能导出 PDF、HTML
- 🖱️ 左侧目录，点击跳转
- 📥 把 .md 文件拖进窗口直接打开
- ⌨️ 快捷键：Ctrl+N 新建 · Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+Shift+S 另存为

## Emoji 短代码

输入 \`:smile:\` 这样的短代码，会自动变成表情：:smile: :rocket: :+1: :tada:

## 代码高亮

\`\`\`rust
fn main() {
    println!("Hello, VMD!");
}
\`\`\`

## 数学公式

行内公式：$E = mc^2$

块级公式（KaTeX）：

$$
\\frac{\\partial u}{\\partial t} = h^2 \\nabla^2 u
$$

## 表格

| 名称 | 描述 |
|------|------|
| Rust | 🦀 系统编程 |
| VMD  | Markdown 编辑器 |

## 流程图

\`\`\`mermaid
flowchart TD
    A[写 Markdown] --> B{文件类型?}
    B -->|md| C[渲染预览]
    B -->|txt| C
    C --> D{满意?}
    D -->|改| A
    D -->|导出| E[导出 PDF]
\`\`\`
`;

// 启动文件的内容（Rust 注入）；没有就用欢迎页
editor.value = (STARTUP.content != null) ? STARTUP.content : WELCOME;

// ============ 渲染 ============

let renderTimer = null;
// 打字 → 预览的防抖延迟按文档大小分级。
// 长文档每次渲染要几百毫秒，固定 100ms 会让连续输入时渲染背靠背地跑，打字明显发滞。
const RENDER_DELAY_SHORT = 100;    // < 5 万字符
const RENDER_DELAY_MID = 200;      // < 20 万字符
const RENDER_DELAY_LONG = 450;     // >= 20 万字符（约 300KB 以上）
function renderDelayFor(text) {
    const n = text.length;
    if (n >= 200000) return RENDER_DELAY_LONG;
    if (n >= 50000) return RENDER_DELAY_MID;
    return RENDER_DELAY_SHORT;
}
/**
 * 调度一次预览渲染（防抖）。
 * 多次调用只会保留最后一次 —— 输入法组字时会连续触发几十次 input，
 * 每次都排一个定时器会让预览一直渲染不出来。
 */
function schedulePreviewRender() {
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderTimer = null; renderPreview(); },
        renderDelayFor(editor.value));
}

editor.addEventListener('input', (e) => {
    dirty = true;
    // ⚠️ **输入法组字期间要什么都不做**（中文/日文输入法最明显）。
    //
    // 组字时（compositionstart → compositionend）每个拼音键都会触发一次 input，
    // 而且：
    //   1. 预编辑文字（拼音）进入 value → 选区覆盖它 → 选区浮动工具栏
    //      不再早退 → 去读编辑区的几何信息 → 浏览器被迫把整个 textarea
    //      （可能几百 KB / 几万行）重新排版一次，并**同步阻塞**输入事件
    //      （实测每次 ~250ms，输入法因此被拖到十几秒才出一个字）。
    //   2. 拼音进了 value，如果这时渲染预览，浏览器要重排整个预览 DOM
    //      （1MB 文档 = 1.1 万个元素，几百毫秒到几秒）。
    //   3. updateFilename() → 更新状态标签 → getDocStats() 全文重建行首表。
    //
    // 所以：组字期间**一律跳过**，等 compositionend（字已经成形）再一次性处理。
    if (imeComposing || (e && e.isComposing)) {
        imePendingRender = true;
        if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
        return;
    }
    updateFilename();
    schedulePreviewRender();
    // 查找栏开着时文本变了 → 匹配位置也跟着变，重算 + 重画高亮
    if (findBar && findBar.classList.contains('open')) {
        collectMatches();
        renderEditorHighlights();
    }
});

// ============ 编辑区：Tab 键插入缩进 ============

/**
 * 手动标记"内容被改过了"。
 *
 * 直接改 `editor.value` 不会触发 input 事件 → `dirty` 不会置位、标题栏不显示 ●，
 * 所以程序改完内容（右键菜单的加粗/插入链接、Tab 缩进）都要手动叫一下，
 * 否则关窗口时静默丢改动。
 */
function markEdited() {
    dirty = true;
    updateFilename();
}

// ============ Markdown 格式化（右键菜单 / 浮动工具栏共用）============

/**
 * 插入 / 替换一段文本（右键菜单、浮动工具栏、插入图片都用它）。
 *
 * ⚠️ 必须走 `replaceSelectionKeepingUndo()`（内部用 execCommand('insertText')），
 *    **不能**直接改 `editor.value` —— 直接改会把浏览器的撤销历史冲掉，
 *    插入完按 Ctrl+Z 撤销不了（这个坑踩过）。
 *
 * @param text      要插入 / 替换的文本
 * @param selStart  替换区间起点
 * @param selEnd    替换区间终点（= selStart 就是纯插入）
 * @param caret     true = 光标落在插入内容末尾；false = 选中插入内容
 */
function menuInsertText(text, selStart, selEnd, caret) {
    replaceSelectionKeepingUndo(text, selStart, selEnd);
    if (caret) {
        const p = selStart + text.length;
        editor.setSelectionRange(p, p);
    } else {
        editor.setSelectionRange(selStart, selStart + text.length);
    }
    editor.focus({ preventScroll: true });
}

/** 在光标处插入文本（会替换掉当前选区） */
function insertAtCursor(text) {
    const s = editor.selectionStart, e = editor.selectionEnd;
    menuInsertText(text, s, e, true);    // 插入后光标落在末尾
}

/**
 * 选区内容**已经**是这种格式的话，把它拆掉（返回去掉标记后的文字）；
 * 不是的话返回 null。
 * 用于“按一下加上、再按一下取消”的切换行为。
 */
function unwrapFormat(sel, kind) {
    if (kind === 'bold') {
        const m = sel.match(/^\*\*([\s\S]+)\*\*$/);
        return m ? m[1] : null;
    }
    if (kind === 'italic') {
        // 首字符不能是 * —— 否则 `**bold**` 会被误当成斜体
        const m = sel.match(/^\*([^*\s][\s\S]*?)\*$/);
        return m ? m[1] : null;
    }
    if (kind === 'code') {
        const m = sel.match(/^`([^`]+)`$/);
        return m ? m[1] : null;
    }
    if (kind === 'codeblock') {
        // 插入时是 `\n```\n内容\n```\n`，所以围栏前后各有一个换行
        const m = sel.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
        return m ? m[1] : null;
    }
    if (kind === 'link') {
        const m = sel.match(/^\[([^\]]*)\]\(([^)]*)\)$/);
        return m ? m[1] : null;
    }
    if (kind === 'strike') {
        const m = sel.match(/^~~([\s\S]+)~~$/);
        return m ? m[1] : null;
    }
    return null;
}

/**
 * 把选中的文字包成 Markdown 格式（**可切换**）。
 * kind: 'bold' | 'italic' | 'code' | 'codeblock' | 'link'
 * 已经套过这个格式 → 拆掉（“按一下加上、再按一下取消”）。
 * 没选区时什么也不做（返回 false）。
 * ⚠️ 走 replaceSelectionKeepingUndo()（内部用 execCommand('insertText')）——
 *    直接改 editor.value 会冲掉撤销栈，插入完按 Ctrl+Z 撤销不了。
 */
function formatSelection(kind) {
    if (editor.readOnly) return false;     // 只读模式不改内容
    const s = editor.selectionStart, e = editor.selectionEnd;
    if (s === e) return false;
    const sel = editor.value.slice(s, e);
    // 已经是这个格式 → 拆掉
    const unwrapped = unwrapFormat(sel, kind);
    if (unwrapped !== null) {
        replaceSelectionKeepingUndo(unwrapped, s, e);
        editor.setSelectionRange(s, s + unwrapped.length);
        editor.focus({ preventScroll: true });
        return true;
    }
    let text;
    if (kind === 'bold') text = '**' + sel + '**';
    else if (kind === 'italic') text = '*' + sel + '*';
    else if (kind === 'code') text = '`' + sel + '`';
    // 代码块：前后各补一个换行 —— markdown 里围栏必须独占一行
    else if (kind === 'codeblock') text = '\n```\n' + sel + '\n```\n';
    else if (kind === 'link') text = '[' + sel + '](https://)';
    else if (kind === 'strike') text = '~~' + sel + '~~';
    else return false;
    replaceSelectionKeepingUndo(text, s, e);
    editor.setSelectionRange(s, s + text.length);
    editor.focus({ preventScroll: true });
    return true;
}

// ============ 选区浮动工具栏 ============
// 选中编辑区文字后，在选区上方浮现一排格式化按钮。
//
// 位置靠**算**而不是靠镜像层：编辑区是等宽字体 + wrap="off"（不折行），
// 所以「行号 × 行高」= y、「列号 × 字符宽」= x —— 和目录跳转是同一套思路。
const selToolbar = document.getElementById('sel-toolbar');
let charWidthCache = 0;
let charWidthFont = '';

// ============ 输入法（IME）组字状态 ============
// 组字期间浏览器会连续触发 input（每个拼音键一次），而且选区覆盖着预编辑文字。
// 这两点都会把"重活"引进输入路径 → 大文档上输入法被拖到十几秒才出一个字。
// 所以要显式跟踪组字状态，组字期间只标记"待处理"，不做任何重活。
let imeComposing = false;      // 组字中
let imePendingRender = false;  // 组字期间内容变了 → 组完要渲染一次

/**
 * 选区浮动工具栏的更新 —— **一律走 rAF**。
 *
 * ⚠️ 原因：算工具栏位置要读编辑区的几何信息（getBoundingClientRect），
 *    这会**强制浏览器重新排版**。如果放在 input 事件里同步做，
 *    就会阻塞输入事件的返回 → 输入法被拖慢（实测大文档上每键 ~200ms）。
 *    挪到 rAF 里 = 跟浏览器自己的绘制节奏对齐，不阻塞输入。
 */
let selToolbarRaf = 0;
function scheduleSelToolbar() {
    if (selToolbarRaf) return;
    selToolbarRaf = requestAnimationFrame(() => {
        selToolbarRaf = 0;
        updateSelToolbar();
    });
}

/**
 * 编辑区的排版度量 —— **全部缓存**。
 *
 * ⚠️ 为什么必须缓存：getComputedStyle() / getBoundingClientRect() 会触发
 *    样式重算，布局脏的时候还会**强制整个文档重排**。
 *    实测 1MB 文档（3 万行 textarea + 1.1 万个预览元素）上，
 *    一次强制重排要 **250~400ms**；中文输入法组字时每个拼音键都会走到
 *    这里 → 一个汉字要十几秒。
 *
 *    这些值**只在窗口 resize / 拖分隔条 / 缩放时**才变，
 *    平时（尤其是打字时）用缓存值即可。
 */
const editorBox = { left: 0, top: 0, padLeft: 0, padTop: 0, lh: 20, cw: 10, valid: false };
/** 浮动工具栏的尺寸（6 个固定按钮 → 尺寸固定，缓存住别反复问浏览器） */
const selToolbarBox = { w: 0, h: 0 };

/**
 * 重新量编辑区的几何信息和样式。
 * 只在会影响排版的时候调用：启动、窗口 resize、拖分隔条、缩放。
 */
function refreshEditorBox() {
    const cs = getComputedStyle(editor);
    const rect = editor.getBoundingClientRect();
    editorBox.left = rect.left;
    editorBox.top = rect.top;
    editorBox.padLeft = parseFloat(cs.paddingLeft) || 0;
    editorBox.padTop = parseFloat(cs.paddingTop) || 0;
    editorBox.lh = parseFloat(cs.lineHeight) || 20;
    // 字符宽度：等宽字体，用 canvas 量（canvas 不触发布局）
    const font = cs.fontSize + ' ' + cs.fontFamily;
    if (font !== charWidthFont) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = font;
        charWidthCache = ctx.measureText('M').width;
        charWidthFont = font;
    }
    editorBox.cw = charWidthCache;
    editorBox.valid = true;
}

/** 编辑区里一个字符的宽度（等宽字体，用 canvas 量） */
function editorCharWidth() {
    if (!editorBox.valid) refreshEditorBox();
    return editorBox.cw;
}

/**
 * 光标位置所在的行（0 起）。
 *
 * ⚠️ **不要**用 `value.slice(0, pos).split('\n').length` ——
 *    那是把光标前的**整个前缀**拷一份再拆成上万个数组元素
 *    （1MB 文档 = 几十万个字符串），每次按键都做一遍纯属浪费。
 *    行首表 getDocStats() 已经建好了，二分查就行。
 */
function lineIndexAtPos(text, pos) {
    const starts = getDocStats(text).lineStarts;
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/**
 * 选区在视口里的位置和尺寸。
 *
 * ⚠️ 这里**不能**调 getBoundingClientRect() / getComputedStyle()：
 *    那会强制文档重排（1MB 文档 = 250~400ms），中文输入法组字时
 *    每个拼音键都走这里 → 一个汉字卡十几秒。
 *    改用 editorBox 缓存（只在 resize / 拖分隔条 / 缩放时刷新）。
 *    scrollTop / scrollLeft 读的是滚动容器的现成值，不触发布局。
 */
function selectionRect() {
    if (!editorBox.valid) refreshEditorBox();
    const value = editor.value;
    const s = editor.selectionStart, e = editor.selectionEnd;
    const line = lineIndexAtPos(value, s);
    const col = s - getDocStats(value).lineStarts[line];
    const lh = editorBox.lh;
    const cw = editorBox.cw;
    const x = editorBox.left + editorBox.padLeft + col * cw - editor.scrollLeft;
    const y = editorBox.top + editorBox.padTop + line * lh - editor.scrollTop;
    // 宽度：到本行行尾为止（跨行时只取第一行那段）
    const nl = value.indexOf('\n', s);
    const endCol = (nl === -1 ? value.length : nl) - s;
    const w = Math.min(endCol, e - s) * cw;
    return { x, y, w, h: lh };
}

/**
 * 选区是否落在围栏代码块里。
 * 代码块里的是**源码**，套 Markdown 格式（加粗等）没意义 —— 所以那里不弹浮动工具栏。
 * 只数光标之前的围栏开关个数（奇数 = 在代码块里）。
 * ⚠️ 这个要扫文本，**只能在有选区时调用**（打字时每次都扫 1MB 会卡）。
 */
function selectionInCodeBlock() {
    const before = editor.value.slice(0, editor.selectionStart);
    const fences = before.match(/^[ \t]{0,3}(?:```|~~~)/gm);
    return fences ? fences.length % 2 === 1 : false;
}

/**
 * 量一次浮动工具栏的尺寸（之后缓存着用）。
 * 只在窗口 resize / 缩放后需要重新量 —— 平时尺寸不变。
 */
function measureSelToolbarBox() {
    if (!selToolbar) return;
    const wasShown = selToolbar.classList.contains('show');
    if (!wasShown) {
        // display:none 时量不到尺寸 → 临时显示一下，量完再藏
        selToolbar.style.visibility = 'hidden';
        selToolbar.classList.add('show');
    }
    selToolbarBox.w = selToolbar.offsetWidth;
    selToolbarBox.h = selToolbar.offsetHeight;
    if (!wasShown) selToolbar.classList.remove('show');
}

/** 显示 / 隐藏 / 移动浮动工具栏 */
function updateSelToolbar() {
    if (!selToolbar) return;
    // ⚠️ 组字期间（预编辑文字 = 选区）不弹工具栏：
    //    拼音还没成字，给用户"加粗/斜体"按钮没意义；
    //    而且算位置要读布局 → 强制重排 → 拖慢输入法。
    if (imeComposing) {
        selToolbar.classList.remove('show');
        return;
    }
    const show = editMode && !editor.readOnly
        && document.activeElement === editor
        && editor.selectionStart !== editor.selectionEnd;
    if (!show || selectionInCodeBlock()) {
        selToolbar.classList.remove('show');
        return;
    }
    const r = selectionRect();
    selToolbar.style.visibility = 'hidden';
    selToolbar.classList.add('show');
    // 按钮的激活状态：选中的内容已经是这个格式（比如已经加粗了）
    const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    for (const btn of selToolbar.querySelectorAll('button[data-fmt]')) {
        btn.classList.toggle('on', unwrapFormat(sel, btn.dataset.fmt) !== null);
    }
    // ⚠️ offsetWidth/offsetHeight 也会强制布局 —— 工具栏尺寸是固定的
    //    （6 个按钮，样式不变尺寸就不变），缓存起来，别每次都问浏览器要。
    const tw = selToolbarBox.w, th = selToolbarBox.h;
    // 水平：居中于选区，但不超出窗口
    let left = r.x + r.w / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    // 垂直：默认在选区上方；上方不够（第一行 / 贴着工具栏）就放下方
    let top = r.y - th - 8;
    if (top < 56) top = r.y + r.h + 8;
    selToolbar.style.left = left + 'px';
    selToolbar.style.top = top + 'px';
    selToolbar.style.visibility = 'visible';
}

if (selToolbar) {
    // mousedown 阻止默认 → 按钮不会抢走编辑区焦点，选区还在（否则点了按钮就没得选了）
    selToolbar.addEventListener('mousedown', (e) => e.preventDefault());
    selToolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-fmt]');
        if (!btn) return;
        if (formatSelection(btn.dataset.fmt)) updateSelToolbar();
    });
}
// ⚠️ 用户在编辑区按下鼠标 → 肯定要改选区了，工具栏先收起来。
//    不能只靠 selectionchange：点击（而不是拖选）时浏览器不一定发那个事件，
//    结果就是“点了别处、选区没了，工具栏还赖着不走”（这个坑踩过）。
editor.addEventListener('mousedown', () => {
    if (selToolbar) selToolbar.classList.remove('show');
});
editor.addEventListener('scroll', scheduleSelToolbar);
window.addEventListener('resize', scheduleSelToolbar);
// 窗口尺寸变了 → 编辑区的几何信息和排版都变了 → 重新量
window.addEventListener('resize', () => {
    refreshEditorBox();
    refreshEditorLineHeight();
    measureSelToolbarBox();
    refreshFilenameTarget();
});
// 失焦 → 工具栏要收起来
editor.addEventListener('blur', scheduleSelToolbar);
// ⚠️ 程序性的 setSelectionRange / 改 value **不一定会触发 selectionchange**
//    （浏览器只在用户操作时发），所以再兜几个：
//    select = 选区变化的标准事件（程序性 setSelectionRange 也会发，最准）
//    input = 打字后；keyup = 方向键等（虽然 selectionchange 一般也会跟着）
editor.addEventListener('select', scheduleSelToolbar);
editor.addEventListener('input', scheduleSelToolbar);
editor.addEventListener('keyup', scheduleSelToolbar);

// ============ 输入法组字：开始 / 结束 ============
// 组字开始 → 进入"只标记不干活"模式；组字结束 → 把攒下的活一次做完。
editor.addEventListener('compositionstart', () => {
    imeComposing = true;
    imePendingRender = false;
    if (selToolbar) selToolbar.classList.remove('show');
});
editor.addEventListener('compositionend', () => {
    imeComposing = false;
    // 组完字：内容变了 → 补上组字期间攒下的活（标题/状态、预览、查找高亮）
    if (imePendingRender) {
        imePendingRender = false;
        updateFilename();
        schedulePreviewRender();
        if (findBar && findBar.classList.contains('open')) {
            collectMatches();
            renderEditorHighlights();
        }
    }
    scheduleSelToolbar();
});

// ============ 插入图片 ============
/** 图片路径转成相对于当前 markdown 文件的路径（markdown 里统一用 / 分隔） */
function relativeImagePath(full) {
    const f = String(full).replace(/\\/g, '/');
    const base = currentFile ? currentBaseDir().replace(/\\/g, '/').replace(/\/+$/, '') : '';
    if (!base) return f;
    // 同一个目录树下 → 用相对路径（换台电脑、换个目录也能用）
    if (f.toLowerCase().startsWith(base.toLowerCase() + '/')) return f.slice(base.length + 1);
    return f;   // 不在同一个目录树下 → 只能用绝对路径
}

/** 选一张本地图片，插入 ![](相对路径) */
async function insertImage() {
    try {
        const picked = await open({
            multiple: false,
            filters: [{
                name: '图片',
                extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'],
            }],
        });
        if (!picked) return;
        const path = Array.isArray(picked) ? picked[0] : picked;
        const rel = relativeImagePath(path);
        // 路径里有空格时用尖括号包起来（markdown 标准写法，不用 %20 编码）
        const target = /\s/.test(rel) ? '<' + rel + '>' : rel;
        const text = '\n![](' + target + ')\n';
        const s = editor.selectionStart;
        insertAtCursor(text);
        // 光标落到 alt 文本里（![] 的中间），用户直接就能写图片说明
        const altPos = s + 3;   // '\n' + '!' + '['
        editor.setSelectionRange(altPos, altPos);
        editor.focus({ preventScroll: true });
    } catch (e) {
        showError('插入图片失败', e);
    }
}

// ============ 快捷键：标题 / 列表 ============// Ctrl+1/2/3 → 把选中的行变成 # / ## / ###
// Ctrl+Shift+7/8 → 有序 / 无序列表
//
// 用 e.code 判断（物理键位）：Ctrl+Shift+8 在 US 布局下 e.key 是 '*'，
// 用 e.key 会漏掉其它布局。
// ⚠️ Ctrl+1/2/3 在 Chrome 里是“切换标签页”的保留键，可能根本收不到 ——
//    如果实测收不到，得去 WebView2 层（AcceleratorKeyPressed）拦，
//    拦完记得 emit 事件通知前端（见 main.rs 的 install_reload_blocker）。

/** 选区覆盖的行范围（没有选区时就是光标所在那一行） */
function selectedLineRange() {
    const value = editor.value;
    const s = editor.selectionStart, e = editor.selectionEnd;
    const lineStart = value.lastIndexOf('\n', s - 1) + 1;
    let lineEnd = value.indexOf('\n', e);
    if (lineEnd === -1) lineEnd = value.length;
    return [lineStart, lineEnd];
}

/**
 * 行首发生变动时（去掉旧标记 / 加上新前缀），把旧块里的一个偏移映射到新块里。
 *
 * ⚠️ 不能用“字符偏移 + 位移量”算 —— 每行前面加的前缀长度不同
 *    （`# ` / `- ` / `1. ` / `10. `），字符偏移全变了。
 *    要按“行号 + 行内列号”算：新行内的列号 = 原列号 - 旧标记长度 + 新前缀长度。
 *
 * @param strips 每行开头去掉了多少字符
 * @param adds   每行开头加上了多少字符
 * @returns 新块里的偏移
 */
function mapOffset(oldBlock, oldOffset, newBlock, strips, adds) {
    const before = oldBlock.slice(0, oldOffset);
    const lineIdx = before.split('\n').length - 1;
    const oldLineStart = before.lastIndexOf('\n') + 1;
    const col = oldOffset - oldLineStart;
    // 新块里第 lineIdx 行的起始位置
    let off = 0;
    for (let i = 0; i < lineIdx; i++) {
        const nl = newBlock.indexOf('\n', off);
        if (nl === -1) return newBlock.length;
        off = nl + 1;
    }
    const newCol = Math.max(0, col - (strips[lineIdx] || 0)) + (adds[lineIdx] || 0);
    const nl = newBlock.indexOf('\n', off);
    const maxCol = (nl === -1 ? newBlock.length : nl) - off;
    return off + Math.min(newCol, maxCol);
}

/** Ctrl+1~6：把选中的行变成标题 */
function applyHeading(level) {
    if (editor.readOnly) return;           // 只读模式不改内容
    const [lineStart, lineEnd] = selectedLineRange();
    const s = editor.selectionStart, e = editor.selectionEnd;
    const oldBlock = editor.value.slice(lineStart, lineEnd);
    const prefix = '#'.repeat(level) + ' ';
    const strips = [], adds = [], parts = [];
    for (const line of oldBlock.split('\n')) {
        const m = line.match(/^(#{1,6}\s*)/);
        const strip = m ? m[1].length : 0;
        strips.push(strip);
        adds.push(prefix.length);
        parts.push(prefix + line.slice(strip));   // 去掉旧标题标记，再加新的
    }
    const out = parts.join('\n');
    replaceSelectionKeepingUndo(out, lineStart, lineEnd);
    // 光标 / 选区跟着走（原来在文字中间，改完还在那个字后面）
    const ns = mapOffset(oldBlock, s - lineStart, out, strips, adds);
    const ne = mapOffset(oldBlock, e - lineStart, out, strips, adds);
    editor.setSelectionRange(lineStart + ns, lineStart + ne);
    editor.focus({ preventScroll: true });
}

/** Ctrl+Shift+7/8：有序 / 无序列表（再按一次 = 取消列表） */
function applyList(kind) {
    if (editor.readOnly) return;           // 只读模式不改内容
    const [lineStart, lineEnd] = selectedLineRange();
    const s = editor.selectionStart, e = editor.selectionEnd;
    const oldBlock = editor.value.slice(lineStart, lineEnd);
    const strips = [], adds = [], parts = [];
    let n = 0;
    for (const line of oldBlock.split('\n')) {
        const m = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/);
        const indent = m ? m[1] : (line.match(/^(\s*)/) || ['', ''])[1];
        const rest = m ? m[2] : line.slice(indent.length);
        const isUl = /^[-*+]\s/.test(line);
        const isOl = /^\d+\.\s/.test(line);
        // 已经是目标类型的列表 → 再按一次就取消（变回普通段落）
        const cancel = (kind === 'ul' && isUl) || (kind === 'ol' && isOl);
        const marker = cancel ? '' : (kind === 'ol' ? (++n) + '. ' : '- ');
        // strip/add 只算**标记**的长度（缩进两边一样，不影响列号）
        // ⚠️ m[0] 是整个匹配（含正文），标记长度 = m[0] - 缩进 - 正文
        strips.push(m ? m[0].length - indent.length - rest.length : 0);
        adds.push(marker.length);
        parts.push(indent + marker + rest);
    }
    const out = parts.join('\n');
    replaceSelectionKeepingUndo(out, lineStart, lineEnd);
    const ns = mapOffset(oldBlock, s - lineStart, out, strips, adds);
    const ne = mapOffset(oldBlock, e - lineStart, out, strips, adds);
    editor.setSelectionRange(lineStart + ns, lineStart + ne);
    editor.focus({ preventScroll: true });
}

// textarea 的默认行为是"按 Tab 把焦点移走" —— 写 markdown 嵌套列表时想按 Tab
// 缩进，结果焦点跳到工具栏按钮上去了。这里改成插缩进（Shift+Tab 反缩进）。
const TAB_SIZE = 2;   // markdown 嵌套列表用 2 空格（4 空格会被 CommonMark 当成代码块）

/**
 * 替换选区里的内容，并且**保住原生撤销栈**（一次 Ctrl+Z 能整体撤销这次缩进）。
 *
 * 关键：用 `document.execCommand('insertText')` 而不是直接改 `editor.value` ——
 * 直接改 value 会把浏览器的撤销历史冲掉（一下要按十几次 Ctrl+Z 才回得去）。
 * 这个 API 虽然废弃了，但目前是唯一能保留 textarea 撤销栈的办法。
 */
/**
 * 替换选区里的内容，并且**保住原生撤销栈**（一次 Ctrl+Z 能整体撤销这次缩进）。
 *
 * 关键：用 `document.execCommand('insertText')` 而不是直接改 `editor.value` ——
 * 直接改 value 会把浏览器的撤销历史冲掉（一下要按十几次 Ctrl+Z 才回得去）。
 * 这个 API 虽然废弃了，但目前是唯一能保留 textarea 撤销栈的办法。
 *
 * @returns false = 因为只读而没动（调用方据此提示，不要误报“已替换”）
 */
function replaceSelectionKeepingUndo(text, selStart, selEnd) {
    // ⚠️ 只读模式（自动重载开着）不能改内容 ——
    //    textarea 的 readOnly 只挡键盘输入，execCommand 在只读框上会失败，
    //    然后回退路径直接改 value 就把只读绕过去了（这个坑踩过）。
    if (editor.readOnly) return false;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(selStart, selEnd);
    const before = editor.value;
    let ok = false;
    try {
        ok = document.execCommand('insertText', false, text);
    } catch (e) {
        ok = false;
    }
    if (ok && editor.value !== before) {
        // ⚠️ 校验插入的内容是不是真的进去了 ——
        //    execCommand 在某些情况下会“成功但内容不对”（比如换行被吃掉）。
        //    对不上就走回退路径，保证内容一定是想要的。
        //    （比较时去掉 \r：textarea 的 value 会把 \r\n 规范成 \n）
        const got = editor.value.slice(selStart, selStart + text.length).replace(/\r/g, '');
        if (got === text.replace(/\r/g, '')) {
            // execCommand 一般会触发 input 事件（dirty / 预览刷新自动搞定）；
            // 万一没触发就手动补一下 —— 宁可重复调用也不能漏掉 dirty
            markEdited();
            return true;
        }
        // 插进去的不是要的东西 → 先撤掉这次插入，再走回退
        try { document.execCommand('undo'); } catch (e2) { /* 撤不掉就算了，下面直接覆盖 */ }
    }
    // 回退：直接改 value（撤销栈断了，但功能得能用）
    const after = editor.value.slice(0, selStart) + text + editor.value.slice(selEnd);
    if (after === editor.value) return true;   // 什么都没变（比如反缩进时行首没空白）
    editor.value = after;
    editor.setSelectionRange(selStart, selStart + text.length);
    markEdited();
    return true;
}

editor.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (editor.readOnly) return;              // 只读模式不改内容（让 Tab 正常移焦点）
    e.preventDefault();

    const value = editor.value;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const outdent = e.shiftKey;

    if (value.slice(start, end).includes('\n')) {
        // 选区跨多行 → 整行缩进 / 反缩进
        const nl = value.indexOf('\n', end);
        const blockEnd = nl === -1 ? value.length : nl;
        const block = value.slice(lineStart, blockEnd);
        const out = block.split('\n').map(line => {
            if (!outdent) return ' '.repeat(TAB_SIZE) + line;
            const m = line.match(/^[ \t]+/);
            if (!m) return line;
            if (m[0][0] === '\t') return line.slice(1);
            return line.slice(Math.min(TAB_SIZE, m[0].length));
        }).join('\n');
        replaceSelectionKeepingUndo(out, lineStart, blockEnd);
        editor.setSelectionRange(lineStart, lineStart + out.length);   // 缩完仍然整块选中
    } else if (outdent) {
        // 单行反缩进：删掉光标前面（且在行首之后）连续的空白
        const m = value.slice(lineStart, start).match(/[ \t]+$/);
        if (!m) return;
        const cut = m[0][0] === '\t' ? 1 : Math.min(TAB_SIZE, m[0].length);
        replaceSelectionKeepingUndo('', start - cut, start);
    } else {
        // 光标处插缩进（选中了文字就替换掉）
        replaceSelectionKeepingUndo(' '.repeat(TAB_SIZE), start, end);
    }
});

// ============ 滚动同步（双向）============
//
// 核心：**块级锚点**，不是按比例。
// 按比例（scrollTop / 可滚高度）是错的 —— 编辑区是源码、预览区是渲染结果，
// 同样的源码行数在两边占的高度完全不同（标题、代码块、表格差几倍），
// 比例映射会让两边差出十几个块。
//
// 现在改成：源码的顶层块 ↔ 预览的顶层块是**一一对应**的
// （增量渲染保证了这点），所以只要知道“第几块”，就能精确定位。
//
// ⚠️ **回弹抑制必须按方向**：
//    同步 A→B 会让 B 触发一个 scroll 事件，那是回弹，必须忽略。
//    但**不能**用一个全局标志 —— 那样**同方向**的连续滚动事件也会被丢掉
//    （一次滚轮手势会产生 5~10 个 scroll 事件，间隔 16ms；
//     全丢的话预览区只跟得上第一帧 → “滚起来跟不上”）。
//    现在：只忽略 120ms 内来自**另一个方向**的 scroll。
const previewScroll = document.getElementById('preview-wrap');
// 手动同步（目录跳转）期间完全锁住自动同步 —— 那里要的是“精确落位”，
// 不能让自动同步的按比例映射把它冲掉。
let syncing = false;
let lastEditorScrollTop = 0;

// 顶层块的行范围表：blockLines[k] = { start, count }
//   start = 该块在源码里的起始行（0 基），count = 它占的行数
// ⚠️ 编辑区是不折行的（wrap="off"），所以一个块的 raw 文本**原样**占那些行 ——
//    块在编辑区里的高度就是 行数 × 行高，精确对应。
let blockLines = [];
// 源码每一行的起始字符偏移（全局一份，所有块共用）
let srcLineStarts = [];

// ============ 行级锚点表 ============
//
// 目标：任意滚动位置都能**精确**反查，不用“按比例估算”。
// 之前按比例映射必然偏 —— 源码一行 ≠ 预览一行（长段落会折行、
// 表格的 --- 分隔行不渲染、代码块行高不同）。
//
// 现在记录：预览里的每个可定位元素 → 它对应的源码行。
// 块内怎么细分（块与源码行范围的对应是确定的，看 DOM 结构就知道）：
//   表格 → 每个 tr 一行（跳过 --- 分隔行）
//   代码块 → hljs 高亮后每行一个 span
//   其他 → 整个元素对应一行（列表/引用块内部不细分，误差在几十行内）
let anchorList = [];   // [{el, line, endLine, block, top, height}]
// 目录的滚动位置（scroll 事件里缓存 —— 那时布局已算好，读 scrollTop 是免费的）
let tocKeepScroll = 0;
let anchorsDirty = true;   // 渲染后位置会变 → 滚动时再重测，按源码行升序

/** 顶层块 → 真正的内容元素（表格被包进了 .table-wrap，代码块被包进了 .code-block） */
function contentElementOf(el) {
    if (el.classList && el.classList.contains('table-wrap')) return el.querySelector('table');
    if (el.classList && el.classList.contains('code-block')) return el.querySelector('pre');
    return el;
}

/** 把一个顶层块拆成若干“可定位元素 → 源码行” */
function splitRows(el, start) {
    if (!el) return [];
    // 表格：每个 tr 一行（thead 后面那个 --- 分隔行不渲染成 tr，要跳过）
    if (el.tagName === 'TABLE') {
        const out = [];
        const trs = Array.from(el.querySelectorAll('tr'));
        trs.forEach((tr, i) => {
            const line = i === 0 ? start : start + i + 1;
            out.push({ el: tr, line, endLine: line });
        });
        return out;
    }
    // 代码块：**不按行细分**。
    // ⚠️ 细分的话，大文档里每个代码行都是一个锚点（1MB 文档实测 16538 个）——
    //    每次滚动都要遍历一遍取布局，19ms/次 → 直接卡死。
    //    代码块内部改用**字符比例**定位（源码第 k 行在块内的字符占比），
    //    精度和按行细分差不多，但锚点数少两个数量级。
    // 其他：整个元素一行
    return [{ el, line: start, endLine: start }];
}

/** 重建锚点表（预览 DOM 变了就重建） */
function buildAnchorTable() {
    anchorList = [];
    const kids = Array.from(preview.children);
    for (let k = 0; k < kids.length; k++) {
        const bl = blockLines[k];
        if (!bl) continue;
        const inner = contentElementOf(kids[k]);
        const rows = splitRows(inner, bl.start);
        for (const r of rows) { r.block = k; anchorList.push(r); }
    }
    // 顺带测位置（一次布局就够，后面的读取都走缓存）。
    // ⚠️ 必须在**渲染之外**做（下一帧）—— 渲染后布局是脏的，
    //    这时候测会强制整个预览（1.2 万个元素）重新布局 → 几百毫秒 → 卡死。
    if (previewScroll) {
        const wrapRect = previewScroll.getBoundingClientRect();
        const base = previewScroll.scrollTop;
        for (const a of anchorList) {
            const r = a.el.getBoundingClientRect();
            a.top = r.top - wrapRect.top + base;     // 在预览内容里的位置
            a.height = r.height;
        }
    }
    anchorsDirty = false;
    return anchorList;
}

/**
 * 重测所有锚点在预览内容里的位置（top）和高度（height）。
 * ⚠️ 懒执行：渲染时不测，只在滚动同步要用时才测 ——
 *    一次 getBoundingClientRect 触发一次布局，之后的读取都走缓存，
 *    所以 N 个锚点只花一次布局的时间。
 */
/** 目录渲染挪到下一帧（脏布局下做会触发全局重排 → 卡死） */
let tocRenderRaf = 0;
function scheduleTocRender() {
    if (tocRenderRaf) return;
    tocRenderRaf = requestAnimationFrame(() => {
        tocRenderRaf = 0;
        renderToc();
    });
}

/** 渲染后延后一帧测位置（浏览器那一帧本来就要重排） */
let anchorMeasureRaf = 0;
function scheduleAnchorMeasure() {
    if (anchorMeasureRaf) return;
    anchorMeasureRaf = requestAnimationFrame(() => {
        anchorMeasureRaf = 0;
        // 这一帧浏览器已经把预览排好版了 → 现在读 scrollHeight 是免费的
        //（此时布局已干净，不触发强制重排）
        refreshPreviewScrollMax();
        buildAnchorTable();      // 预览 DOM 变了 → 重建行级锚点表
        ensureAnchorPositions(); // 顺带测位置（浏览器这一帧本来就要重排）
    });
}

/** 位置在 buildAnchorTable() 里已经测好了，这里只是保证表不是空的 */
function ensureAnchorPositions() {
    if (!anchorList.length) buildAnchorTable();
}

/** 某个预览元素在预览内容里的顶部位置（用锚点表缓存，避免读布局） */
function elTopInContent(el) {
    ensureAnchorPositions();
    for (const a of anchorList) {
        if (a.el === el) return a.top;
    }
    return 0;
}
function elHeightInContent(el) {
    ensureAnchorPositions();
    for (const a of anchorList) {
        if (a.el === el) return a.height;
    }
    return 0;
}

/** 锚点对应的块 */
function blockOfAnchor(a) {
    return a && a.block !== undefined ? blockLines[a.block] : null;
}

/**
 * 源码顶行在锚点内部的位置（0~1）—— 按**字符比例**算。
 * 长段落里源码只有几行，预览却折成十几行，行高完全不成比例；
 * 只有字符比例能对上（渲染后的高度大致与内容量成正比）。
 */
function fracInBlock(a, topLine) {
    const bl = blockOfAnchor(a);
    if (!bl || !bl.charLen) return 0;
    const i = Math.max(0, topLine - bl.start);
    const lineStart = srcLineStarts[bl.start + i];
    if (lineStart === undefined) return 0;
    const charInBlock = Math.max(0, lineStart - bl.charStart);
    return Math.max(0, Math.min(charInBlock / bl.charLen, 1));
}

/** 锚点内某个比例（0~1）对应源码的哪一行 */
function lineOfCharInBlock(a, frac) {
    const bl = blockOfAnchor(a);
    if (!bl) return a ? a.line : 0;
    const charInBlock = frac * bl.charLen;
    let li = 0;
    const maxI = Math.min(bl.count - 1, srcLineStarts.length - bl.start - 1);
    for (let i = 0; i <= maxI; i++) {
        const off = srcLineStarts[bl.start + i] - bl.charStart;
        if (off <= charInBlock) li = i; else break;
    }
    return bl.start + li;
}

/** 找“源码行 <= line 的最后一个锚点” */
function anchorAtLine(line) {
    let best = null;
    for (const a of anchorList) {
        if (a.line <= line) best = a;
        else break;
    }
    return best;
}

/**
 * 找“预览视口顶切在哪个锚点上”。
 * ⚠️ 是**第一个底边还在视口顶下方**的锚点（部分可见）——
 *    不是“最后一个完全在上方的”。视口顶通常切在某个锚点内部，
 *    用“完全在上方的最后一个”会差一整个锚点（实测差十几行）。
 */
function anchorAtViewportTop() {
    if (!previewScroll || !anchorList.length) return null;
    // 位置表还没测好（刚渲染完）→ 先用比例兜底，别为了精确把输入卡住
    if (anchorsDirty) return null;
    ensureAnchorPositions();
    const top = previewScroll.scrollTop;
    // 二分：最后一个“顶边在视口顶之上”的锚点（视口顶通常切在它内部）
    let lo = 0, hi = anchorList.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (anchorList[mid].top <= top) lo = mid; else hi = mid - 1;
    }
    return anchorList[lo] || null;
}

/** 某一行属于第几个顶层块（取“起始行 <= 行”的最后一个块） */
function blockIndexAtLine(line) {
    let k = -1;
    for (let i = 0; i < blockLines.length; i++) {
        if (blockLines[i].start <= line) k = i;
        else break;
    }
    return k;
}

/** 数一个字符串里的换行个数 */
function countNewlines(s) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) === 10) n++;
    }
    return n;
}

/**
 * 根据 token 列表算出每个顶层块的行范围。
 * ⚠️ marked 的 token.raw **累加 === 源码**（已验证），所以可以直接累加行数。
 *    一个 token 占的行数 = 换行数（raw 以换行结尾时）或 换行数+1（否则）。
 */
function computeBlockLines(tokens, sourceText) {
    // ⚠️ 必须按**字符偏移**算，不能按“raw 里的换行数”累加：
    //    换行的归属说不清：段落 token 的 raw 不含结尾换行，那个换行归下一个 token，
    //    按换行数累加会越算越偏（实测 README 上偏了好几个块）。
    //    marked 的 token.raw 累加 === 源码，所以字符偏移是准的。
    // 行起始字符偏移表（全局一份，所有块共用）
    // ⚠️ 别给每个块各建一个 lineChars 数组 —— 1MB 文档 1.2 万个块就是 1.2 万个小数组，
    //    每次渲染重建 → GC 压力，实测慢好几百毫秒。
    const lineStarts = srcLineStarts;
    lineStarts.length = 0;
    lineStarts.push(0);
    for (let i = 0; i < sourceText.length; i++) {
        if (sourceText.charCodeAt(i) === 10) lineStarts.push(i + 1);
    }
    // 字符偏移 → 行号（最后一个 <= 它的行起始）
    const lineOf = (charPos) => {
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid] <= charPos) lo = mid; else hi = mid - 1;
        }
        return lo;
    };
    const lines = [];
    let charPos = 0;
    for (const t of tokens) {
        const startChar = charPos;
        charPos += t.raw.length;
        if (t.type === 'space' || t.type === 'def') continue;
        const start = lineOf(startChar);
        const end = lineOf(Math.max(startChar, charPos - 1));   // raw 的最后一个字符所在行
        const count = Math.max(1, end - start + 1);
        // 块内每一行的起始字符偏移（相对块首）——
        // 长段落（源码几行、预览折成十几行）必须按**字符比例**定位，
        // 按行比例会偏很多（行高完全不成比例）。
        lines.push({
            start, count,
            charStart: startChar,
            charLen: t.raw.length,
        });
    }
    return lines;
}

/** 编辑区的行高（px）和顶部内边距。
 *  ⚠️ 滚动的原点是 **padding 顶边**（跟 scrollEditorToLine() 一致）——
 *     所以 scrollTop → 行号的换算要减掉 paddingTop。
 *
 * ⚠️ **必须用缓存**：getComputedStyle() 会触发样式重算，
 *    布局脏的时候还会连带强制重排（1MB 文档 = 几百毫秒）。
 *    这个函数在滚动同步路径上被反复调用 —— 每次都重算等于每次都强制重排。
 *    缓存由 refreshEditorLineHeight() 维护（缩放 / 窗口大小变化时才刷新）。
 */
function editorMetrics() {
    if (!editorLineHeight) refreshEditorLineHeight();
    return { lh: editorLineHeight, padTop: editorPadTop };
}

/**
 * 换文件 / 新建后回到顶部。
 * ⚠️ 改 editor.value **不会**重置滚动位置 —— 浏览器会保留上一次的 scrollTop，
 *    于是新文件打开时停在上一个文件的那一行（用户反馈过）。
 * ⚠️ scroll 事件是异步派发的，所以要先把自动同步锁住，延后再解锁。
 */
function resetScrollToTop() {
    if (!editor) return;
    syncing = true;
    editor.scrollTop = 0;
    if (previewScroll) previewScroll.scrollTop = 0;
    setTimeout(() => { syncing = false; }, 60);
}

/**
 * 预览区可滚动的高度 —— **缓存**。
 *
 * ⚠️ previewScroll.scrollHeight 会强制重排整个预览 DOM
 *    （1MB 文档 = 1.1 万个元素）。这个函数在**每次编辑区滚动**时都跑
 *    → 每次滚动都强制重排一遍 → 大文档上滚动会卡。
 *    预览内容变了才需要重算（renderPreview 之后），平时用缓存。
 */
let previewScrollMax = 0;
/** 重新量预览区的可滚动高度（渲染完预览后调用） */
function refreshPreviewScrollMax() {
    if (!previewScroll) return;
    previewScrollMax = Math.max(0, previewScroll.scrollHeight - previewScroll.clientHeight);
}

/** 按比例同步（块级锚点算不出来时的兜底） */
function applyScrollByRatio(fromEditor) {
    // ⚠️ 用缓存值，别在这里读 scrollHeight —— 那会强制重排整个预览 DOM。
    if (!previewScrollMax) refreshPreviewScrollMax();
    const maxEdit = editor.scrollHeight - editor.clientHeight;
    const maxPrev = previewScrollMax;
    if (maxEdit <= 0 || maxPrev <= 0) return;
    if (fromEditor) {
        const target = (editor.scrollTop / maxEdit) * maxPrev;
        setScrollTop(previewScroll, target);
    } else {
        const target = (previewScroll.scrollTop / maxPrev) * maxEdit;
        setScrollTop(editor, target);
    }
}

/** 把编辑区的位置应用到预览区（编辑区 → 预览区）
 *
 *  锚点是**标题节点**（当前章节），不是任意一个块 ——
 *  同一个章节里滚动时预览区不动（不抖），跳章节时才动。
 *  两边对齐到章节起点，位置永远可预测。
 */
function applyScrollToPreview() {
    if (!editor || !previewScroll) return;
    const { lh, padTop } = editorMetrics();
    if (!previewScrollMax) refreshPreviewScrollMax();
    const maxPrev = previewScrollMax;
    if (!lh || !anchorList.length) { applyScrollByRatio(true); return; }

    // 锚点 = 源码顶行所在的预览元素（**精确查表**，不是按比例估算）
    const topLine = Math.floor((editor.scrollTop - padTop) / lh);
    const a = anchorAtLine(topLine);
    if (!a) { applyScrollByRatio(true); return; }
    // 锚点内部的位置用**字符比例**：长段落里源码几行、预览折成十几行，
    // 行高完全不成比例，只有字符比例能对上。
    const frac = fracInBlock(a, topLine);
    // 位置表还没测好（刚渲染完）→ 按比例兜底，别在输入路径里强制重排
    if (anchorsDirty) { applyScrollByRatio(true); return; }
    ensureAnchorPositions();
    // 目标位置 = 锚点在内容里的位置 + 块内比例偏移
    const target = a.top + frac * (a.height || 0);
    const want = Math.max(0, Math.min(target, maxPrev));
    // 幂等保护：已经在位就不动（不然同步→预览滚→回弹→反向同步… 来回拉扯）
    if (Math.abs(previewScroll.scrollTop - want) < 2) { updateAlignedChapter(); return; }
    setScrollTop(previewScroll, want);
    updateAlignedChapter();
}

/** 块级对齐（文档没有标题时的兜底） */
function applyScrollToPreviewByBlock() {
    if (!editor || !previewScroll) return;
    const { lh, padTop } = editorMetrics();
    const maxPrev = previewScroll.scrollHeight - previewScroll.clientHeight;
    // 块数对不上（原始 HTML 展开成多个预览节点）→ 退回按比例
    if (!lh || !blockLines.length || preview.children.length !== blockLines.length) {
        applyScrollByRatio(true);
        return;
    }
    const topLine = Math.floor((editor.scrollTop - padTop) / lh);
    const k = blockIndexAtLine(topLine);
    if (k < 0) { applyScrollByRatio(true); return; }
    const el = preview.children[k];
    if (!el) { applyScrollByRatio(true); return; }
    const bl = blockLines[k];
    const frac = bl.count > 0 ? (topLine - bl.start) / bl.count : 0;
    const ratio = Math.max(0, Math.min(frac, 1));
    const wrapRect = previewScroll.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const target = previewScroll.scrollTop + (elRect.top - wrapRect.top) + ratio * elRect.height;
    setScrollTop(previewScroll, Math.min(target, maxPrev));
}

/** 把预览区的位置应用到编辑区（预览区 → 编辑区）
 *
 *  同样按**标题节点**对齐：当前章节的标题 → 源码里那一行。
 */
function applyScrollToEditor() {
    if (!editor || !previewScroll) return;
    const { lh, padTop } = editorMetrics();
    const maxEdit = editor.scrollHeight - editor.clientHeight;
    if (!lh || !anchorList.length) { applyScrollByRatio(false); return; }

    // 锚点 = 预览视口顶部所在的元素（**精确查表**）
    const a = anchorAtViewportTop();
    if (!a) { applyScrollByRatio(false); return; }   // 位置表还没测好 → 按比例
    ensureAnchorPositions();
    // 锚点内部的位置（视口顶在这个锚点里往下滑了多少）
    const passed = previewScroll.scrollTop - a.top;     // 正数 = 视口顶在锚点上方
    const frac = a.height > 0 ? Math.max(0, Math.min(passed / a.height, 1)) : 0;
    let line = lineOfCharInBlock(a, frac);
    // 源码那边滚不到这么远（预览渲染后比源码高）→ **编辑区原地不动，预览继续走**
    // ⚠️ 这里**不能**把编辑区钳制到底再往下设：
    //    钳制会让 scrollTop 变一点点 → 触发编辑区的 scroll 事件 → 预览又被拽回去
    //    → 滚轮溢出只生效一次（实测 +120 而不是 +960）。
    //    编辑区反正已经到底了，保持原样最干净。
    const maxLine = Math.floor((maxEdit - padTop) / lh);
    if (line > maxLine) {
        updateAlignedChapter();
        return;                      // 编辑区不动 → 不会触发反向同步 → 预览自由滚
    }
    // 幂等保护：已经在那一行就不动
    const wantPos = Math.min(Math.ceil(line * lh + padTop), maxEdit);
    if (Math.abs(editor.scrollTop - wantPos) < 2) { updateAlignedChapter(); return; }
    scrollEditorToLine(line);
    updateAlignedChapter();
}

/** 块级对齐（文档没有标题时的兜底） */
function applyScrollToEditorByBlock() {
    if (!editor || !previewScroll) return;
    const { lh, padTop } = editorMetrics();
    const maxEdit = editor.scrollHeight - editor.clientHeight;
    const maxPrev = previewScroll.scrollHeight - previewScroll.clientHeight;
    if (!lh || !blockLines.length || preview.children.length !== blockLines.length) {
        applyScrollByRatio(false);
        return;
    }
    const wrapRect = previewScroll.getBoundingClientRect();
    let k = -1;
    for (let i = 0; i < preview.children.length; i++) {
        const r = preview.children[i].getBoundingClientRect();
        if (r.bottom > wrapRect.top) { k = i; break; }
    }
    if (k < 0) { applyScrollByRatio(false); return; }
    const bl = blockLines[k];
    if (!bl) { applyScrollByRatio(false); return; }
    const elRect = preview.children[k].getBoundingClientRect();
    const passed = wrapRect.top - elRect.top;
    const frac = elRect.height > 0 ? passed / elRect.height : 0;
    const ratio = Math.max(0, Math.min(frac, 1));
    let line = bl.start + ratio * Math.max(0, bl.count - 1);
    const maxLine = Math.floor((maxEdit - padTop) / lh);
    if (line > maxLine) line = maxLine;
    scrollEditorToLine(line);          // 它会补上 paddingTop
}

// 编辑区已经到底、但预览区还有内容时，滚轮要能继续往下走。
// ⚠️ 编辑区到底后 scrollTop 不再变 → 浏览器**不再触发 scroll 事件** →
//    只靠 scroll 事件是收不到这个信号的，必须监听 wheel。
editor.addEventListener('wheel', (e) => {
    if (!settings.scrollSync) return;
    const maxEdit = editor.scrollHeight - editor.clientHeight;
    if (e.deltaY > 0 && maxEdit > 0 && editor.scrollTop >= maxEdit - 1) {
        // 编辑区到底了 → 把这次滚动交给预览区
        previewScroll.scrollTop += e.deltaY;
        e.preventDefault();
    }
}, { passive: false });

editor.addEventListener('scroll', () => {
    // 高亮层要跟着滚（单独一个 listener：滚动同步有回弹抑制，
    // 抑制的时候高亮也得跟）
    syncHlScroll();
    if (syncing || !previewScroll) return;
    // 横向滚动（scrollTop 没变）不该触发纵向同步 ——
    // 编辑区是不折行的（wrap="off"），长行要横滚，
    // 横滚时按比例重置预览区会让预览“跳走”。
    if (editor.scrollTop === lastEditorScrollTop) return;
    lastEditorScrollTop = editor.scrollTop;
    if (isEchoScrollEvent(editor)) return;   // 这是程序自己同步过来的 → 忽略
    if (!settings.scrollSync) return;        // 设置里关掉了同步
    noteScrollDir('editor', editor);
    applyScrollToPreview();
});
// 反向同步：预览区滚动 → 编辑区
previewScroll && previewScroll.addEventListener('scroll', () => {
    if (syncing || !editor) return;
    if (isEchoScrollEvent(previewScroll)) return;  // 这是程序自己同步过来的 → 忽略
    if (!settings.scrollSync) return;        // 设置里关掉了同步
    noteScrollDir('preview', previewScroll);
    applyScrollToEditor();
});

// ============ 预览 HTML 消毒 ============
//
// marked 不做 sanitize：md 里的原始 HTML 会原样进 preview.innerHTML。
// `<script>` 通过 innerHTML 插入不会执行，但 `<img src=x onerror=...>` /
// `<svg onload=...>` **会**执行 —— 而本页面持有 Tauri 的 invoke 权限
// （read_file / write_file 接受任意路径），所以「打开别人给的 .md」
// 就足以读写本机任意文件。写入预览前必须过滤。
//
// 只过滤 marked 的原始输出：KaTeX / Mermaid / 代码高亮都是之后在预览 DOM 上
// 做的改造，它们生成的节点不经过这里，不会被误伤。

const PURIFY_CONFIG = {
    // 常规 HTML + SVG（md 里内嵌图常见）+ MathML
    USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
    // <style>/<form> 用不上：样式走主题，不让文档自己改界面
    FORBID_TAGS: ['style', 'form', 'base', 'link', 'meta'],
    FORBID_ATTR: ['action', 'formaction', 'srcdoc', 'ping'],
    ALLOW_DATA_ATTR: false,
    // 只放行 http/https/mailto/tel + 相对路径与锚点。
    // 默认规则也是这个意思，这里显式写出来，免得升级 DOMPurify 后白名单变宽。
    // data: 图片由 DOMPurify 自己的 DATA_URI_TAGS 处理（img/video/audio），不受影响。
    // ⚠️ 还要放行 **Windows 盘符路径**（`D:/x.png` / `D:\x.png`）：
    //    没有当前文件时插入的图片就是绝对路径，默认规则会把它当“未知协议”干掉
    //    （src 属性直接被删 → 图片空白）。`[a-z]:[\\/]` 只匹配盘符，不影响 javascript:。
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[a-z]:[\\/]|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    // 直接返回 DocumentFragment：省一次「序列化 → 再解析」，长文档快不少
    RETURN_DOM_FRAGMENT: true,
};

/** 消毒 marked 输出，返回可直接 append 的 DocumentFragment */
function sanitizePreview(html) {
    if (window.DOMPurify) return window.DOMPurify.sanitize(html, PURIFY_CONFIG);
    // 兜底：vendor 里的 DOMPurify 没加载时，宁可少渲染也不能执行脚本
    console.warn('[VMD] DOMPurify 未加载，改用降级清理');
    return fallbackSanitize(html);
}

/** DOMPurify 缺失时的最小清理：删危险标签 + 所有 on* 属性 + 危险 scheme */
function fallbackSanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,iframe,object,embed,link,meta,base,form')
        .forEach(n => n.remove());
    for (const el of doc.querySelectorAll('*')) {
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
                el.removeAttribute(attr.name);
            } else if (['href', 'src', 'xlink:href', 'action'].includes(name) &&
                       /^\s*(?:javascript|vbscript|data:text\/html)/i.test(attr.value)) {
                el.removeAttribute(attr.name);
            }
        }
    }
    const frag = document.createDocumentFragment();
    for (const node of Array.from(doc.body.childNodes)) {
        frag.appendChild(document.importNode(node, true));
    }
    return frag;
}

// 上一次渲染的顶层块签名（type + 原始源码）。null = 还没渲染过。
let previewBlockKeys = null;
// 上一次渲染用的源码，没变就什么都不用干
let previewRenderedSource = null;
// 上一次渲染时当前文件所在目录（相对路径图片的解析基准）
let previewRenderedBase = null;
// 本地图片 → data URI 的缓存。key = 基准目录 + \0 + 原始 src
const localImageCache = new Map();
// 缓存上限：data URI 很大（base64 膨胀 1/3），无上限会吃光内存
const LOCAL_IMAGE_CACHE_MAX = 300;
// 正在解析的本地图片数量（导出 PDF 前要等它们转完）
let localImagePending = 0;
let localImageWaiters = [];

/**
 * 在 root 子树里查选择器，root 自己是元素且匹配时也算一个。
 * 增量渲染时 root 可能就是那个块本身（比如一个 <pre>）。
 */
function sel(root, selector) {
    const out = Array.from(root.querySelectorAll(selector));
    if (root.nodeType === 1 && root.matches(selector)) out.unshift(root);
    return out;
}

function renderPreview() {
    const text = editor.value;
    const baseDir = currentBaseDir();
    if (text === previewRenderedSource && previewBlockKeys && baseDir === previewRenderedBase) {
        updateFilename();
        return;
    }
    // [TOC] / [TOCM] 是目录占位符。代码块/行内代码里的不算（应该原样显示）。
    const { text: workText, types: tocTypes, count: tocCount } = replaceTocPlaceholders(text);

    // 先按顶层 token 算"块签名"。这份 tokens 直接喂给 parser，不重复 lexer 一遍。
    const tokens = marked.lexer(workText);
    // 链接引用定义（[a]: url）不产生 DOM，还可能影响别的块的解析 —— 有它就整篇重渲染
    const hasDef = tokens.some(t => t.type === 'def');
    const body = tokens.filter(t => t.type !== 'space' && t.type !== 'def');
    const keys = body.map(t => t.type + '\u0001' + t.raw);
    // 顶层块的行范围表（滚动同步用）：blockLines 与 body / preview.children 一一对应
    blockLines = computeBlockLines(tokens, workText);

    // 找出真正变了的块区间（标准的前缀 + 后缀 diff）
    //
    // ⚠️ 前后缀要**分别**算，不能用「同时递减 pb/qb」那套 ——
    //    块数变了的时候（文档变短、变空、打开另一个文件），
    //    同时递减会拿不同索引的内容互比（错位），判断出来的区间是错的。
    //    后果：新建空文档时会被误判成「内容没变」→ 直接早退 →
    //    预览和目录都留着上一个文件的内容（这个坑踩过）。
    const prevKeys = previewBlockKeys;
    const nk = keys.length;
    const pk = prevKeys ? prevKeys.length : 0;
    // 前缀相同的块数
    let a = 0;
    while (a < nk && a < pk && prevKeys[a] === keys[a]) a++;
    // 后缀相同的块数（不能与前缀重叠）
    let s = 0;
    while (s < nk - a && s < pk - a && prevKeys[pk - 1 - s] === keys[nk - 1 - s]) s++;
    // 变化区间：新的 [a, newEnd]，旧的 [a, oldEnd]（可能为空）
    const newEnd = nk - 1 - s;
    const oldEnd = pk - 1 - s;
    // 旧 DOM 必须还是上次那批块，才敢按索引局部替换
    const canPatch = !!prevKeys && !hasDef && preview.children.length === prevKeys.length;

    if (canPatch && newEnd < a && oldEnd < a) {
        // 一个字都没改到结构：连重排都省了
        previewBlockKeys = keys;
        previewRenderedSource = text;
        previewRenderedBase = baseDir;
        updateFilename();
        return;
    }

    // 只把变了的几块交给 marked / DOMPurify —— 1MB 文档全量解析+消毒要 ~250ms，
    // 改一个字时实际上只需要处理一个块。（marked 顶层 token 之间无上下文依赖，
    // 逐块 parser 拼起来和整篇 parse 完全一致，已验证。）
    let changed = null;
    if (canPatch) {
        const frag = sanitizePreview(marked.parser(body.slice(a, newEnd + 1)));
        changed = [];
        for (let n = frag.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1) changed.push(n);
        }
        // 块数对不上（顶级原始 HTML 展开成多节点）就不敢乱插，回退整篇
        if (changed.length !== newEnd - a + 1) changed = null;
    }

    if (changed) {
        // 先记下插入位置的下一个兄弟，再删旧块（children 会边删边变）
        const ref = preview.children[oldEnd + 1] ? preview.children[oldEnd + 1] : null;
        for (let i = a; i <= oldEnd; i++) {
            const el = preview.children[a];
            if (el) el.remove();
        }
        const insert = document.createDocumentFragment();
        for (const n of changed) insert.appendChild(n);
        preview.insertBefore(insert, ref);
    } else {
        const frag = sanitizePreview(marked.parser(tokens));
        // 只留元素节点：marked 输出里的空白文本节点没有意义，丢掉之后
        // "顶层元素" 才和 "顶层 token" 一一对应（增量替换靠这个索引对齐）。
        changed = [];
        for (let n = frag.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1) changed.push(n);
        }
        preview.replaceChildren(...changed);
    }

    // 后处理只跑变化的那几个块（各函数内部都有 dataset 防重复处理标记，
    // 但 1MB 文档里几千个代码块/文本节点全扫一遍要几百毫秒，没必要）。
    for (const root of changed) {
        renderMermaidBlocks(root);       // 必须在 highlightCodeBlocks 之前——后者会冲掉 language-* class
        highlightCodeBlocks(root);
        replaceEmojiShortcodes(root);
        wrapTables(root);
    }
    resolveLocalImages();              // 本地相对路径图片 → data URI（否则一律加载失败）
    highlightUnmatchedDelimiters(text);   // 从源文本扫描错误写法，映射到 DOM 文本节点标黄（内部先清旧的）
    if (tocCount > 0) renderInlineToc(tocTypes);
    queueMath(changed);
    mapHeadingLines(text);   // 把预览区的标题和源码行号对应起来（目录跳转要精确落行）
    // ⚠️ 目录渲染挪到下一帧 —— 渲染后布局是脏的，renderToc 里任何读布局的操作
    //    都会强制**整个预览**（1MB 文档 = 1.2 万个元素）重新布局 → 几百毫秒 → 卡死。
    //    下一帧浏览器本来就要重排（画面要更新），那时做这些事不额外花钱。
    scheduleTocRender();
    updateFilename();
    previewBlockKeys = keys;
    previewRenderedSource = text;
    previewRenderedBase = baseDir;
    // 预览 DOM 刚变 → 位置表已失效，**立刻标脏**（必须在 followCaretInPreview 之前，
    // 否则它会以为位置还是准的 → 同步测位置 → 强制全局重排 → 卡死）
    anchorsDirty = true;
    updateSelToolbar();   // 换文件后选区没了，浮动工具栏要收起来
    followCaretInPreview();   // 光标所在的内容要能在预览里看见
    // ⚠️ 锚点表 + 位置测量**都不能在输入路径里同步做**：
    //    - 遍历 1.2 万个块建表：几百毫秒
    //    - 测位置会强制整个预览（1.2 万个元素）重新布局：几百毫秒
    //    两者都会把打字卡死。全部挪到下一帧 ——
    //    浏览器那一帧本来就要重排（画面要更新），顺带做不额外花钱。
    scheduleAnchorMeasure();
}

/**
 * 光标跟随：输入后，预览区滚到光标所在的那个块（不在视口内时才动）。
 *
 * 为什么要这个：块级锚点解决的是“滚动时两边对齐”，
 * 但用户**输入**时预览不会自己跟过去 —— 写着写着，预览停在了老地方，
 * 看不到自己刚写的内容（这正是“编辑了但阅读区不在那个区域”）。
 *
 * 只在光标块**完全不在视口内**时才动 —— 用户主动滚去看别处时，
 * 只要光标那块还看得见，就不去打断他。
 */
function followCaretInPreview() {
    if (!settings.followCaret || !previewScroll) return;
    if (!blockLines.length || preview.children.length !== blockLines.length) return;
    // ⚠️ 位置表还没测好（刚渲染完）→ 别在这里同步测位置：
    //    那会强制整个预览（1.2 万个元素）重新布局 → 几百毫秒 → 打字卡死。
    //    下一帧（scheduleAnchorMeasure）测好后会自动跟上。
    if (anchorsDirty) return;
    const { lh } = editorMetrics();
    if (!lh) return;
    // ⚠️ selectionStart 是**字符偏移**，不是行号 —— 用行首表二分查（别 slice 整个前缀）
    const line = lineIndexAtPos(editor.value, editor.selectionStart);
    const k = blockIndexAtLine(line);
    if (k < 0) return;
    const el = preview.children[k];
    if (!el) return;
    // ⚠️ 用锚点表里缓存的位置，**不要**在这里调 getBoundingClientRect ——
    //    渲染后布局是脏的，读它会强制整个预览（1.2 万个元素）重新布局 → 几百毫秒 → 卡死。
    if (anchorsDirty) return;      // 位置表还没测好 → 下一帧再跟随
    ensureAnchorPositions();
    const wrapTop = previewScroll.scrollTop;
    const rTop = elTopInContent(el);
    const rBottom = rTop + (elHeightInContent(el) || 0);
    // 已经能看到这个块 → 不动（别打断用户）
    const visible = rBottom > wrapTop && rTop < wrapTop + previewScroll.clientHeight;
    if (visible) return;
    const target = rTop < wrapTop
        ? rTop - 12
        : rBottom - previewScroll.clientHeight + 12;
    // 被程序设了滚动位置 → 预览接下来的 scroll 事件是回弹，要忽略
    setScrollTop(previewScroll, target);
}

/** 当前 markdown 文件所在目录（本地相对路径图片的解析基准） */
function currentBaseDir() {
    if (!currentFile) return '';
    return currentFile.replace(/[^\\\/]+$/, '');
}

/**
 * 本地图片（相对路径 / file:// ）在预览里加载不出来：
 * 页面 origin 是 `http://tauri.localhost`，WebView2 直接拒掉 `file://` 和 `asset://`。
 * 所以让 Rust 把图片读出来转成 data URI 再塞回 src。
 * - 远程图片（http/https）和已经是 data: 的不动
 * - 有缓存，同一张图不重复读盘
 * - invoke 是异步的，所以图片会晚一拍出现（不影响其它内容）
 */
function resolveLocalImages() {
    const baseDir = currentBaseDir();
    // 一次查全文档：逐块查在大文档上会慢很多（几千个块 = 几千次 querySelectorAll）
    const imgs = preview.querySelectorAll('img');
    const pending = [];
    for (const im of imgs) {
        const src = im.getAttribute('src');
        if (!src || !isLocalImageSrc(src)) continue;
        // 已经试过且失败的不再重复请求（图片可能确实不存在）
        if (im.dataset.vmdImgTried) continue;
        // 相对路径必须有基准目录（当前 markdown 文件所在目录）；
        // **绝对路径不需要** —— 没有当前文件时插入的图片就是绝对路径，
        // 那时候 baseDir 是空的，不能因此把图片整个跳过（会白屏）。
        if (!baseDir && !isAbsoluteImageSrc(src)) continue;
        const key = baseDir + '\u0000' + src;
        const cached = localImageCache.get(key);
        if (cached) {
            im.setAttribute('src', cached);
            continue;
        }
        im.dataset.vmdImgTried = '1';
        // 先换上占位图（原值记在 dataset 里，真读不出来时再还原，让用户看到破图 = 路径有问题）
        im.dataset.vmdImgOrig = src;
        im.setAttribute('src', IMG_PLACEHOLDER);
        pending.push({ img: im, src, key });
    }
    if (!pending.length) return;
    // 同一张图可能出现多次，去重后再问 Rust
    const srcs = [...new Set(pending.map(p => p.src))];
    localImagePending++;
    invoke('read_local_images', { baseDir, srcs }).then(map => {
        for (const p of pending) {
            const uri = map && map[p.src];
            // 渲染期间这个节点可能已经被换掉了
            if (!p.img.isConnected) continue;
            if (uri) {
                if (localImageCache.size >= LOCAL_IMAGE_CACHE_MAX) {
                    localImageCache.clear();   // 简单粗暴：超了就清空
                }
                localImageCache.set(p.key, uri);
                p.img.setAttribute('src', uri);
            } else {
                // 读不出来 → 还原原路径，让浏览器显示破图（提示用户路径有问题）
                p.img.setAttribute('src', p.img.dataset.vmdImgOrig || p.src);
            }
        }
    }).catch(() => {
        // IPC 整个失败 → 也还原
        for (const p of pending) {
            if (p.img.isConnected) p.img.setAttribute('src', p.img.dataset.vmdImgOrig || p.src);
        }
    }).finally(() => {
        localImagePending--;
        if (localImagePending <= 0) {
            localImagePending = 0;
            const ws = localImageWaiters;
            localImageWaiters = [];
            ws.forEach(fn => fn());
        }
    });
}

/** 等所有本地图片转成 data URI（导出 PDF 前要等，否则打印出来是空图） */
function whenLocalImagesReady() {
    if (localImagePending <= 0) return Promise.resolve();
    return new Promise(resolve => localImageWaiters.push(resolve));
}

/** 是不是「本地路径」图片（远程的、data: 的都不算） */
function isLocalImageSrc(src) {
    const s = src.trim();
    if (!s) return false;
    if (/^(?:https?:|data:|blob:)/i.test(s)) return false;
    if (s.startsWith('//')) return false;   // 协议相对 URL
    return true;
}

/** 是不是绝对路径（Windows 盘符 `D:/` 或 `D:\`，或 `/` 开头） */
function isAbsoluteImageSrc(src) {
    return /^[a-zA-Z]:[\\/]/.test(src) || src.startsWith('/');
}

// 1×1 透明 GIF：图片还在等 Rust 读盘时先顶上，
// 免得浏览器去请求 http://tauri.localhost/xxx.png（必然 404，还闪一个破图图标）
const IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// ============ Emoji 短代码（:smile: → 😄）============
// 只在预览里替换，源码保持原样（和 GitHub 一致）。
// 用「渲染后处理」而不是 marked 扩展 —— 扩展会先于行内代码匹配，
// 把 `` `:smile:` `` 里的也换掉。
function replaceEmojiShortcodes(root = preview) {
    const table = window.VMD_EMOJI;
    if (!table) return;
    const has = (name) => Object.prototype.hasOwnProperty.call(table, name);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            const p = node.parentElement;
            if (!p) return NodeFilter.FILTER_REJECT;
            const tag = p.tagName;
            // 代码块 / 行内代码 / 脚本 / 样式里的不动
            if (tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
            if (p.closest('.code-block-header')) return NodeFilter.FILTER_REJECT;
            if (node.nodeValue.indexOf(':') < 0) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
        const text = node.nodeValue;
        let hit = false;
        const frag = document.createDocumentFragment();
        let last = 0;
        text.replace(/:([a-zA-Z0-9_+-]+):/g, (m, name, idx) => {
            if (!has(name)) return m;
            hit = true;
            frag.appendChild(document.createTextNode(text.slice(last, idx)));
            const span = document.createElement('span');
            span.className = 'emoji-char';
            span.title = m;
            span.textContent = table[name];
            frag.appendChild(span);
            last = idx + m.length;
            return m;
        });
        if (!hit) continue;
        frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }
}

// 找出文本中所有“代码区域”的字符范围：[围栏代码块] + [行内代码]
function findCodeRanges(text) {
    const ranges = [];
    // 围栏代码块：``` ... ``` 或 ~~~ ... ~~~
    const fenceRe = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/g;
    let m;
    while ((m = fenceRe.exec(text))) {
        ranges.push([m.index, m.index + m[0].length]);
    }
    // 行内代码：`...`（跳过落在围栏块里的）
    const inlineRe = /(`+)([^\n]*?)\1/g;
    while ((m = inlineRe.exec(text))) {
        const inFence = ranges.some(r => m.index >= r[0] && m.index < r[1]);
        if (!inFence) ranges.push([m.index, m.index + m[0].length]);
    }
    return ranges;
}

// 把代码区域之外的 [TOC] / [TOCM] 替换为占位符
function replaceTocPlaceholders(text) {
    const codeRanges = findCodeRanges(text);
    const types = [];
    let out = '';
    let last = 0;
    const re = /\[\s*TOC(M)?\s*\]/gi;
    let mm;
    while ((mm = re.exec(text))) {
        const inCode = codeRanges.some(r => mm.index >= r[0] && mm.index < r[1]);
        if (inCode) continue;   // 代码里的保持原样
        out += text.slice(last, mm.index);
        out += '\n\nVMDPLACEHOLDERTOCEND\n\n';
        types.push(mm[1] ? 'tocm' : 'toc');
        last = mm.index + mm[0].length;
    }
    out += text.slice(last);
    return { text: out, types, count: types.length };
}

// 把预览里的 [TOC] 占位符换为实际的目录 HTML
function renderInlineToc(placeholderTypes) {
    // 找所有占位符段落，根据标记区分 [TOC] 层级式 vs [TOCM] 列表式
    const ps = Array.from(preview.querySelectorAll('p'));
    let typeIdx = 0;
    for (const p of ps) {
        if (p.children.length === 0 && p.textContent.trim() === 'VMDPLACEHOLDERTOCEND') {
            const type = placeholderTypes[typeIdx++] || 'toc';
            const html = type === 'tocm' ? buildTocHtmlFlat() : buildTocHtml();
            const container = document.createElement('div');
            container.className = 'inline-toc' + (type === 'tocm' ? ' inline-toc-min' : '');
            container.innerHTML = html;
            p.replaceWith(container);
        }
    }
}

// 从当前 preview DOM 里的 h1-h6 生成层级缩进目录 HTML
// 重要：<ul> 必须嵌套在 <li> 里，不能作 <li> 的兄弟。否则浏览器会把 <ul> 提前闭合，导致层级丢失。
function buildTocHtml() {
    const headings = Array.from(preview.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    if (headings.length === 0) {
        return '<p style="color:var(--text-dim);font-size:13px;">(无标题)</p>';
    }
    // 先补 id
    const seen = new Set();
    for (const h of headings) {
        if (!h.id) {
            let id = 'h-' + seen.size + '-' + slugify(h.textContent);
            while (seen.has(id)) id = id + '-' + seen.size;
            h.id = id;
            seen.add(id);
        }
    }

    let html = '';
    let lastLevel = 0;
    let liOpen = false;     // 是否有未关的 <li>

    for (const h of headings) {
        const level = parseInt(h.tagName.charAt(1));
        const lvlDiff = level - lastLevel;

        if (lvlDiff > 0) {
            // 升级：在当前 <li> 内打开 <ul>，再开新 <li>
            // 先关上一项 <li>（如果有），再嵌一个 <ul>，再开新 <li>
            if (liOpen) { html += '</li>'; liOpen = false; }
            for (let i = 0; i < lvlDiff; i++) html += '<ul>';
            html += `<li class="lvl${level}"><a href="#${h.id}">${escHTML(h.textContent)}</a>`;
            liOpen = true;
        } else if (lvlDiff < 0) {
            // 降级：关当前 <li>，闭 N 层 </ul>，开新 <li>
            if (liOpen) { html += '</li>'; liOpen = false; }
            for (let i = 0; i < -lvlDiff; i++) html += '</ul>';
            html += `<li class="lvl${level}"><a href="#${h.id}">${escHTML(h.textContent)}</a>`;
            liOpen = true;
        } else {
            // 同级：关当前 <li>，开新 <li>
            if (liOpen) { html += '</li>'; liOpen = false; }
            html += `<li class="lvl${level}"><a href="#${h.id}">${escHTML(h.textContent)}</a>`;
            liOpen = true;
        }
        lastLevel = level;
    }
    // 关剩余
    if (liOpen) { html += '</li>'; liOpen = false; }
    for (let i = 0; i < lastLevel; i++) html += '</ul>';
    return html;
}

// 从当前 preview DOM 里的 h1-h6 生成扁平目录 HTML（仅一级，纯编号）
function buildTocHtmlFlat() {
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length === 0) {
        return '<p style="color:var(--text-dim);font-size:13px;">(无标题)</p>';
    }
    const seen = new Set();
    let html = '<ol class="inline-toc-list flat">';
    for (const h of headings) {
        if (!h.id) {
            let id = 'h-' + seen.size + '-' + slugify(h.textContent);
            while (seen.has(id)) id = id + '-' + seen.size;
            h.id = id;
        }
        seen.add(h.id);
        html += `<li class="lvl${parseInt(h.tagName.charAt(1))}"><a href="#${h.id}">${escHTML(h.textContent)}</a></li>`;
    }
    html += '</ol>';
    return html;
}

function escHTML(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 属性值转义（拼 HTML 字符串时用，比 escHTML 多处理引号） */
function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============ KaTeX 数学公式 ============
let katexReady = false;
// 待渲染 KaTeX 的顶层块。增量渲染下只需要处理变动的块，
// 1MB 文档全量跑一次 auto-render 要 ~600ms。
let mathQueue = [];
let mathRafPending = false;
const KATEX_AUTO_OPTS = {
    delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false },
        { left: '\\[', right: '\\]', display: true },
    ],
    throwOnError: false,
    errorColor: '#cc0000',
    ignoredClasses: ['md-unmatched'],
};
function ensureKatex() {
    if (katexReady) return Promise.resolve();
    if (!window.renderMathInElement) return Promise.reject('katex not loaded');
    if (katexReady) return Promise.resolve();
    katexReady = true;
    return Promise.resolve();
}
// 没有公式定界符就整段跳过。KaTeX 的 auto-render 要把预览里所有文本节点
// 走一遍，长文档白跑一次就是几百毫秒（1MB 文档实测多花约 600ms）。
const MATH_FENCE_RE = /^[ 	]*(?:```|~~~)[ 	]*(?:latex|math|tex|katex)\b/m;
function hasMathSyntax(src) {
    if (src.indexOf('$') >= 0 || src.indexOf('\(') >= 0 || src.indexOf('\[') >= 0) return true;
    return MATH_FENCE_RE.test(src);
}

// roots = 这次重新渲染的顶层块；不传就是整篇预览
function queueMath(roots) {
    if (!window.renderMathInElement || !preview) return;
    if (!hasMathSyntax(editor.value)) {
        mathQueue = [];
        return;
    }
    for (const n of (roots && roots.length ? roots : [preview])) mathQueue.push(n);
    if (mathRafPending) return;
    mathRafPending = true;
    requestAnimationFrame(() => {
        mathRafPending = false;
        const list = mathQueue;
        mathQueue = [];
        try {
            for (const root of list) {
                // 排队期间又被替换掉的块直接跳过（新块会被重新排队）
                if (!root.isConnected) continue;
                window.renderMathInElement(root, KATEX_AUTO_OPTS);
            }
            // 处理 ```latex / ```math / ```tex 代码块：当作块级数学公式渲染
            renderLatexBlocks();
        } catch (e) {
            console.warn('KaTeX render error:', e);
        }
    });
}

// ```latex / ```math / ```tex 代码块：当作数学公式渲染
function renderLatexBlocks() {
    if (!window.katex) return;
    const codes = preview.querySelectorAll('pre code.language-latex, pre code.language-math, pre code.language-tex, pre code.language-katex');
    codes.forEach(code => {
        if (code.dataset.latexRendered) return;
        const pre = code.parentNode;
        const source = code.textContent.trim();
        const container = document.createElement('div');
        container.className = 'math-block';
        try {
            window.katex.render(source, container, { displayMode: true, throwOnError: false, errorColor: '#cc0000' });
        } catch (e) {
            container.replaceChildren(renderErrorBox('KaTeX', e.message, source));
        }
        pre.parentNode.replaceChild(container, pre);
        code.dataset.latexRendered = '1';
    });
}

// ============ Mermaid 图表 ============
// 老式 flowchart 语法转新语法（Mermaid v10+ 只支持新语法）
function convertOldFlowchart(src) {
    const lines = src.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('%%'));
    const nodeMap = {};  // id -> { type, text }
    const edges = [];
    for (const line of lines) {
        // 节点定义：id=>type: text
        const decl = line.match(/^(\w+)\s*=>\s*(start|end|operation|inputoutput|condition|subroutine)\s*:\s*(.+)$/i);
        if (decl) {
            nodeMap[decl[1]] = { type: decl[2].toLowerCase(), text: decl[3].trim() };
            continue;
        }
        // 边：id1->id2 、 id1(label)->id2 、 id1->id2->id3 (链式)
        const edge = line.match(/^(\w+)(?:\(([^)]+)\))?\s*(->|-->|->>)\s*(.+)$/);
        if (edge) {
            const [, from, label, , rest] = edge;
            // 拆链式：st->op->cond → st->op, op->cond
            const chain = rest.split(/\s*(?:->|-->|->>)\s*/).filter(Boolean);
            let prev = from;
            for (const next of chain) {
                if (label && next === chain[chain.length - 1]) {
                    edges.push(`    ${prev} -- ${label} --> ${next}`);
                } else {
                    edges.push(`    ${prev} --> ${next}`);
                }
                prev = next;
            }
            continue;
        }
    }
    // 生成节点定义
    const defs = [];
    for (const id in nodeMap) {
        const { type, text } = nodeMap[id];
        let node;
        switch (type) {
            case 'start':
            case 'end':        node = `    ${id}(["${text}"])`; break;
            case 'condition':  node = `    ${id}{"${text}"}`; break;
            case 'subroutine': node = `    ${id}[["${text}"]]`; break;
            default:           node = `    ${id}["${text}"]`;
        }
        defs.push(node);
    }
    return 'flowchart TD\n' + defs.join('\n') + '\n' + edges.join('\n');
}

let mermaidReady = false;
let mermaidCounter = 0;
// 从 App 的 CSS 变量取色，生成 Mermaid 的 themeVariables
// 这样图表的线条/文字/节点颜色和当前主题完全一致（深色主题下也能看清）
function mermaidThemeVars() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => {
        const val = cs.getPropertyValue(name).trim();
        return val || fallback;
    };
    const bg        = v('--bg', '#ffffff');
    const panel     = v('--bg-panel', '#eeeeee');
    const elevated  = v('--bg-elevated', '#eeeeee');
    const border    = v('--border', '#cccccc');
    const text      = v('--text', '#000000');
    const textStrong= v('--text-strong', '#000000');
    const textDim   = v('--text-dim', '#888888');
    const accent    = v('--accent', '#58a6ff');
    return {
        // 基础
        background:      bg,
        primaryColor:    elevated,
        primaryTextColor:textStrong,
        primaryBorderColor: border,
        secondaryColor:  panel,
        secondaryTextColor: text,
        secondaryBorderColor: border,
        tertiaryColor:   panel,
        tertiaryTextColor: text,
        tertiaryBorderColor: border,
        lineColor:       textDim,
        textColor:       text,
        titleColor:      textStrong,
        edgeLabelBackground: bg,
        // 流程图
        mainBkg:         elevated,
        nodeBorder:      border,
        nodeTextColor:   textStrong,
        clusterBkg:      panel,
        clusterBorder:   border,
        defaultRenderer: 'dagre-wrapper',
        // 序列图
        actorBkg:        elevated,
        actorBorder:     border,
        actorTextColor:  textStrong,
        actorLineColor:  textDim,
        signalColor:     text,
        signalTextColor: textStrong,
        labelBoxBkgColor: elevated,
        labelBoxBorderColor: border,
        labelTextColor:  text,
        loopTextColor:   text,
        activationBkgColor: elevated,
        activationBorderColor: border,
        noteBkgColor:    elevated,
        noteTextColor:   text,
        noteBorderColor: border,
        // 饼图 / 其它
        pie1: accent, pie2: v('--link', '#58a6ff'),
        pie3: '#d29922', pie4: '#3fb950', pie5: '#a371f7',
        pie6: '#db6d28', pie7: '#db61a2', pie8: '#39c5cf',
        pie9: '#8b949e', pie10: '#7ee787', pie11: '#ffa657', pie12: '#79c0ff',
        // 字体
        fontFamily:      'inherit',
        fontSize:        '14px',
    };
}
let currentMermaidTheme = null;
function ensureMermaid(theme) {
    if (!window.mermaid) return Promise.reject('mermaid not loaded');
    const want = theme || currentAppTheme;
    if (mermaidReady && currentMermaidTheme === want) return Promise.resolve();
    mermaidReady = true;
    currentMermaidTheme = want;
    try {
        window.mermaid.initialize({
            startOnLoad: false,
            theme: 'base',                 // base 主题不覆盖 themeVariables
            themeVariables: mermaidThemeVars(),
            // strict：禁掉图里的 click 事件和 HTML 标签。md 文件可能来自别人，
            // loose 下 `click A href "..."` 能把链接塞进预览，而预览 DOM 已经过消毒，
            // 这里再插入的内容 DOMPurify 不会再管。代价：节点文本里的 <br> 会显示成字面量。
            securityLevel: 'strict',
            fontFamily: 'inherit',
        });
    } catch (e) {
        console.warn('mermaid init error:', e);
    }
    return Promise.resolve();
}

// 主题切换后：重新渲染所有 Mermaid 图
function rerenderMermaid() {
    if (!window.mermaid) return;
    const blocks = Array.from(preview.querySelectorAll('.mermaid-block'));
    if (blocks.length === 0) return;
    const want = currentAppTheme;
    if (currentMermaidTheme === want) return;
    ensureMermaid(want).then(() => {
        blocks.forEach(container => {
            const source = container.dataset.mermaidSource;
            if (!source) return;
            const id = 'mermaid-' + (++mermaidCounter);
            window.mermaid.render(id + '-svg', source)
                .then(({ svg }) => { container.innerHTML = svg; })
                .catch(e => {
                    container.replaceChildren(renderErrorBox('Mermaid', e.message, ''));
                });
        });
    });
}
// 已知关键字：跳过这些的都是"无头"的代码块
const MERMAID_KNOWN_KEYWORDS = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|gantt|pie|erDiagram|journey|gitGraph|timeline|sankey-beta|quadrantChart|requirementDiagram|C4Context|mindmap|zenuml)/i;
// 老式 flowchart 语法检测（id=>type: text）
const MERMAID_OLD_FLOW_SYNTAX = /^\s*\w+\s*=>\s*(start|end|operation|inputoutput|condition|subroutine)\s*:/im;

/** 把 mermaid 源码整理成能渲染的样子（预览和导出共用，保证两边一致） */
function normalizeMermaidSource(source) {
    source = source.replace(/\\n/g, '<br/>').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    if (MERMAID_OLD_FLOW_SYNTAX.test(source)) {
        source = convertOldFlowchart(source);
    } else if (!MERMAID_KNOWN_KEYWORDS.test(source)) {
        // 检测序列图特征：-> / -> / --> / -- / Note
        if (/^\s*\w+\s*(->|-->|->>|-->>|--)\s*\w+/m.test(source) || /^\s*Note\b/m.test(source)) {
            source = 'sequenceDiagram\n' + source.trim();
        }
    }
    return source;
}

/**
 * KaTeX / Mermaid 渲染失败的提示块。
 *
 * 错误信息和图/公式源码**都可能包含用户写的 HTML** —— 必须用 textContent 插，
 * 用 `innerHTML = '...' + e.message + source` 会让 `<img src=x onerror=...>`
 * 真的执行（这些是消毒之后的 DOM，DOMPurify 不会再过滤一遍）。
 */
function renderErrorBox(what, msg, source) {
    const pre = document.createElement('pre');
    pre.className = 'render-error';
    pre.textContent = what + ' 渲染失败：' + (msg || '') + (source ? '\n\n' + source : '');
    return pre;
}

function renderMermaidBlocks(root = preview) {
    if (!window.mermaid) return;
    // 支持 mermaid、seq、flow、sequence、diagram 作为代码块语言别名
    const codes = sel(root, 'pre code.language-mermaid, pre code.language-seq, pre code.language-flow, pre code.language-sequence, pre code.language-diagram');
    codes.forEach(code => {
        if (code.dataset.mermaidRendered) return;
        const source = normalizeMermaidSource(code.textContent);
        const pre = code.parentNode;
        const id = 'mermaid-' + (++mermaidCounter);
        const container = document.createElement('div');
        container.className = 'mermaid-block';
        container.id = id;
        container.textContent = source;
        container.dataset.mermaidSource = source;   // 主题切换时按新主题重渲染
        pre.parentNode.replaceChild(container, pre);
        ensureMermaid().then(() => {
            return window.mermaid.render(id + '-svg', source);
        }).then(({ svg }) => {
            container.innerHTML = svg;
            container.dataset.mermaidRendered = '1';
        }).catch(e => {
            container.replaceChildren(renderErrorBox('Mermaid', e.message, source));
            container.dataset.mermaidRendered = '1';
        });
    });
}

// 扫描 preview 文本节点，找出“没能渲染成 <strong>/<em> 的 **..** / *..* 残模式”，包上高亮提示。
// CommonMark 要求 ** 紧贴内容，有空格就不形成粗体。这里把这类错误用黄色背景标出，鼠标悬停说明原因。
// 从源 markdown 文本扫描 **..** / *..* 残模式，在 preview 文本节点里包上黄色高亮提示。
// 注意：marked 会去掉 \* 转义的反斜杠，DOM 里看不到 \\，所以从 DOM 扫描会出现误报。
// 策略：从源文本记录错误位置，再映射到 preview 文本节点标黄。
function highlightUnmatchedDelimiters(sourceText) {
    // 先清掉之前的高亮
    preview.querySelectorAll('.md-unmatched').forEach(el => {
        const t = document.createTextNode(el.textContent);
        el.parentNode.replaceChild(t, el);
    });
    if (!sourceText) return;

    // 在源文本里找 **..** / *..* / ~~..~~，只看那些“不紧贴”的
    // （删除线是 GFM 扩展，规则一样：~~ 紧贴内容才能生效）
    const patterns = [
        { re: /(?<!\\)(~~)([^~\n]+?)\1(?!\\)/g, label: '~~' },
        { re: /(?<!\\)(\*\*?)([^*\n]+?)\1(?!\\)/g, label: null },   // label=null 时按长度区分 ** / *
    ];
    const errRanges = [];   // [{ start, end, delim }]
    for (const p of patterns) {
        p.re.lastIndex = 0;
        let m;
        while ((m = p.re.exec(sourceText))) {
            const delim = m[1];
            const inner = m[2];
            if (!inner) continue;
            const startPos = m.index;
            // CommonMark 规则：delimiter 必须紧贴内容，即 inner 的首尾都不能有空白
            // - **text **  → inner 末尾有空格 → 不成粗体（错误写法）
            // - ** text**  → inner 开头有空格 → 不成粗体（错误写法）
            // - **text**   → 紧贴 → 正常
            // 注意：delim 前面有空格是允许的（如 "- **左侧**：..."），不是错误
            const innerStartSpace = /^\s/.test(inner);
            const innerEndSpace = /\s$/.test(inner);
            if (innerStartSpace || innerEndSpace) {
                errRanges.push({ start: startPos, end: startPos + m[0].length, delim: delim });
            }
        }
    }

    if (errRanges.length === 0) return;

    // 把源文字范围映射到 preview 文本节点
    // preview 内的文本节点顺序与源文本大致一致（marked 一行 → 一段，**bold** → <strong>bold</strong>）
    // 我们用 preview 的全文，逐字符对照源
    const previewText = preview.textContent;   // 包括 <strong>/<em> 等子节点
    // 简化：用 previewText 找 errRange 的文字（去 ** 后的子串）—— 不严谨，但实际只需要标出哪个节点
    // 更可靠：直接拿 sourceText 的 errRange，对应到 preview 的文本节点
    // 用最简单的做法：对每个 errRange，找到 preview 内含该子串的文本节点
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            let p = node.parentNode;
            while (p && p !== preview) {
                const tag = p.tagName;
                if (tag === 'CODE' || tag === 'PRE' || tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
                // 跳过已被 marked 正确渲染为粗/斜体/删除线的文本（不该报黄）
                if (tag === 'STRONG' || tag === 'EM' || tag === 'DEL') return NodeFilter.FILTER_REJECT;
                p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    const textNodes = [];
    let n;
    while ((n = walker.nextNode())) textNodes.push(n);

    // 对每个 errRange，在 preview 的文本节点里找对应的全文
    for (const range of errRanges) {
        const snippet = sourceText.slice(range.start, range.end);   // e.g. "**WebView **"
        const d = range.delim.length;
        const inner = snippet.slice(d, snippet.length - d);        // 去掉 delimiter
        if (!inner) continue;
        for (const tn of textNodes) {
            const text = tn.textContent;
            // 跳过已被标过的
            if (tn.parentNode && tn.parentNode.classList && tn.parentNode.classList.contains('md-unmatched')) continue;
            // 优先匹配完整 snippet（marked 原样输出未渲染的 **..**）
            const idx = text.indexOf(snippet);
            if (idx >= 0) {
                wrapWithUnmatched(tn, idx, snippet, range.delim);
                break;
            }
            // 退而求其次：匹配 inner（去掉 delimiter 后的文字）
            const idx2 = text.indexOf(inner);
            if (idx2 >= 0) {
                wrapWithUnmatched(tn, idx2, inner, range.delim);
                break;
            }
        }
    }
}

function wrapWithUnmatched(textNode, start, middle, delim) {
    const text = textNode.textContent;
    const end = start + middle.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const span = document.createElement('span');
    span.className = 'md-unmatched';
    span.textContent = middle;
    span.title = delim === '~~'
        ? '~~ 紧贴内容才能形成删除线（GFM 规则）'
        : (delim.length === 2
            ? '** 紧贴内容才能形成粗体（CommonMark 规则）'
            : '* 紧贴内容才能形成斜体（CommonMark 规则）');
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    textNode.parentNode.replaceChild(frag, textNode);
}

/**
 * 扫描源码里的标题，返回 [{ level, text, line }]
 * 用来把"预览区的标题"和"编辑器里的行号"对应起来 —— 目录跳转时能精确落到那一行。
 * 尽量按 CommonMark 的规则来（跳过代码块、认出 ATX / setext、剥掉引用和列表前缀）。
 */
function scanHeadings(text) {
    const lines = text.split('\n');
    const out = [];
    let inFence = false;
    let fenceChar = '';
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        // 围栏代码块（``` 或 ~~~）
        const fence = trimmed.match(/^(`{3,}|~{3,})/);
        if (fence) {
            if (!inFence) {
                inFence = true;
                fenceChar = fence[1][0];
            } else if (fence[1][0] === fenceChar) {
                inFence = false;
            }
            continue;
        }
        if (inFence) continue;
        if (/^ {4,}/.test(raw)) continue;        // 缩进 4 空格 = 代码块
        // 剥掉引用块 / 列表项前缀（标题在引用或列表里也算标题）
        let content = trimmed.replace(/^>\s*/, '').replace(/^([-*+]|\d+[.)])\s+/, '');
        if (!content) continue;
        // ATX：# ~ ######
        const atx = content.match(/^(#{1,6})\s+(.*?)\s*#*$/);
        if (atx) {
            out.push({ level: atx[1].length, text: atx[2], line: i });
            continue;
        }
        // setext：标题行 + 下一行是 === 或 ---
        const next = (lines[i + 1] || '').trim();
        if (content && /^(=+|-+)\s*$/.test(next) && !/^[-*+]\s/.test(content)) {
            out.push({ level: next[0] === '=' ? 1 : 2, text: content, line: i });
        }
    }
    return out;
}

/** 标题文本归一化：去掉 markdown 标记，方便和渲染后的标题文字比对 */
function normalizeHeadingText(s) {
    return String(s)
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]*)\*\*/g, '$1')
        .replace(/\*([^*]*)\*/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 渲染后：把预览区的每个标题和源码行号对应起来 */
let headingLines = new Map();   // heading 元素 → 源码行号
let headingPairs = [];         // [{line, el}]：源码标题 ↔ 预览元素，按文档顺序

function mapHeadingLines(sourceText) {
    headingLines = new Map();
    // ⚠️ 用**一份有序数组**（源码标题 ↔ 预览元素，按文档顺序），
    //    不要搞“两套映射”（源码列表 + 反向表）—— 两套会各自错位，
    //    表现为“编辑区和预览区差一节”。
    headingPairs = [];
    const src = scanHeadings(sourceText);
    const doms = Array.from(preview.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    let si = 0;
    for (let di = 0; di < doms.length; di++) {
        const h = doms[di];
        const level = parseInt(h.tagName.charAt(1));
        const text = normalizeHeadingText(h.textContent);
        // 按顺序往后找：层级和文字都要对得上
        for (let k = si; k < src.length; k++) {
            if (src[k].level === level && normalizeHeadingText(src[k].text) === text) {
                headingLines.set(h, src[k].line);
                // domIndex = 这个标题在“预览所有标题”里的位置
                // （配对失败时 headingPairs 会少项，不能拿它的索引去取目录项）
                headingPairs.push({ line: src[k].line, el: h, domIndex: di });
                si = k + 1;
                break;
            }
        }
    }
}

/**
 * 当前章节 = 视口里按**滚动方向**取的那一端。
 * @param dir 滚动方向（默认用预览区自己最近一次的方向）
 */
function currentHeadingElement(dir) {
    if (!previewScroll || !headingPairs.length) return null;
    const items = visibleHeadingsPreview();
    if (!items.length) return null;
    const anchor = pickAnchor(items, dir !== undefined ? dir : scrollDir.preview);
    return anchor ? anchor.el : null;   // 返回 DOM 元素（不是 headingPairs 里的对象）
}

/** 编辑区顶行（当前光标位置所在的那一行） */
function editorTopLine() {
    const { lh, padTop } = editorMetrics();
    if (!lh) return 0;
    return Math.floor((editor.scrollTop - padTop) / lh);
}

// 记录“两边当前对齐到哪一节”（目录高亮用它）。
// ⚠️ 必须是**同步的锚点**，不能拿“编辑区顶行所属的章节”当真相 ——
//    锚点是按滚动方向取的，和顶行所属可能差一节（编辑区向上滚时尤其明显）。
let alignedIdx = -1;

/**
 * 目录高亮跟**当前对齐位置的章节**走。
 * 两边同步后对齐的是同一个位置 → 目录高亮和预览内容必然对得上。
 */
function updateAlignedChapter() {
    // 对齐位置的章节 = 编辑区顶行所属的章节
    // （编辑区和预览区是同步的，顶行变了就是章节变了）
    const k = headingIndexAtLine(editorTopLine());
    if (k >= 0) alignedIdx = k;
    updateTocHighlight();
}

function updateTocHighlight() {
    if (!previewScroll) return;
    const pair = alignedIdx >= 0 ? headingPairs[alignedIdx] : null;
    if (!pair) return;
    const id = pair.el.id;
    if (id === tocActiveId) return;   // 章节没变就别动 DOM（滚动时一帧一次）
    tocActiveId = id;
    // 只改「上一项 + 这一项」，不要遍历整个目录 —— 5000 项全写一次 style
    // 会触发整条目录重排，实测几百毫秒。
    const prev = tocList.querySelector('.toc-item.active');
    if (prev) prev.classList.remove('active');
    // 目录项按预览里标题的顺序排（用 domIndex，配对失败也不会错位）
    const next = tocList.children[pair.domIndex];
    if (next && next.classList && next.classList.contains('toc-item')) next.classList.add('active');
}

/** 源码的某一行属于哪个标题（向上找最近的标题） */
function headingIndexAtLine(line) {
    let k = -1;
    for (let i = 0; i < headingPairs.length; i++) {
        if (headingPairs[i].line <= line) k = i;
        else break;
    }
    return k;
}

// 滚动方向（决定取视口里哪一端的节点做锚点）
//   >0 = 往下滚（内容往上走 → 回看上面的内容）→ 取视口里**最靠上**的
//   <0 = 往上滚（内容往下走 → 在看新冒出来的内容）→ 取视口里**最靠下**的
const scrollDir = { editor: 0, preview: 0 };
// 程序同步引起的滚动 —— 那一侧的 scroll 事件要忽略（它不是用户在滚）。
//
// ⚠️ **必须用“位置匹配”，不能用标志位 + 定时清零**：
//    定时器会在 scroll 事件**之前**执行 → 回弹没被抑制 → 反向同步把位置拽回去
//    → “往下滚动滚动不了”（踩过）。
//    纯位置匹配：程序设了哪个位置，之后落在那个位置上的 scroll 事件才算回弹。
//    用户滚动的位置几乎不会正好等于它 → 不会误伤。
let pendingEcho = [];   // [{el, pos}]

/**
 * 程序设置滚动位置 —— 顺带把“这一侧接下来那个 scroll 事件是回弹”标记上。
 * 下一帧的 scroll 事件会被忽略（它不是用户在滚）。
 * ⚠️ 用 setTimeout(0) 解锁：scroll 事件在同一帧的“渲染前”派发，
 *    宏任务在渲染之后 → 顺序是对的。
 */
function setScrollTop(el, pos) {
    const before = el.scrollTop;
    el.scrollTop = pos;
    if (el.scrollTop === before) return;      // 没动 → 不会有 scroll 事件
    pendingEcho.push({ el, pos: el.scrollTop });
    if (pendingEcho.length > 12) pendingEcho.shift();
}

/** 这个 scroll 事件是不是程序同步引起的回弹？是的话吃掉它并返回 true */
function isEchoScrollEvent(el) {
    for (let i = pendingEcho.length - 1; i >= 0; i--) {
        const p = pendingEcho[i];
        if (p.el === el && Math.abs(el.scrollTop - p.pos) < 2) {
            pendingEcho.splice(i, 1);     // 一次性消费
            return true;
        }
    }
    return false;
}
const lastScrollPos = { editor: 0, preview: 0 };

/** 记下这次的滚动方向（回弹事件不算 —— 那是程序自己弄的） */
function noteScrollDir(side, el) {
    const pos = el.scrollTop;
    const d = pos - lastScrollPos[side];
    lastScrollPos[side] = pos;
    if (d !== 0) scrollDir[side] = d > 0 ? 1 : -1;
}

/** 预览区视口里可见的标题 */
function visibleHeadingsPreview() {
    if (!previewScroll) return [];
    const wr = previewScroll.getBoundingClientRect();
    const out = [];
    for (const p of headingPairs) {
        const r = p.el.getBoundingClientRect();
        if (r.bottom > wr.top && r.top < wr.bottom) out.push(p);
    }
    return out;
}

/** 编辑区视口里可见的标题（按源码行算） */
function visibleHeadingsEditor() {
    const { lh, padTop } = editorMetrics();
    if (!lh) return [];
    const top = (editor.scrollTop - padTop) / lh;
    const bot = (editor.scrollTop - padTop + editor.clientHeight) / lh;
    return headingPairs.filter(p => p.line >= top - 1 && p.line <= bot);
}

/**
 * 从可见的标题里挑一个当锚点 —— **挑哪一端取决于滚动方向**：
 *   往下滚（回看上面的内容）→ 取最靠上的
 *   往上滚（在看新冒出来的内容）→ 取最靠下的
 * 这样两边对齐的始终是“用户此刻正在看的那部分”，而不是“视口最上面那个”。
 */
function pickAnchor(items, dir) {
    if (!items.length) return null;
    return dir >= 0 ? items[0] : items[items.length - 1];
}

/** 编辑区一行的像素高度（不折行时，行高固定，scrollTop = 行号 × 行高） */
let editorLineHeight = 0;
/** 编辑区的顶部内边距（滚动原点要减掉它，见 editorMetrics） */
let editorPadTop = 0;
/**
 * 重新量编辑区的行高和内边距。
 * 只在**会影响排版**的时候调用（缩放、窗口尺寸变化、启动时）——
 * 别的场合一律用缓存值，别去 getComputedStyle（会触发样式重算 / 强制重排）。
 */
function refreshEditorLineHeight() {
    const cs = getComputedStyle(editor);
    const lh = parseFloat(cs.lineHeight);
    editorLineHeight = isNaN(lh) ? 16 : lh;
    editorPadTop = parseFloat(cs.paddingTop) || 0;
}

/** 把编辑区精确滚动到第 line 行（0 起） */
function scrollEditorToLine(line) {
    // ⚠️ 每次都刷新行高 —— 文字缩放会改行高，用旧值算出来的位置是错的
    //    （缓存只在启动时刷新过一次，缩放后就过期了）
    refreshEditorLineHeight();
    const cs = getComputedStyle(editor);
    const padTop = parseFloat(cs.paddingTop) || 0;   // 滚动的原点是 padding 顶边，要补上
    // ⚠️ **向上取整**：行高是小数（如 22.95），算出来的位置会被浏览器量化，
    //    少零点几像素就落在**上一行** → 章节判定差一节（实测踩过）。
    setScrollTop(editor, Math.ceil(line * editorLineHeight + padTop));
}

// 上一次渲染目录时的「标题结构」签名。每次输入都会重跑 renderPreview()，
// 但大多数时候标题根本没变（只是正文多了几个字）—— 这时重建 #toc 的 DOM
// 只会带来闪烁和滚动位置丢失，也就是打字时目录"抖"的原因。
let tocSignature = null;   // null 而非 ''：空文档的签名也是 ''，得能区分「还没渲染过」
// 当前高亮的目录项 id（updateTocHighlight 用，定义在文件末尾）
let tocActiveId = '';

/** 目录最多列这么多项（再多就没法看了，而且建 DOM 的时间会大到影响手速） */
const TOC_MAX_ITEMS = 2000;

/** 目录项点击 —— 事件委托（目录可能有上万个节点，逐个 addEventListener 太贵） */
function onTocItemClick(e) {
    const div = e.target && e.target.closest ? e.target.closest('.toc-item') : null;
    if (!div) return;
    const previewWrap = document.getElementById('preview-wrap');
    if (!previewWrap) return;
    // ⚠️ 目录可能没有跟着重建（标题没变时被跳过），而预览 DOM 每次都是新的 ——
    //    必须按 id 从当前预览里重新查，不能依赖任何捕获的元素。
    const target = document.getElementById(div.dataset.id);
    if (!target) return;
    // 锁住自动同步，防止 smooth scroll 的中间帧把编辑区拽回原位
    syncing = true;
    const top = target.getBoundingClientRect().top - previewWrap.getBoundingClientRect().top + previewWrap.scrollTop - 12;
    previewWrap.scrollTo({ top, behavior: 'smooth' });
    // 编辑区精确落到对应的那一行（行号由 syncTocLines() 维护，从 dataset 读最新的）
    const line = parseInt(div.dataset.line, 10);
    if (!isNaN(line)) scrollEditorToLine(line);
    // 跳转结束后解锁。这里不能再按比例同步一次 —— 那会把精确位置冲掉。
    let finished = false;
    const done = () => {
        if (finished) return;
        finished = true;
        previewWrap.removeEventListener('scrollend', done);
        clearTimeout(fallback);
        syncing = false;
        // ⚠️ 校正：smooth 滚动可能没到位（被钳制 / 被打断 / 行高算错），
        //    这里按目标再对一次，直接跳到位（不再 smooth）。
        const maxPrev = previewWrap.scrollHeight - previewWrap.clientHeight;
        if (top <= maxPrev && Math.abs(previewWrap.scrollTop - top) > 4) {
            setScrollTop(previewWrap, top);   // 预览自己跳的
        }
    };
    previewWrap.addEventListener('scrollend', done);
    // 兜底：位置没变（不会触发 scrollend）或动画被打断
    const fallback = setTimeout(done, 1200);
    // 已经在目标位置 → 不会有 scroll 事件，直接解锁
    if (Math.abs(previewWrap.scrollTop - top) < 2) done();
}

function renderToc() {
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');

    // 先补 id：签名要用，点击跳转也依赖它
    // ⚠️ **id 不要用 slugify** —— 1MB 文档有 1.5 万个标题，
    //    每个都跑一次正则替换（全文级）就是几百毫秒（实测 renderToc 占 458ms）。
    //    目录项显示的是标题文字，id 只是定位用的 key → 用索引就够。
    headings.forEach((h, i) => {
        if (!h.id) h.id = 'h-' + i;
    });

    // ⚠️ **只处理要显示的前 N 个** ——
    //    1MB 文档可能有 1.5 万个标题，全部算 sig / 建 items / 更新 DOM 就是几百毫秒
    //    （实测 262ms，输入时直接卡死）。目录本来就只显示前 TOC_MAX_ITEMS 个。
    const truncated = headings.length > TOC_MAX_ITEMS;
    const shownHeads = truncated
        ? Array.prototype.slice.call(headings, 0, TOC_MAX_ITEMS)
        : headings;
    const items = Array.prototype.map.call(shownHeads, h => ({
        h,
        level: parseInt(h.tagName.charAt(1)),   // H4 → 4
        id: h.id,
        text: h.textContent,
        line: headingLines.get(h),
    }));

    // 签名只看「结构」= 级别 + id + 文本。行号故意不参与：
    // 在前面插一段正文会让后面所有标题行号 +1，但那不值得重建整个目录。
    const sig = items.map(it => it.level + '\u0001' + it.id + '\u0001' + it.text).join('\u0000');

    if (sig === tocSignature) {
        // 结构没变 → 只同步行号（改 dataset 不触发重排）和高亮，DOM 原样留着
        syncTocLines(items);
        updateTocHighlight();
        return;
    }
    tocSignature = sig;

    // ⚠️ **不要在这里读 tocList.scrollTop** ——
    //    渲染后布局是脏的，读 scrollTop 会强制**整个预览**（1MB 文档 = 1.2 万个元素）
    //    重新布局 → 几百毫秒 → 输入直接卡死（实测 258ms）。
    //    滚动位置用 scroll 事件里缓存的值（那时布局已经算好了，读起来是免费的）。
    const keepScroll = tocKeepScroll;

    // 极端文档（1MB、1.4 万个标题）光建目录就要近 1 秒，滚动和高亮也跟着变慢。
    // 超过上限只列前 N 项，并在末尾说明还有多少（真实文档几乎碰不到）。
    const shown = items;

    // 项数对得上就逐项改，别整段重建 —— 重建 2000 个目录项要重排整个目录，
    // 1MB 文档实测 1 秒以上（改一个标题字就要付这个代价）。
    const nodes = tocList.querySelectorAll('.toc-item');
    if (!truncated && items.length > 0 && nodes.length === shown.length) {
        for (let i = 0; i < shown.length; i++) {
            const el = nodes[i], it = shown[i];
            const cls = 'toc-item lvl' + it.level;
            if (el.className !== cls) el.className = cls;
            if (el.dataset.id !== it.id) el.dataset.id = it.id;
            if (el.textContent !== it.text) el.textContent = it.text;
            if (it.line === undefined) {
                if (el.dataset.line) delete el.dataset.line;
            } else if (el.dataset.line !== String(it.line)) {
                el.dataset.line = String(it.line);
            }
        }
        tocList.scrollTop = keepScroll;   // 没重建，scrollTop 本来就没动，保险起见还是写回
        updateTocHighlight();
        return;
    }

    if (items.length === 0) {
        tocList.innerHTML = '<div class="toc-empty">(无标题)</div>';
    } else {
        // 一次 innerHTML 批量建 + 点击靠事件委托（onTocItemClick）。
        // 别改回逐个 createElement + addEventListener：那样每次重建都要多花几百毫秒
        // （1MB 文档实测 800ms 以上，这里是同样的量级，主要成本在整页重排）。
        const parts = [];
        for (const it of shown) {
            const lineAttr = it.line !== undefined ? ' data-line="' + it.line + '"' : '';
            parts.push('<div class="toc-item lvl' + it.level + '" data-id="' + escAttr(it.id) + '"' +
                lineAttr + '>' + escHTML(it.text) + '</div>');
        }
        if (truncated) {
            parts.push('<div class="toc-empty">…还有 ' + (items.length - TOC_MAX_ITEMS) + ' 个标题未列出</div>');
        }
        tocList.innerHTML = parts.join('');
    }
    tocList.scrollTop = keepScroll;
    tocActiveId = '';        // 节点是全新的一批，高亮状态跟着清空
    updateTocHighlight();
}

/** 目录结构没变时，只把行号同步到现有节点上（改 dataset 不会触发重排） */
function syncTocLines(items) {
    const nodes = tocList.querySelectorAll('.toc-item');
    // 目录被 TOC_MAX_ITEMS 截断时节点比标题少，按少的那个同步
    const n = Math.min(nodes.length, items.length);
    for (let i = 0; i < n; i++) {
        const el = nodes[i];
        const line = items[i].line;
        if (line === undefined) {
            if (el.dataset.line) delete el.dataset.line;
        } else if (el.dataset.line !== String(line)) {
            el.dataset.line = String(line);
        }
    }
}

function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '');
}

// 上一次设置过的窗口标题（变了才通知后端，避免每次输入都发 IPC）
let lastWindowTitle = '';

// ============ 文件名超长时中间省略 ============
// 纯 CSS 的 direction:rtl 方案在中文/带括号的文件名上会 bidi 乱序，所以用 JS 量宽度。
// 目标宽度 = 工具栏里真正留给文件名的空间（固定项和间隔占掉的不算），与文件名内容无关，
// 所以不会出现「全文 → 省略 → 全文」来回抖。
const FILENAME_MAX_W = 320;      // 文件名最多占多宽
const FILENAME_TAIL_KEEP = 10;   // 尾部保留几个字（够放下扩展名）
const measureCtx = document.createElement('canvas').getContext('2d');
let measureFont = '';

function measureText(s) {
    if (!measureFont) {
        const cs = getComputedStyle(filenameEl);
        measureFont = `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        measureCtx.font = measureFont;
    }
    return measureCtx.measureText(s).width;
}

/**
 * 工具栏里留给文件名的空间 —— **缓存**。
 *
 * ⚠️ 这里要对工具栏的**每个子元素**调 getBoundingClientRect()，
 *    会强制整个文档重排（1MB 文档 = 250~400ms）。
 *    而它被 updateFilename() 调用，而 updateFilename() **每次输入都调**！
 *    实测这是组字卡顿的第二个大头（268ms/次）。
 *
 *    工具栏的布局只在**窗口 resize / 拖分隔条 / 缩放**时变，
 *    平时（打字时）用缓存值即可。
 */
let filenameTargetCache = -1;
function refreshFilenameTarget() {
    const cs = getComputedStyle(toolbarEl);
    const gap = parseFloat(cs.columnGap) || 0;
    const kids = Array.from(toolbarEl.children);
    let w = toolbarEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
        - (kids.length - 1) * gap;
    for (const k of kids) {
        if (k === filenameEl) continue;
        const ks = getComputedStyle(k);
        // spacer 会被挤到 min-width，给文件名留的空间按这个最小值算
        const width = k.classList.contains('spacer')
            ? (parseFloat(ks.minWidth) || 0)
            : k.getBoundingClientRect().width;
        w -= width + (parseFloat(ks.marginLeft) || 0) + (parseFloat(ks.marginRight) || 0);
    }
    filenameTargetCache = Math.min(FILENAME_MAX_W, w);
}

/** 工具栏里留给文件名的空间（用缓存值，不触发重排） */
function filenameTargetWidth() {
    if (filenameTargetCache < 0) refreshFilenameTarget();
    return filenameTargetCache;
}

/** 把文件名裁成「头部…尾部」，扩展名始终保留 */
function fitFilename() {
    const full = filenameEl.dataset.full || '';
    if (!full) { filenameEl.textContent = ''; return; }
    const target = filenameTargetWidth();
    if (target <= 0) { filenameEl.textContent = full; return; }
    if (measureText(full) <= target + 0.5) { filenameEl.textContent = full; return; }

    const chars = Array.from(full);
    const tail = (t) => chars.slice(chars.length - t).join('');
    // 尾部优先保留（扩展名在最后）
    let t = Math.min(chars.length - 1, FILENAME_TAIL_KEEP);
    while (t > 0 && measureText('…' + tail(t)) > target) t--;
    const tailStr = tail(t);
    // 二分：头部最多能留几个字
    let lo = 0, hi = chars.length - t;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (measureText(chars.slice(0, mid).join('') + '…' + tailStr) <= target) lo = mid;
        else hi = mid - 1;
    }
    filenameEl.textContent = chars.slice(0, lo).join('') + '…' + tailStr;
}

function updateFilename() {
    const name = currentFile ? currentFile.replace(/^.*[\\\/]/, '') : '(未保存)';
    const text = dirty ? name + ' ●' : name;
    const path = currentFile || '';
    // 名字没变就不用重新量宽度（每次输入都会走到这里）
    if (filenameEl.dataset.full !== text || filenameEl.dataset.path !== path) {
        filenameEl.dataset.full = text;
        filenameEl.dataset.path = path;
        filenameEl.title = path;      // 悬停显示完整路径
        fitFilename();
    }
    // 窗口标题也带上文件名，方便多文档时区分
    const title = (currentFile ? name + (dirty ? ' ●' : '') : '未命名') + ' - VMD';
    document.title = title;
    // 真正的窗口标题（标题栏那个）得让 Rust 改，网页的 document.title 管不到它
    if (title !== lastWindowTitle) {
        lastWindowTitle = title;
        invoke('set_window_title', { title }).catch(() => { /* 不在 Tauri 里跑时忽略 */ });
    }
    // 自动重载按钮的可用状态跟着"文件在不在磁盘上 / 有没有未保存的修改"走
    // （dirty、currentFile 的每次变化都会走到这里）
    updateAutoReloadBtn();
    // 右下角的光标位置 / 行数 / 字数
    scheduleEditorStatus();
}

function escapeHtml(s) {
    return s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
}

// ============ 文件 I/O ============

// ---- 阅读 / 编辑模式切换（分段控件）----
const modeSeg = document.getElementById('mode-seg');
const segBtns = modeSeg.querySelectorAll('.seg-btn');
let editMode = false;

function setEditMode(on) {
    editMode = on;
    // 用 <html> 上的 class（Rust 启动时也会注入同一个 class，首帧就一致）
    document.documentElement.classList.toggle('read-mode', !on);
    segBtns.forEach(b => b.classList.toggle('is-active', (b.dataset.mode === 'edit') === on));
    applyWidths();
    // 查找栏开着时，目标区域跟着模式变（编辑→查源码，阅读→查正文）
    const fb = document.getElementById('find-bar');
    if (fb && fb.classList.contains('open')) {
        openFindBar(findMode === 'replace');
    }
}

segBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        setEditMode(btn.dataset.mode === 'edit');
        // 注意：这里只改"当前模式"，不覆盖设置里的"默认模式"
    });
});

// ---- 主题下拉菜单 ----
const themeDropdown = document.getElementById('theme-dropdown');
const themeMenu = document.getElementById('theme-menu');
const themeToggle = document.getElementById('btn-theme');
const themeLabel = document.getElementById('theme-label');

themeToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    themeDropdown.classList.toggle('open');
});

// 点击菜单项
themeMenu.querySelectorAll('.dropdown-item').forEach(item => {
    // 悬停 = 整个窗体即时预览这个主题
    item.addEventListener('mouseenter', () => schedulePreview(item.dataset.theme));
    item.addEventListener('click', (e) => {
        e.stopPropagation();
        applyTheme(item.dataset.theme);
        updateThemeButton();
        themeDropdown.classList.remove('open');
        endPreview();   // 菜单关掉了，预览也恢复
    });
});
// 鼠标移出菜单 → 恢复当前主题
themeMenu.addEventListener('mouseleave', endPreview);

// 点击其他地方关闭
document.addEventListener('click', () => {
    themeDropdown.classList.remove('open');
    endPreview();   // 菜单被关掉时不会触发 mouseleave，预览要在这里恢复
});

function updateThemeButton() {
    const t = THEMES[currentTheme];
    // 按钮只留图标（省工具栏宽度），完整名字放 tooltip
    themeLabel.textContent = t.icon;
    themeToggle.title = currentTheme === 'auto'
        ? '跟随系统（当前：' + THEMES[activeTheme].name + '）'
        : '主题：' + t.name;
    // 高亮当前选中项
    themeMenu.querySelectorAll('.dropdown-item').forEach(item => {
        item.classList.toggle('active', item.dataset.theme === currentTheme);
    });
}

document.getElementById('btn-new').addEventListener('click', async () => {
    // 有未保存的修改时先问 —— 和打开/拖放走同一套检查
    if (!(await confirmDiscardCurrent())) return;
    editor.value = '';
    editor.scrollTop = 0;               // 先归零
    currentFile = null;
    dirty = false;
    dropDraft();                    // 新建 = 主动丢掉未保存内容，草稿也一起清
    fileStamp = null;
    fileMissing = false;
    setExternalChange(false);
    // 新建的文件还没保存 → 自动重载没有可盯的磁盘版本，直接关掉（按钮也会变成置灰）
    if (autoReload) setAutoReload(false);
    // 新建文件是要写字的 → 阅读模式里没法写，自动切到编辑模式
    // （只改"当前模式"，不覆盖设置里的"默认模式"）
    if (!editMode) setEditMode(true);
    renderPreview();
    resetScrollToTop();                 // 新建也是从顶部开始
    updateFilename();
    editor.focus();   // 光标直接落在编辑区，接着就能打字
});
document.getElementById('btn-open').addEventListener('click', openFile);
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-save-as').addEventListener('click', saveAsFile);

// 外部修改徽章：点一下重新问一下要不要加载
document.getElementById('ext-badge').addEventListener('click', () => {
    if (externalChange) promptExternalChange();
});

// 模态框的按钮
document.getElementById('modal-ok').addEventListener('click', () => closeDialog(true));
document.getElementById('modal-cancel').addEventListener('click', () => closeDialog(false));
document.getElementById('modal-always').addEventListener('click', () => closeDialog('always'));
document.getElementById('modal-mask').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modal-mask') closeDialog(false);   // 点遮罩 = 取消
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalResolve) closeDialog(false);
});

// 光标移动 → 更新编辑区右下角的状态（行号 / 字数）
document.addEventListener('selectionchange', () => {
    // ⚠️ 组字期间不更新状态：组字时每个拼音键都会改选区 → selectionchange 频繁触发
    //    → 状态标签要重建全文统计（3 万行）→ 白白浪费。
    //    等 compositionend 再更新一次。
    if (imeComposing) return;
    if (document.activeElement === editor) scheduleEditorStatus();
});

// 屏蔽刷新键：F5 / Ctrl+R / Ctrl+Shift+R
//
// 刷新页面 = 整个 WebView 重新加载 → 编辑区里没保存的内容直接没了，
// 而且没有"要不要保存"的询问。属于数据丢失级别的操作，直接拦掉。
// （Rust 侧还有一道 WebView2 的拦截，这里是双保险。）
document.addEventListener('keydown', (e) => {
    const k = e.key;
    if (k === 'F5' || ((e.ctrlKey || e.metaKey) && (k === 'r' || k === 'R'))) {
        e.preventDefault();
        e.stopPropagation();
    }
}, true);   // 捕获阶段：抢在别的处理前面

// 文字缩放快捷键（跟浏览器一样）：Ctrl + / - / 0
document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key;
    if (k === '=' || k === '+') { e.preventDefault(); setZoom((settings.zoom || 100) + ZOOM_STEP); }
    else if (k === '-' || k === '_') { e.preventDefault(); setZoom((settings.zoom || 100) - ZOOM_STEP); }
    else if (k === '0') { e.preventDefault(); setZoom(100); }
});

// 自动重载开关
document.getElementById('btn-auto-reload').addEventListener('click', toggleAutoReload);

// 设置面板

/** 打开指定路径的文件（"打开"对话框和拖放共用） */
async function openPath(path) {
    const file = await invoke('read_file', { path });
    editor.value = file.content;
    editor.setSelectionRange(0, 0);     // 光标回到开头
    editor.scrollTop = 0;               // 先归零（渲染和后续同步都以顶部为基准）
    currentFile = path;
    currentEncoding = file.encoding || 'utf-8';
    dirty = false;
    fileMissing = false;
    renderPreview();
    resetScrollToTop();                 // 换文件后回到顶部（别停在上个文件那行）
    updateFilename();
    setExternalChange(false);       // 换了文件，之前的"外部已修改"标记作废
    await recordStamp();
    applyReadOnly();                // 自动重载开着 → 只读
    await dropDraft();              // 换了文件，之前那个文件的草稿作废
    resetScrollToTop();             // 保险：期间可能有滚动事件把位置带跑了
    showToast('已打开');
}

/**
 * 打开另一个文件（或新建）前的统一检查：有未保存修改就先问一句。
 * 返回 true = 可以继续，false = 用户取消 / 保存失败。
 *
 * Ctrl+O、拖放、新建三条路都要走这里 —— 以前只有 Ctrl+O 检查，
 * 拖放会把当前编辑区的内容静默覆盖掉（未保存的改动直接没）。
 */
async function confirmDiscardCurrent() {
    if (!dirty) return true;
    const r = await askSaveChanges();
    if (r === 'cancel') return false;
    if (r === 'save' && !(await saveFile())) return false;   // 保存失败/取消 → 不继续
    return true;   // 'discard' → 继续，丢弃当前修改
}

async function openFile() {
    if (!(await confirmDiscardCurrent())) return;
    try {
        const path = await open({
            multiple: false,
            filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
        });
        if (!path) return;
        await openPath(path);
    } catch (e) {
        showError('打不开这个文件', e);
    }
}

async function saveFile() {
    if (!currentFile) return saveAsFile();
    if (editor.readOnly) {           // 自动重载（只读）模式下没有可保存的修改
        showToast('自动重载模式下内容是只读的', 2200);
        return false;
    }
    try {
        await invoke('write_file', { path: currentFile, content: editor.value, encoding: currentEncoding });
        dirty = false;
        fileMissing = false;
        updateFilename();
        // 存回去的内容就是当前内容了，外部修改的问题随之解决
        setExternalChange(false);
        await recordStamp();
        await dropDraft();               // 落盘了就没什么可恢复的了
        showToast('已保存');
        return true;
    } catch (e) {
        showError('保存失败', e);
        return false;
    }
}

async function saveAsFile() {
    try {
        const path = await save({
            filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
            defaultPath: currentFile || 'untitled.md',
        });
        if (!path) return false;      // 用户取消了"另存为" → 没保存
        await invoke('write_file', { path, content: editor.value, encoding: currentEncoding });
        currentFile = path;
        dirty = false;
        fileMissing = false;
        updateFilename();
        // 另存到新文件：原文件仍然是"被外部改过"的状态，标记要留着
        await recordStamp();
        await dropDraft();
        showToast('已保存');
        return true;
    } catch (e) {
        showError('保存失败', e);
        return false;
    }
}

// ============ 查找 / 替换（Ctrl+F / Ctrl+H）============
//
// **按区域分开**（这是关键）：
//   - 编辑模式 → 查**源码**（编辑区），可以替换
//   - 阅读模式 → 查**正文**（预览区），只查不换（正文没有"源码"可改）
// 查找栏会挪到当前目标区域里，位置永远跟着区域走。
//
// 不用浏览器自带的查找栏：它搜的是整个 DOM（源码 + 渲染结果混一起），结果全是噪音。

const findBar = document.getElementById('find-bar');
const findInput = document.getElementById('find-input');
const replaceInput = document.getElementById('replace-input');
const findCountEl = document.getElementById('find-count');
const findPrevBtn = document.getElementById('find-prev');
const findNextBtn = document.getElementById('find-next');
const replaceOneBtn = document.getElementById('replace-one');
const replaceAllBtn = document.getElementById('replace-all');
const findCloseBtn = document.getElementById('find-close');
const findTabFind = document.getElementById('find-tab-find');
const findTabReplace = document.getElementById('find-tab-replace');
const editorWrap = document.getElementById('editor-wrap');

// 目标区域：'editor' = 源码（可替换）｜ 'preview' = 正文（只查）
let findTarget = 'editor';
// 查找栏内的模式：'find' = 只查找 ｜ 'replace' = 带替换
let findMode = 'find';
let findMatches = [];    // editor: 匹配位置；preview: mark 元素
let findIndex = -1;      // 当前是第几个
let findTimer = 0;

// ---- 编辑区高亮层（textarea 下面那层）----
// textarea 未聚焦时**选区是不显示的** → 光靠 setSelectionRange 用户根本看不见匹配在哪。
// 所以在 textarea 下面叠一层"镜像文本"，只把匹配片段标上背景色。
const editorHl = document.getElementById('editor-hl');

function escHl(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 编辑区：重建高亮层（文字跟编辑区完全一致，只把匹配片段包上 <mark>） */
function renderEditorHighlights() {
    if (!editorHl) return;
    const q = findInput ? findInput.value : '';
    if (!q || !findBar || !findBar.classList.contains('open')) {
        editorHl.innerHTML = '';
        return;
    }
    const text = editor.value;
    let html = '';
    let i = 0;
    let n = 0;
    while (true) {
        const p = text.indexOf(q, i);
        if (p === -1) break;
        html += escHl(text.slice(i, p));
        html += '<mark' + (n === findIndex ? ' class="current"' : '') + '>' + escHl(q) + '</mark>';
        i = p + q.length;
        n++;
    }
    html += escHl(text.slice(i));
    editorHl.innerHTML = html;
    syncHlScroll();
}

/** 高亮层跟着编辑区滚动 */
function syncHlScroll() {
    if (!editorHl) return;
    editorHl.scrollTop = editor.scrollTop;
    editorHl.scrollLeft = editor.scrollLeft;
}

// ---- 预览区高亮：直接改 DOM，把匹配包成 <mark> ----

/** 清掉预览区里所有查找标记（还原成普通文本） */
function clearPreviewMarks() {
    const marks = preview.querySelectorAll('mark.vmd-find');
    for (const m of marks) {
        const parent = m.parentNode;
        if (!parent) continue;
        parent.replaceChild(document.createTextNode(m.textContent), m);
        parent.normalize();   // 把拆开的文本节点合并回去
    }
}

/** 预览区：找出所有匹配并包成 <mark class="vmd-find"> */
function collectPreviewMatches() {
    clearPreviewMarks();
    const q = findInput.value;
    const hits = [];
    if (!q) return hits;
    // 1. 先收集含关键词的文本节点
    const nodes = [];
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT, {
        acceptNode: function (node) {
            if (!node.nodeValue || node.nodeValue.indexOf(q) === -1) return NodeFilter.FILTER_REJECT;
            let p = node.parentNode;
            while (p && p !== preview) {
                const t = p.nodeName;
                if (t === 'SCRIPT' || t === 'STYLE' || t === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
                p = p.parentNode;
            }
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    // 2. 逐个切分并包 mark
    //    ⚠️ 这里必须用 let：循环体里要把 node 换成切分后的尾节点。
    //       用 const 会抛 “Assignment to constant variable”，而这个异常在
    //       事件回调里是静默的 → 表现为“明明有匹配，计数却是 0/0”。
    for (let node of nodes) {
        let text = node.nodeValue;
        let i = 0;
        while (true) {
            const p = text.indexOf(q, i);
            if (p === -1) break;
            const rest = node.splitText(p);          // rest = 匹配那一段
            const tail = rest.splitText(q.length);   // tail = 后面的内容
            const mark = document.createElement('mark');
            mark.className = 'vmd-find';
            mark.textContent = q;
            rest.parentNode.replaceChild(mark, rest);
            hits.push(mark);
            node = tail;
            text = tail.nodeValue;
            i = q.length;
        }
    }
    return hits;
}

/** 统一入口：按目标区域收集匹配 */
function collectMatches() {
    if (findTarget === 'preview') {
        findMatches = collectPreviewMatches();
        findIndex = -1;
        updateFindCount();
        return;
    }
    const q = findInput ? findInput.value : '';
    findMatches = [];
    findIndex = -1;
    if (q) {
        const text = editor.value;
        let i = 0;
        while (true) {
            const p = text.indexOf(q, i);
            if (p === -1) break;
            findMatches.push(p);
            i = p + q.length;
            if (findMatches.length >= 50000) break;   // 超大文件别把内存吃光
        }
    }
    updateFindCount();
}

/** 更新计数显示 */
function updateFindCount() {
    const n = findMatches.length;
    // 还没选中任何一个时也显示 1/N（别显示 0/N，看着像没找到）
    const cur = findIndex >= 0 ? findIndex + 1 : (n ? 1 : 0);
    findCountEl.textContent = n ? cur + '/' + n : '0/0';
    findCountEl.classList.toggle('hit', n > 0);
}

/**
 * 跳到第 dir 个匹配（dir=1 下一个，dir=-1 上一个），到头了就循环。
 *
 * ⚠️ **不要在这里 focus 编辑区** —— 查找框开着的时候焦点必须留在查找框，
 * 否则用户刚打一个字焦点就被抢走，后面的话全打不进搜索框了。
 * 选区可以设（setSelectionRange 不依赖焦点），滚动我们自己来（scrollEditorToPos）。
 */
function gotoMatch(dir) {
    if (!findMatches.length) collectMatches();
    if (!findMatches.length) return;
    if (findTarget === 'preview') { gotoPreviewMatch(dir); return; }
    const start = editor.selectionStart;
    let idx;
    if (dir > 0) {
        idx = findMatches.findIndex(p => p >= start);
        if (idx === -1) idx = 0;
    } else {
        idx = -1;
        for (let i = findMatches.length - 1; i >= 0; i--) {
            if (findMatches[i] < start) { idx = i; break; }
        }
        if (idx === -1) idx = findMatches.length - 1;
    }
    findIndex = idx;
    const p = findMatches[idx];
    const q = findInput.value;
    editor.setSelectionRange(p, p + q.length);
    updateFindCount();
    scrollEditorToPos(p);
    renderEditorHighlights();   // 当前匹配换了个颜色
}

/** 预览区：跳到第 dir 个匹配 */
function gotoPreviewMatch(dir) {
    if (!findMatches.length) return;
    let idx = findIndex;
    if (idx < 0) idx = dir > 0 ? 0 : findMatches.length - 1;
    else idx = (idx + dir + findMatches.length) % findMatches.length;
    findIndex = idx;
    for (let i = 0; i < findMatches.length; i++) {
        findMatches[i].classList.toggle('current', i === idx);
    }
    updateFindCount();
    const m = findMatches[idx];
    if (m && m.scrollIntoView) m.scrollIntoView({ block: 'center' });
}

/** 把某个字符位置滚到编辑区可视区域（行高固定，不折行） */
function scrollEditorToPos(pos) {
    if (!editorLineHeight) refreshEditorLineHeight();
    const cs = getComputedStyle(editor);
    const padTop = parseFloat(cs.paddingTop) || 0;
    // 光标前的换行数 = 行号
    let line = 0;
    for (let i = 0; i < pos; i++) {
        if (editor.value.charCodeAt(i) === 10) line++;
    }
    const y = line * editorLineHeight + padTop;
    const h = editor.clientHeight;
    // 不在中间区域就滚过去（已经在眼前就别动）
    if (y < editor.scrollTop + h * 0.3 || y > editor.scrollTop + h * 0.75) {
        editor.scrollTop = Math.max(0, y - h * 0.4);
    }
}

/** 替换当前这一个匹配（只有源码区能替换） */
function replaceCurrentMatch() {
    if (findTarget !== 'editor') return;
    const q = findInput.value;
    const rep = replaceInput.value;
    if (!q) { showToast('先输入要查找的内容', 2200); return; }
    // 先重算：文本可能已经被改过，findMatches 是旧的
    collectMatches();
    if (!findMatches.length) { showToast('没有找到匹配项', 2200); return; }
    const s = editor.selectionStart, e = editor.selectionEnd;
    if (editor.value.slice(s, e) !== q) {
        gotoMatch(1);
        return;
    }
    if (!replaceSelectionKeepingUndo(rep, s, e)) {
        showToast('自动重载模式下内容是只读的');
        return;
    }
    collectMatches();
    if (findMatches.length) gotoMatch(1);
}

/** 全部替换：算好新全文一次换掉（一次 Ctrl+Z 能整体撤销） */
function replaceAllMatches() {
    if (findTarget !== 'editor') return;
    const q = findInput.value;
    const rep = replaceInput.value;
    if (!q) { showToast('先输入要查找的内容', 2200); return; }
    // 先重算：文本可能已经被改过，findMatches 是旧的
    collectMatches();
    // ⚠️ 一个都没匹配上时**不能**往下走 ——
    //    split(q).join(rep) 会把全文原样写回去，白白污染一次撤销栈，
    //    而且还会报“已替换 1 处”（之前 findMatches.length || 1 那个兜底搞的）。
    if (!findMatches.length) { showToast('没有找到匹配项', 2200); return; }
    const n = findMatches.length;
    const text = editor.value;
    const out = text.split(q).join(rep);   // split/join 不把 $& 当特殊字符
    if (!replaceSelectionKeepingUndo(out, 0, text.length)) {
        showToast('自动重载模式下内容是只读的');
        return;
    }
    collectMatches();
    showToast('已替换 ' + n + ' 处');
}

/** 查找栏模式：查找 / 替换（同一个栏里切换） */
function setFindMode(mode) {
    findMode = mode;
    if (!findBar) return;
    findBar.classList.toggle('replace-mode', mode === 'replace');
    if (findTabFind) findTabFind.classList.toggle('is-active', mode === 'find');
    if (findTabReplace) findTabReplace.classList.toggle('is-active', mode === 'replace');
    // 查正文（阅读模式）时没有"源码"可改 → 替换页签禁用
    const canReplace = findTarget === 'editor';
    if (findTabReplace) {
        findTabReplace.disabled = !canReplace;
        findTabReplace.title = canReplace ? '切换到替换' : '阅读模式下只能查找，不能替换';
    }
    if (findInput) {
        findInput.placeholder = findTarget === 'editor' ? '查找源码' : '查找正文';
    }
}

/**
 * 把查找栏定位到当前目标区域上方。
 *
 * ⚠️ 查找栏**不能**直接放进目标区域里 —— 预览区（#preview-wrap）自己就是滚动容器，
 *    放进去的话查找栏会跟着正文一起滚走，滚到后面就看不见了。
 * 所以它固定放在 #content（不滚动）里，位置按目标区域算。
 */
function placeFindBar() {
    if (!findBar) return;
    const base = document.getElementById('content');
    const host = findTarget === 'preview' ? previewScroll : editorWrap;
    if (!base || !host) return;
    if (findBar.parentNode !== base) base.appendChild(findBar);
    // offsetLeft / offsetWidth 是相对 offsetParent（#content 是 relative）算的
    findBar.style.left = (host.offsetLeft + 8) + 'px';
    findBar.style.width = Math.max(120, host.offsetWidth - 16) + 'px';
}

/** 打开查找栏（withReplace=true 时直接进替换模式） */
function openFindBar(withReplace) {
    if (!findBar) return;
    // 目标跟着当前模式走：编辑模式查源码，阅读模式查正文
    findTarget = editMode ? 'editor' : 'preview';
    placeFindBar();
    setFindMode(withReplace && findTarget === 'editor' ? 'replace' : 'find');
    findBar.classList.add('open');
    placeFindBar();   // 位置得跟着目标区域（拖分隔条改了宽度也要跟上）
    // 选中了文字就拿来当搜索词（VS Code 的行为）
    if (findTarget === 'editor') {
        const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
        if (sel && !sel.includes('\n') && document.activeElement !== findInput) {
            findInput.value = sel;
        }
    }
    collectMatches();
    if (findTarget === 'preview') {
        if (findMatches.length) gotoPreviewMatch(1);
    } else {
        renderEditorHighlights();
    }
    // 焦点：替换模式进替换框，否则进查找框
    if (findMode === 'replace' && replaceInput) {
        replaceInput.focus();
        replaceInput.select();
    } else {
        findInput.focus();
        findInput.select();
    }
}

/** 关闭查找栏 */
function closeFindBar() {
    if (!findBar) return;
    findBar.classList.remove('open');
    if (editorHl) editorHl.innerHTML = '';
    clearPreviewMarks();
    if (editMode) editor.focus();
}

if (findBar) {
    // Rust 层拦下了 Ctrl+F / Ctrl+H（它们是**浏览器保留键**，Chromium 会在把按键
    // 交给渲染器之前就自己处理掉 → 前端的 keydown 压根收不到）。
    // 拦掉之后由它发事件过来，通知我们打开查找栏（payload = 是否带替换框）。
    if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.listen('vmd-find', (e) => {
            openFindBar(!!(e && e.payload));
        });
    }
    // 页签：查找 ↔ 替换（同一个栏里切）
    if (findTabFind) {
        findTabFind.addEventListener('click', () => {
            setFindMode('find');
            findInput.focus();
        });
    }
    if (findTabReplace) {
        findTabReplace.addEventListener('click', () => {
            if (findTabReplace.disabled) return;
            setFindMode('replace');
            replaceInput.focus();
        });
    }
    findInput.addEventListener('input', () => {
        clearTimeout(findTimer);
        findTimer = setTimeout(() => {
            collectMatches();
            if (findMatches.length) gotoMatch(1);
            else if (findTarget === 'editor') renderEditorHighlights();
            // 保险：焦点别跑。查找的时候焦点必须留在查找框里，
            // 否则用户刚打一个字，后面的话全打不进去。
            if (document.activeElement !== findInput && document.activeElement !== replaceInput) {
                findInput.focus();
            }
        }, 120);
    });
    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            gotoMatch(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeFindBar();
        }
    });
    replaceInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.ctrlKey || e.altKey) replaceAllMatches();
            else replaceCurrentMatch();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeFindBar();
        }
    });
    findPrevBtn.addEventListener('click', () => gotoMatch(-1));
    findNextBtn.addEventListener('click', () => gotoMatch(1));
    replaceOneBtn.addEventListener('click', replaceCurrentMatch);
    replaceAllBtn.addEventListener('click', replaceAllMatches);
    findCloseBtn.addEventListener('click', closeFindBar);
    // 点按钮不要抢走查找框的焦点（mousedown 默认会把焦点移到按钮上）
    [findPrevBtn, findNextBtn, replaceOneBtn, replaceAllBtn, findCloseBtn, findTabFind, findTabReplace].forEach(b => {
        b.addEventListener('mousedown', (e) => e.preventDefault());
    });
}

// ============ 编辑区状态（光标行 / 总行数 / 字数）============
// 浮在编辑区右下角，不占工具栏宽度（工具栏的宽度预算很紧）。
let statusRaf = 0;
let docStatsCache = { text: null, lines: 1, chars: 0 };

/**
 * 文档统计：行数 / 字数 / 行首偏移表。
 *
 * 行首表用于二分查光标行号（否则每次光标移动都要 O(n) 扫一遍）。
 * 全文重建一次 590KB 只要 ~2ms，不算瓶颈 —— 所以就用简单的全量实现，
 * 不搞增量（增量容易算错行号，而行号错了会让状态栏和滚动同步都错位）。
 *
 * ⚠️ 真正要避免的是**在组字期间调用它**：
 *    组字时每个拼音键都改 text → 缓存失效 → 重建。
 *    所以 input / selectionchange 处理里都在组字期间跳过状态更新。
 */
function getDocStats(text) {
    if (docStatsCache.text === text) return docStatsCache;
    let lines = 1, chars = 0;
    // 行起始偏移表 —— 光标行号靠它二分查（否则每次光标移动都要 O(n) 扫一遍，
    // 1MB 文档拖选会卡）
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c === 10) { lines++; lineStarts.push(i + 1); }
        else if (c !== 32 && c !== 9 && c !== 13) chars++;   // 空白不算字数
    }
    docStatsCache = { text, lines, chars, lineStarts };
    return docStatsCache;
}

/** 光标位置在第几行（1 起）—— 二分查行起始表 */
function lineAtPos(text, pos) {
    const starts = getDocStats(text).lineStarts;
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
}

/**
 * 右下角的状态标签：行号 / 总行数 / 字数。
 *
 * ⚠️ 这里**不能**读布局（editor.clientHeight 之类）——
 *    浏览器本来要把整个 textarea（3 万行）重排一遍，
 *    我们一读就把这次重排**同步**拉进当前帧的关键路径。
 *    这个标签是纯信息，滞后一帧完全无感 → 什么都不读，只算文本。
 */
function updateEditorStatus() {
    const el = document.getElementById('editor-status');
    if (!el) return;
    const text = editor.value;
    const stats = getDocStats(text);
    const line = lineAtPos(text, editor.selectionStart);
    el.textContent = '行 ' + line + '/' + stats.lines + ' · ' + stats.chars + ' 字';
}

/**
 * 光标一动就更新状态栏（rAF 节流，不然拖选会卡）
 */
function scheduleEditorStatus() {
    if (statusRaf) return;
    statusRaf = requestAnimationFrame(() => {
        statusRaf = 0;
        updateEditorStatus();
    });
}

// ============ 外部修改检测 ============

// 当前打开文件的快照（mtime + size），用来判断有没有被外部程序改过
let fileStamp = null;
// 外部已修改（决定要不要显示徽章、要不要再弹窗）
let externalChange = false;
// 弹窗正开着（避免重复弹）
let changeDialogOpen = false;
// 上次提示"文件已被删除"的时间
let lastDeleteNotice = 0;
// 连续几轮检测不到文件（>=2 才算真被删了）
let deleteRounds = 0;
// 窗口有没有焦点（用 Tauri 的窗口事件，比 document.hasFocus() 可靠）
let winFocused = true;

/** 记下当前文件的元信息（打开 / 保存后调用） */
async function recordStamp() {
    fileStamp = null;
    if (!currentFile) return;
    try {
        fileStamp = await invoke('file_stamp', { path: currentFile });
    } catch (e) {
        // 文件没了也无所谓，等轮询时再提示
    }
}

/** 切换"外部已修改"标记 */
function setExternalChange(on) {
    externalChange = !!on;
    const badge = document.getElementById('ext-badge');
    if (badge) badge.classList.toggle('show', externalChange);
}

/** 每 3 秒查一次文件有没有被外部改过（只在窗口有焦点时查） */
async function checkExternalChange() {
    if (!currentFile || !fileStamp || changeDialogOpen) return;
    if (!winFocused) return;   // 窗口在后台就不查，切回来会立刻查一次
    let now;
    try {
        now = await invoke('file_stamp', { path: currentFile });
    } catch (e) {
        return;
    }
    if (!now) {
        // 文件被删了：连续两轮都不在才算真删了（有些编辑器保存是"先删后写"）
        deleteRounds++;
        if (deleteRounds >= 2 && !fileMissing) {
            fileMissing = true;
            // 文件都没了 → 自动重载没东西可盯，关掉（编辑器恢复可编辑，别卡在只读）
            if (autoReload) setAutoReload(false);
            updateAutoReloadBtn();
            showToast('文件已被删除', 3200);
        }
        return;
    }
    deleteRounds = 0;
    // 文件又回来了（比如用户自己存回去了）
    if (fileMissing) {
        fileMissing = false;
        updateAutoReloadBtn();
    }
    if (now.mtime === fileStamp.mtime && now.size === fileStamp.size) return;

    // 有变化了
    if (autoReload) {
        // 自动重载开着：编辑器是只读的，直接同步（不会丢用户的东西）
        await autoReloadFromDisk();
        return;
    }
    // 还没弹过窗 → 问一次；已经问过了就只亮着徽章，不打扰
    if (!externalChange) {
        setExternalChange(true);
        await promptExternalChange();
    }
}

/** 问用户要不要重新加载 */
async function promptExternalChange() {
    if (changeDialogOpen) return;
    changeDialogOpen = true;
    const name = currentFile ? currentFile.replace(/^.*[\\\/]/, '') : '文件';
    // 用 DOM 节点拼内容，文件名不走 innerHTML
    const body = document.createElement('div');
    const line = document.createElement('div');
    line.textContent = name + ' 在 VMD 之外被改过了。';
    body.appendChild(line);
    if (dirty) {
        const warn = document.createElement('div');
        warn.className = 'modal-warn';
        warn.textContent = '⚠ 当前编辑区里有未保存的修改，重新加载会被覆盖掉。';
        body.appendChild(warn);
    }
    const choice = await showDialog({
        title: '文件已被外部程序修改',
        icon: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
        body: body,
        okText: '重新加载',
        cancelText: '保留当前内容',
        alwaysText: '以后自动重载',
    });
    changeDialogOpen = false;
    if (choice === true) {
        await reloadFromDisk();
    } else if (choice === 'always') {
        // 以后自动重载：立刻同步一次，然后切到只读跟随
        await reloadFromDisk();
        setAutoReload(true);
    }
    // 选"保留当前内容"：什么都不动，徽章一直亮着，点徽章可以再问一次
}

/** 用磁盘上的内容覆盖编辑器 */
async function reloadFromDisk() {
    try {
        const file = await invoke('read_file', { path: currentFile });
        currentEncoding = file.encoding || 'utf-8';
        applyExternalContent(file.content, '已重新加载');
    } catch (e) {
        showError('重新加载失败', e);
    }
}

/** 自动重载：防抖 + 确认文件稳定了再替换内容 */
async function autoReloadFromDisk() {
    const path = currentFile;
    if (!path) return;
    // 外部可能正在写，等一下再读
    await new Promise(r => setTimeout(r, 500));
    if (currentFile !== path) return;   // 期间换了文件，放弃
    let before;
    try {
        before = await invoke('file_stamp', { path });
    } catch (e) {
        return;
    }
    if (!before) return;                // 文件没了，下一轮再说
    let content;
    try {
        const file = await invoke('read_file', { path });
        content = file.content;
        // 外部工具可能改了编码（比如另存为 GBK），跟着它走
        if (currentFile === path) currentEncoding = file.encoding || 'utf-8';
    } catch (e) {
        return;
    }
    let after;
    try {
        after = await invoke('file_stamp', { path });
    } catch (e) {
        return;
    }
    // 读的过程中还在变 → 这轮放弃，等下一个周期
    if (!after || after.mtime !== before.mtime || after.size !== before.size) return;
    if (currentFile !== path) return;
    // 自动重载是后台行为，不弹提示 —— 内容自己变了就够明显，
    // 外部工具反复保存文件的话，每次都弹会变成提示轰炸
    applyExternalContent(content, null);
}

/** 把外部的内容灌进编辑器（保持光标和滚动位置） */
function applyExternalContent(content, tip) {
    const selStart = editor.selectionStart;
    const selEnd = editor.selectionEnd;
    const edScroll = editor.scrollTop;
    const pvScroll = previewScroll ? previewScroll.scrollTop : 0;
    editor.value = content;
    dirty = false;
    fileMissing = false;
    try { editor.setSelectionRange(selStart, selEnd); } catch (e) { /* 忽略 */ }
    editor.scrollTop = edScroll;
    if (previewScroll) previewScroll.scrollTop = pvScroll;
    renderPreview();
    updateFilename();
    setExternalChange(false);
    recordStamp();
    // 磁盘上的内容已经覆盖进来了，旧草稿作废（不然下次启动会拿它出来问恢复）
    dropDraft();
    if (tip) showToast(tip);
}

// ============ 崩溃恢复（草稿快照）============
//
// 未保存的内容只存在内存里，崩溃 / 断电 / panic=abort 就直接没了。
// 所以有未保存修改时定时往 `%LOCALAPPDATA%\com.vmd.app\scratch\draft.json` 快照一份，
// 下次启动发现还有草稿就问用户要不要恢复。
//
// 注意：这**不是**自动保存 —— 普通保存/另存为/换文件/正常关窗时都要把草稿删掉。
const DRAFT_INTERVAL = 5000;           // 普通文档 5 秒快照一次
const DRAFT_INTERVAL_BIG = 20000;      // 超过 1MB 的文档拉长到 20 秒（全量写盘太频繁没意义）
const DRAFT_BIG_SIZE = 1024 * 1024;
let draftSavedContent = null;   // 上一次成功写进草稿的内容（一样就不重复写）
let draftSavedAt = 0;           // 上一次成功写草稿的时间（Date.now）
let draftBusy = false;          // 正在写（避免 5 秒定时器和输入事件叠在一起）

/** 有未保存修改时把内容快照到磁盘 */
async function maybeSaveDraft() {
    if (!dirty || draftBusy) return;
    const content = editor.value;
    if (content === draftSavedContent) return;
    const gap = content.length > DRAFT_BIG_SIZE ? DRAFT_INTERVAL_BIG : DRAFT_INTERVAL;
    if (Date.now() - draftSavedAt < gap) return;
    draftBusy = true;
    try {
        await invoke('save_draft', {
            path: currentFile || null,
            content,
            encoding: currentEncoding,
        });
        draftSavedContent = content;
        draftSavedAt = Date.now();
    } catch (e) {
        // 草稿写不进去（目录没权限、磁盘满）不该打扰用户 —— 下次再试
        console.warn('draft save failed:', e);
    } finally {
        draftBusy = false;
    }
}

/** 删草稿（保存成功、换文件、用户明确丢弃、关窗时调） */
async function dropDraft() {
    draftSavedContent = null;
    draftSavedAt = 0;
    try {
        await invoke('clear_draft');
    } catch (e) {
        // 删不掉也无所谓，下次启动比较一下磁盘时间就会自动丢弃
    }
}

/** 把草稿灌回编辑器（恢复上次未保存的内容） */
async function restoreDraft(draft) {
    editor.value = draft.content;
    editor.scrollTop = 0;               // 恢复的是上次的内容 → 从顶部开始看
    currentFile = draft.path || null;
    currentEncoding = draft.encoding || 'utf-8';
    dirty = true;          // 内容还是“未保存”状态，标题栏要有 ●
    fileMissing = false;
    setExternalChange(false);
    renderPreview();
    updateFilename();
    await recordStamp();
    applyReadOnly();
    if (!editMode) setEditMode(true);   // 要接着写 → 切到编辑模式
    editor.focus();
    // 记住已经写进草稿的内容，免得启动后立刻又写一遍一模一样的
    draftSavedContent = draft.content;
    draftSavedAt = Date.now();
    showToast('已恢复上次未保存的内容', 3000);
}

/**
 * 启动时检查有没有上次没能保存的草稿。
 *
 * 丢弃条件（草稿已经没用了）：
 * - 磁盘上的文件比草稿新（说明草稿之后已经保存过）
 * - 磁盘内容跟草稿一模一样（没什么可恢复的）
 * - 文件读不出来
 */
async function maybeOfferDraftRestore() {
    let draft;
    try {
        draft = await invoke('load_draft');
    } catch (e) {
        return;
    }
    if (!draft || !draft.content) return;
    if (draft.path) {
        try {
            const stamp = await invoke('file_stamp', { path: draft.path });
            if (stamp) {
                if (stamp.mtime > draft.saved_at) { await dropDraft(); return; }
                const disk = await invoke('read_file', { path: draft.path });
                if (disk.content === draft.content) { await dropDraft(); return; }
            }
            // 文件被删了（stamp 为 null）→ 草稿还有价值，接着问
        } catch (e) {
            await dropDraft();
            return;
        }
    }
    const name = draft.path ? draft.path.replace(/^.*[\\\/]/, '') : '未命名文档';
    const when = new Date(draft.saved_at / 1e6).toLocaleString('zh-CN', { hour12: false });
    const body = document.createElement('div');
    body.textContent = '「' + name + '」里有上次没来得及保存的修改（' + when + '）。要恢复吗？';
    const choice = await showDialog({
        title: '发现未保存的草稿',
        // 时钟 + 回转箭头
        icon: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
        body,
        okText: '恢复',
        cancelText: '丢弃',
    });
    if (choice !== true) {
        await dropDraft();
        return;
    }
    await restoreDraft(draft);
}

// ============ 自动重载开关 ============

// 自动重载总开关
let autoReload = false;
// 当前文件在磁盘上已经不存在了（被外部删掉）—— 这种状态下自动重载没意义
let fileMissing = false;

/**
 * 自动重载现在能不能用？
 *
 * 自动重载的本质是"盯着磁盘上那个文件，有变化就把编辑区内容换掉"，
 * 所以前提有两个：
 *   1. 文件已经保存在磁盘上（新建的、还没保存的文件没有磁盘版本可盯）
 *   2. 编辑区里没有未保存的修改（有的话，一次刷新就把这些改动冲掉了）
 * 这两种情况下自动重载都是伪命题 → 按钮置灰，不给开。
 */
function autoReloadUsable() {
    return !!currentFile && !dirty && !fileMissing;
}

/** 自动重载不可用的原因（短句，给 tooltip 用） */
function autoReloadBlockedReason() {
    if (!currentFile) return '当前没有打开的文件';
    if (fileMissing) return '当前文件已被删除';
    if (dirty) return '编辑区里有未保存的修改';
    return '';
}

/** 点按钮时弹的完整提示（告诉用户接下来该干什么） */
function autoReloadBlockedTip() {
    if (!currentFile) return '当前没有打开的文件，保存后才能用自动重载';
    if (fileMissing) return '当前文件已被删除，自动重载暂时不可用';
    if (dirty) return '编辑区里有未保存的修改，保存后才能用自动重载';
    return '自动重载暂时不可用';
}

/** 同步自动重载按钮的可用状态（不可用时置灰，tooltip 说明为什么） */
function updateAutoReloadBtn() {
    const btn = document.getElementById('btn-auto-reload');
    if (!btn) return;
    // 状态已经不成立了还开着 → 关掉（否则文件没了，编辑器会一直卡在只读）
    if (autoReload && !autoReloadUsable()) autoReload = false;
    const usable = autoReloadUsable();
    btn.classList.toggle('disabled', !usable);
    btn.classList.toggle('on', autoReload);
    let title;
    if (autoReload) {
        title = '自动重载已开启：文件被外部修改时自动更新内容（编辑器为只读，点此关闭）';
    } else if (!usable) {
        title = '自动重载：文件被外部修改时自动更新内容（' + autoReloadBlockedReason() + '，暂时不可用）';
    } else {
        title = '自动重载：文件被外部修改时自动更新内容（开启后编辑器为只读）';
    }
    if (btn.title !== title) btn.title = title;
    applyReadOnly();
}

/** 开关切换 */
async function toggleAutoReload() {
    if (autoReload) {
        setAutoReload(false);
        return;
    }
    if (!autoReloadUsable()) {
        // 按钮虽然置灰了，点一下还是给个说法（比默默不响应好）
        showToast(autoReloadBlockedTip(), 2600);
        return;
    }
    setAutoReload(true);
}

/** 设置自动重载状态（并同步界面） */
function setAutoReload(on) {
    autoReload = !!on;
    updateAutoReloadBtn();
    showToast(autoReload ? '自动重载已开启（只读）' : '自动重载已关闭', 2200);
}

/** 自动重载开着时，编辑器变只读（防的是自动重载把用户正在写的内容冲掉） */
function applyReadOnly() {
    const readOnly = autoReload && !!currentFile;
    // 值没变就别写 DOM（updateFilename 每次输入都会走到这里）
    if (editor.readOnly !== readOnly) editor.readOnly = readOnly;
    // 只读时「保存 / 另存为」置灰（点了也存不了）
    ['btn-save', 'btn-save-as'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.classList.toggle('disabled', readOnly);
    });
}

// ============ 文字缩放 ============

// 缩放范围：80% ~ 150%
// 上限压到 150% 是因为字号放大而宽度不变时，每行能装的字会少一半，
// 字再大就"观感翻倍"、一行只剩几个字，很难读。
const ZOOM_MIN = 80, ZOOM_MAX = 150, ZOOM_STEP = 5;   // 5% 一档，10% 太粗

/** 应用缩放（只影响内容区：目录 / 编辑区 / 预览区） */
function applyZoom(percent) {
    // 吸附到 5% 的整数档：设置文件里可能存着旧的 10% 档以外的值，range 也会吸附，
    // 这里先统一，免得按钮文字和滑块位置对不上。
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(percent / ZOOM_STEP) * ZOOM_STEP));
    document.documentElement.style.setProperty('--ui-zoom', z / 100);
    // 字号变了 → 行高、内边距、字符宽度、工具栏尺寸的缓存值都过期了
    refreshEditorLineHeight();
    refreshEditorBox();
    measureSelToolbarBox();
    refreshFilenameTarget();
    const btn = document.getElementById('btn-zoom');
    if (btn) btn.textContent = '🔍 ' + z + '%';
    const val = document.getElementById('zoom-value');
    if (val) val.textContent = z + '%';
    const range = document.getElementById('zoom-range');
    if (range && Number(range.value) !== z) range.value = String(z);
    return z;
}

/** 改缩放并记住（下次启动仍然生效） */
function setZoom(percent) {
    const z = applyZoom(percent);
    settings.zoom = z;
    saveSettings();
}

function initZoom() {
    const range = document.getElementById('zoom-range');
    const popup = document.getElementById('zoom-popup');
    const btn = document.getElementById('btn-zoom');
    if (!range || !popup || !btn) return;

    applyZoom(settings.zoom || 100);

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const show = !popup.classList.contains('show');
        popup.classList.toggle('show', show);
        if (show) {
            // 面板开着的时候点别处就关掉
            setTimeout(() => {
                const close = (ev) => {
                    if (popup.contains(ev.target) || btn.contains(ev.target)) return;
                    popup.classList.remove('show');
                    document.removeEventListener('mousedown', close);
                };
                document.addEventListener('mousedown', close);
            }, 0);
        }
    });

    // 拖动时只改样式，松手（change）才落盘 —— input 事件很密，
    // 每动一下就写一次 settings.json（还是 fsync 的原子写）没必要。
    range.addEventListener('input', () => applyZoom(Number(range.value)));
    range.addEventListener('change', () => setZoom(Number(range.value)));

    popup.querySelectorAll('.zoom-btn[data-zoom]').forEach(b => {
        b.addEventListener('click', () => {
            setZoom((settings.zoom || 100) + Number(b.dataset.zoom));
        });
    });
    document.getElementById('zoom-reset').addEventListener('click', () => setZoom(100));
}

// ============ 设置 ============

const GITHUB_URL = 'https://github.com/oyksoft/VMD';

// 存的是设置文件（Rust 侧权威，%LOCALAPPDATA%\com.vmd.app\settings.json）
// 用文件而不是 localStorage：窗口底色在页面加载之前就要定下来，Rust 得能同步读到
let settings = {
    theme: 'auto',      // 默认主题：auto/dark/gray/light
    mode: 'read',       // 默认模式：read/edit
    ctxMenu: true,      // VMD 自己的右键菜单
    zoom: 100,          // 文字缩放（%）
    codeWrap: true,     // 预览区代码自动换行
    followCaret: true,  // 输入时预览区跟着光标走
    scrollSync: true,   // 编辑区与预览区滚动同步
};

function loadSettings() {
    // Rust 启动时已经把设置文件的内容注入进来了（同步可用，首帧就能用）
    if (window.__VMD_SETTINGS__ && typeof window.__VMD_SETTINGS__ === 'object') {
        Object.assign(settings, window.__VMD_SETTINGS__);
    } else {
        // 迁移：老版本把设置存在 localStorage，第一次改用文件存储时搬过来
        try {
            const raw = localStorage.getItem('vmd.settings');
            if (raw) {
                const obj = JSON.parse(raw);
                if (obj && typeof obj === 'object') {
                    Object.assign(settings, obj);
                    saveSettings();
                }
            }
        } catch (e) { /* 读不出来就用默认值 */ }
    }
    if (!THEMES[settings.theme]) settings.theme = 'auto';
    if (settings.mode !== 'edit') settings.mode = 'read';
    settings.ctxMenu = settings.ctxMenu !== false;
    // 代码换行默认开（旧设置文件里没这个字段 → 当作开）
    settings.codeWrap = settings.codeWrap !== false;
    // 光标跟随默认开
    settings.followCaret = settings.followCaret !== false;
    // 滚动同步默认开
    settings.scrollSync = settings.scrollSync !== false;
    let z = Number(settings.zoom);
    if (!isFinite(z)) z = 100;
    z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));   // 超出范围就钳到边界
    settings.zoom = z;
}

/** VMD 自己的右键菜单开没开（关掉后恢复浏览器原生菜单） */
function setCtxMenuEnabled(on) {
    settings.ctxMenu = !!on;
    saveSettings();
    // 必须立刻通知 Rust：它那边决定要不要屏蔽 WebView2 的原生菜单，
    // 两边不同步的话会出现"自定义菜单没了、原生菜单也没了"的情况
    invoke('set_context_menu_enabled', { enabled: settings.ctxMenu }).catch((e) => {
        showError('设置右键菜单失败', e);
    });
    syncSettingsUI();
}

// ---- 设置项：只保存，不动当前状态，下次启动才生效 ----

/** 默认主题（下次启动用） */
function setDefaultTheme(v) {
    settings.theme = v;
    saveSettings();
    syncSettingsUI();
}

/** 默认模式（下次启动用） */
function setDefaultMode(v) {
    settings.mode = v;
    saveSettings();
    syncSettingsUI();
}

/** 启动时是否启用软件内右键菜单（这个开关要立即生效，不然点了没反应） */
function setDefaultCtxMenu(v) {
    setCtxMenuEnabled(v === '1');
}

/** 预览区代码自动换行（立即生效：改的是当前预览，改完就该看到） */
function setCodeWrap(v) {
    settings.codeWrap = v === '1';
    applyCodeWrap();
    saveSettings();
    syncSettingsUI();
}

/** 把「代码换行」这个开关应用到 <html> 上 */
function applyCodeWrap() {
    document.documentElement.classList.toggle('code-wrap', !!settings.codeWrap);
}

/** 光标跟随（立即生效） */
function setFollowCaret(v) {
    settings.followCaret = v === '1';
    saveSettings();
    syncSettingsUI();
}

/** 编辑区与预览区的滚动同步（立即生效） */
function setScrollSync(v) {
    settings.scrollSync = v === '1';
    saveSettings();
    syncSettingsUI();
}

function saveSettings() {
    // 存到设置文件（Rust 写），下次启动时 Rust 会读它来决定窗口底色
    invoke('save_settings', { settings: settings }).catch((e) => {
        console.error('保存设置失败', e);
    });
}

/** 把设置面板里的按钮状态同步成当前值 */
function syncSettingsUI() {
    document.querySelectorAll('#set-theme .theme-chip').forEach(b => {
        b.classList.toggle('active', b.dataset.v === settings.theme);
    });
    document.querySelectorAll('#set-mode .seg-btn').forEach(b => {
        b.classList.toggle('is-active', b.dataset.v === settings.mode);
    });
    document.querySelectorAll('#set-ctx .seg-btn').forEach(b => {
        b.classList.toggle('is-active', (b.dataset.v === '1') === !!settings.ctxMenu);
    });
    document.querySelectorAll('#set-wrap .seg-btn').forEach(b => {
        b.classList.toggle('is-active', (b.dataset.v === '1') === !!settings.codeWrap);
    });
    document.querySelectorAll('#set-follow .seg-btn').forEach(b => {
        b.classList.toggle('is-active', (b.dataset.v === '1') === !!settings.followCaret);
    });
    document.querySelectorAll('#set-sync .seg-btn').forEach(b => {
        b.classList.toggle('is-active', (b.dataset.v === '1') === !!settings.scrollSync);
    });
}

/** 生成主题色块（颜色直接取自 THEMES，避免两处各写一份） */
function buildThemeChips() {
    const grid = document.getElementById('set-theme');
    if (!grid) return;
    grid.innerHTML = '';
    for (const key of THEME_ORDER) {
        const t = THEMES[key];
        if (!t) continue;
        const btn = document.createElement('button');
        btn.className = 'theme-chip';
        btn.dataset.v = key;
        btn.title = t.name;
        // emoji 打头：暗色/灰色这种相近的颜色靠色块分不出来
        const icon = document.createElement('span');
        icon.className = 'chip-icon';
        icon.textContent = t.icon || '';
        btn.appendChild(icon);
        const sw = document.createElement('span');
        sw.className = 'chip-swatch' + (key === 'auto' ? ' auto' : '');
        if (key !== 'auto' && t.vars) sw.style.background = t.vars['--bg'];
        btn.appendChild(sw);
        const name = document.createElement('span');
        name.textContent = t.short || t.name;
        btn.appendChild(name);
        // 悬停 = 整个窗体即时预览这个主题；移开色块区恢复
        btn.addEventListener('mouseenter', () => schedulePreview(key));
        grid.appendChild(btn);
    }
    grid.addEventListener('mouseleave', endPreview);
}

function openSettingsPanel() {
    document.getElementById('settings-panel').classList.add('show');
    syncSettingsUI();
    refreshShellMenuState();
    invoke('app_version')
        .then(v => { document.getElementById('app-version').textContent = 'v' + v; })
        .catch(() => { document.getElementById('app-version').textContent = ''; });
    // 告诉用户设置存在哪
    invoke('settings_path')
        .then(p => {
            document.getElementById('settings-path').textContent = p ? ('存储位置：' + p) : '';
        })
        .catch(() => { document.getElementById('settings-path').textContent = ''; });
}

function closeSettingsPanel() {
    document.getElementById('settings-panel').classList.remove('show');
    endPreview();   // 面板关了，预览也得恢复
}

// VMD 自己的右键菜单开关（设置项：只保存，下次启动生效）
document.querySelectorAll('#set-ctx .seg-btn').forEach(b => {
    b.addEventListener('click', () => setDefaultCtxMenu(b.dataset.v));
});
// 预览区代码自动换行（立即生效）
document.querySelectorAll('#set-wrap .seg-btn').forEach(b => {
    b.addEventListener('click', () => setCodeWrap(b.dataset.v));
});
// 输入时预览跟着光标走（立即生效）
document.querySelectorAll('#set-follow .seg-btn').forEach(b => {
    b.addEventListener('click', () => setFollowCaret(b.dataset.v));
});
// 编辑区与预览区的滚动同步（立即生效）
document.querySelectorAll('#set-sync .seg-btn').forEach(b => {
    b.addEventListener('click', () => setScrollSync(b.dataset.v));
});
// 系统右键菜单项（.md 文件右键时多一个「用 VMD 打开」）
document.getElementById('menu-on').addEventListener('click', async () => {
    try {
        await invoke('set_shell_menu', { enable: true });
        showToast('已添加「用 VMD 打开」菜单项', 2500);
    } catch (e) {
        showError('添加右键菜单失败', e);
    }
    refreshShellMenuState();
});
document.getElementById('menu-off').addEventListener('click', async () => {
    try {
        await invoke('set_shell_menu', { enable: false });
        showToast('已移除右键菜单项', 2500);
    } catch (e) {
        showError('移除右键菜单失败', e);
    }
    refreshShellMenuState();
});
async function refreshShellMenuState() {
    const el = document.getElementById('menu-state');
    try {
        const on = await invoke('shell_menu_status');
        el.textContent = on ? '当前：已添加' : '当前：未添加';
    } catch (e) {
        el.textContent = '';
    }
}

// 设置面板里的各项
document.getElementById('settings-close').addEventListener('click', closeSettingsPanel);
document.getElementById('btn-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    const panel = document.getElementById('settings-panel');
    if (panel.classList.contains('show')) closeSettingsPanel();
    else openSettingsPanel();
});
// 点面板外面就关掉
document.addEventListener('mousedown', (e) => {
    const panel = document.getElementById('settings-panel');
    if (!panel.classList.contains('show')) return;
    if (e.target.closest('#settings-panel') || e.target.closest('#btn-settings')) return;
    closeSettingsPanel();
});
// GitHub 链接交给系统浏览器打开
document.getElementById('app-github').addEventListener('click', (e) => {
    e.preventDefault();
    invoke('open_url', { url: GITHUB_URL }).catch(() => { window.open(GITHUB_URL, '_blank'); });
});
// 默认主题（设置项：只保存，下次启动生效）
// 色块是运行时生成的，所以用事件委托
document.getElementById('set-theme').addEventListener('click', (e) => {
    const chip = e.target.closest('.theme-chip');
    if (chip) setDefaultTheme(chip.dataset.v);
});
// 默认模式（设置项：只保存，下次启动生效）
document.querySelectorAll('#set-mode .seg-btn').forEach(b => {
    b.addEventListener('click', () => setDefaultMode(b.dataset.v));
});
// 文件关联
document.getElementById('assoc-on').addEventListener('click', async () => {
    try {
        await invoke('set_file_association', { enable: true });
        showToast('已关联 .md / .markdown', 2500);
    } catch (e) {
        showError('关联失败', e);
    }
});
document.getElementById('assoc-off').addEventListener('click', async () => {
    try {
        await invoke('set_file_association', { enable: false });
        showToast('已取消文件关联', 2500);
    } catch (e) {
        showError('取消关联失败', e);
    }
});

// ============ 通用模态对话框 ============

// 弹窗只有一套 DOM（#modal-mask + 三个按钮），同一时刻只能显示一个。
// 后来的请求排队，前一个关掉再弹下一个 —— 否则第二个 showDialog 会覆盖
// modalResolve，第一个的 Promise 永远不 settle，调用方的 await 悬空，
// 对应的守卫标志（changeDialogOpen / closeAskOpen）就永久卡住。
let modalResolve = null;
let modalQueue = [];

/** 填弹窗内容并显示 */
function renderDialog(opts) {
    const mask = document.getElementById('modal-mask');
    const bodyEl = document.getElementById('modal-body');
    const titleEl = document.getElementById('modal-title');
    const titleText = titleEl.querySelector('.modal-title-text');
    if (titleText) titleText.textContent = opts.title || '';
    else titleEl.textContent = opts.title || '';
    // 标题图标：圆形底 + 单色 SVG（stroke=currentColor → 跟随主题色）
    const icon = titleEl.querySelector('.modal-title-icon');
    if (icon) {
        if (opts.icon) {
            icon.style.display = 'inline-flex';
            icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + opts.icon + '</svg>';
            icon.classList.toggle('danger', !!opts.danger);
        } else {
            icon.style.display = 'none';
            icon.innerHTML = '';
        }
    }
    // body 可以是 HTML 字符串，也可以是 DOM 节点（文件名这种用节点更安全）
    bodyEl.innerHTML = '';
    if (typeof opts.body === 'string') {
        bodyEl.innerHTML = opts.body;
    } else if (opts.body) {
        bodyEl.appendChild(opts.body);
    }
    const okBtn = document.getElementById('modal-ok');
    const cancelBtn = document.getElementById('modal-cancel');
    const alwaysBtn = document.getElementById('modal-always');
    okBtn.textContent = opts.okText || '确定';
    cancelBtn.textContent = opts.cancelText || '取消';
    // 第三个按钮（"以后自动重载"）只在需要时显示
    if (opts.alwaysText) {
        alwaysBtn.textContent = opts.alwaysText;
        alwaysBtn.style.display = 'inline-block';
    } else {
        alwaysBtn.style.display = 'none';
    }
    // 「不保存」这类会丢数据的操作 → 红色描边（默认是弱化的文字按钮）
    alwaysBtn.classList.toggle('modal-btn-danger', !!opts.alwaysDanger);
    alwaysBtn.classList.toggle('modal-btn-text', !opts.alwaysDanger);
    // 只有一个按钮的面板（设置面板用）
    cancelBtn.style.display = opts.hideCancel ? 'none' : 'inline-block';
    mask.style.display = 'flex';
    okBtn.focus();
}

/** 弹出队列里的下一个（当前没有弹窗在显示时才会调） */
function openNextDialog() {
    if (modalResolve) return;
    const next = modalQueue.shift();
    if (!next) return;
    modalResolve = next.resolve;
    renderDialog(next.opts);
}

/** 把 invoke 的 reject 值（字符串或对象）变成一行可读文本 */
function errText(e) {
    if (e == null) return '';
    if (typeof e === 'string') return e;
    return e.message ? e.message : String(e);
}

/**
 * 统一的错误提示：应用内弹窗（只有一个「知道了」按钮）。
 * 不用浏览器原生 alert —— 它样式跟主题无关、阻塞、也不进弹窗队列。
 */
function showError(title, detail) {
    const body = document.createElement('div');
    body.className = 'modal-error';
    // textContent：错误信息里可能带 < > & 和长路径，绝不能当 HTML 解析
    body.textContent = errText(detail);
    showDialog({
        title,
        icon: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12.5"/><line x1="12" y1="16" x2="12" y2="16.1"/>',
        danger: true,
        body,
        okText: '知道了',
        hideCancel: true,
    });
}

function showDialog(opts) {
    return new Promise((resolve) => {
        modalQueue.push({ opts, resolve });
        if (!modalResolve) openNextDialog();
    });
}

function closeDialog(result) {
    const r = modalResolve;
    modalResolve = null;
    if (!r) return;
    if (modalQueue.length) {
        // 直接换内容接着弹下一个，遮罩不隐藏（不闪一下）
        openNextDialog();
    } else {
        const mask = document.getElementById('modal-mask');
        if (mask) mask.style.display = 'none';
    }
    r(result);
}

// ============ 导出 HTML ============

/** 取内嵌资源的文本（vendor 里的 css 走自定义协议，直接 fetch 就行） */
async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('读取失败：' + url);
    return r.text();
}

/** 二进制 → base64（btoa 只吃 latin1，要先转成二进制字符串） */
function bytesToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

/** 资源 → data URI */
async function fetchDataUri(url, mime) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('读取失败：' + url);
    const buf = await r.arrayBuffer();
    return 'data:' + mime + ';base64,' + bytesToBase64(buf);
}

/**
 * KaTeX 的 CSS：公式要自包含，字体得内嵌。
 * 只内嵌正文里真正用到的字体（getComputedStyle 能拿到实际用的 font-family），
 * 用不到的 @font-face 整个丢掉 —— 否则浏览器会去请求不存在的相对路径。
 */
async function buildKatexCss(roots) {
    const list = roots || Array.from(preview.querySelectorAll('.katex'));
    if (!list.length) return '';
    const used = new Set();
    const collect = (el) => {
        const ff = getComputedStyle(el).fontFamily || '';
        ff.split(',').forEach(f => used.add(f.trim().replace(/^["']|["']$/g, '')));
    };
    list.forEach(r => {
        collect(r);
        r.querySelectorAll('*').forEach(collect);
    });
    let css;
    try {
        css = await fetchText('vendor/katex/katex.min.css');
    } catch (e) {
        return '';
    }
    const blocks = css.match(/@font-face\{[^}]*\}/g) || [];
    for (const block of blocks) {
        const fam = (block.match(/font-family:([^;}]+)/) || [])[1];
        const url = (block.match(/url\(([^)]+)\)/) || [])[1];
        if (!fam || !url) continue;
        const name = fam.trim().replace(/^["']|["']$/g, '');
        if (!used.has(name)) {
            css = css.replace(block, '');
            continue;
        }
        const file = url.replace(/^["']|["']$/g, '');
        try {
            const data = await fetchDataUri('vendor/katex/' + file, 'font/woff2');
            css = css.replace(block, block.replace(url, 'url(' + data + ')'));
        } catch (e) {
            console.warn('字体内嵌失败：' + file, e);
        }
    }
    return css;
}

function escapeText(s) {
    // 手写转义：仓库里 HTML 实体字面量不可靠（现有的 escapeHtml 就是个空操作），用码点绕开
    const map = {
        '&': String.fromCharCode(38),
        '<': String.fromCharCode(60),
        '>': String.fromCharCode(62),
        '"': String.fromCharCode(34),
        "'": String.fromCharCode(39),
    };
    return String(s).replace(/[&<>"']/g, c => map[c]);
}

/** 组装导出的 HTML（自包含单文件：图片 base64、公式字体内嵌、配色用当前主题） */
async function buildExportHtml() {
    const theme = THEMES[activeTheme];
    const [exportCss, hljsCss, katexCss] = await Promise.all([
        fetchText('./export.css'),
        fetchText(theme.css).catch(() => ''),
        buildKatexCss(),
    ]);
    const themeVars = Object.entries(theme.vars).map(([k, v]) => `${k}:${v}`).join(';');
    // 代码换行：导出的是文档快照，应该和预览里看到的一致
    const codeWrapCss = settings.codeWrap
        ? '.doc pre{overflow-x:visible}.doc pre code{white-space:pre-wrap;overflow-wrap:anywhere}' +
          '.doc code{overflow-wrap:anywhere}.doc th code{white-space:pre-wrap;overflow-wrap:anywhere}'
        : '';
    const title = currentFile ? currentFile.replace(/^.*[\\\/]/, '') : '未命名';
    // 剔掉应用自己的 UI（代码块的语言标签 + 复制按钮），文档里不该有
    const clone = preview.cloneNode(true);
    clone.querySelectorAll('.code-block-header').forEach(el => el.remove());
    // 本地图片解析用的内部标记，导出时不要带出去
    clone.querySelectorAll('[data-vmd-img-tried],[data-vmd-img-orig]').forEach(el => {
        el.removeAttribute('data-vmd-img-tried');
        el.removeAttribute('data-vmd-img-orig');
    });
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeText(title)}</title>
<style>
:root{${themeVars}}
${exportCss}
${codeWrapCss}
${hljsCss}
${katexCss}
</style>
</head>
<body>
<article class="doc">
${clone.innerHTML}
</article>
</body>
</html>`;
}

/** 导出成自包含的单文件 HTML（图片转 base64、公式字体内嵌） */
async function exportHtml() {
    try {
        const baseName = currentFile
            ? currentFile.replace(/^.*[\\\/]/, '').replace(/\.[^.]+$/, '')
            : 'untitled';
        const path = await save({
            filters: [{ name: 'HTML', extensions: ['html'] }],
            defaultPath: baseName + '.html',
        });
        if (!path) return;

        showToast('正在导出 HTML…', 0);
        const html = await buildExportHtml();
        // 本地图片按 markdown 文件所在目录解析，Rust 侧转成 base64 内嵌
        const baseDir = currentFile ? currentFile.replace(/[^\\\/]+$/, '') : '';
        await invoke('export_html', { path, html, baseDir });
        showToast('HTML 已导出', 2500);
    } catch (e) {
        console.error(e);
        hideToast();
        showError('导出 HTML 失败', e);
    }
}

// 导出下拉菜单（PDF / HTML）
const exportDropdown = document.getElementById('export-dropdown');
const exportMenu = document.getElementById('export-menu');
exportDropdown.querySelector('.dropdown-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    exportDropdown.classList.toggle('open');
});
exportMenu.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.stopPropagation();
        exportDropdown.classList.remove('open');
        if (item.dataset.fmt === 'pdf') exportPdf();
        else if (item.dataset.fmt === 'html') exportHtml();
    });
});
document.addEventListener('click', () => {
    exportDropdown.classList.remove('open');
});

// ============ 导出 PDF ============

async function exportPdf() {
    try {
        const baseName = currentFile
            ? currentFile.replace(/^.*[\\\/]/, '').replace(/\.[^.]+$/, '')
            : 'untitled';
        const path = await save({
            filters: [{ name: 'PDF', extensions: ['pdf'] }],
            defaultPath: baseName + '.pdf',
        });
        if (!path) return;

        showToast('正在导出 PDF…', 0);
        // 临时切到打印模式：只保留预览内容（隐藏工具栏/目录/编辑区）+ 浅色配色
        const prevHljs = document.querySelector('link[data-hljs]')?.href || null;
        document.querySelectorAll('link[data-hljs]').forEach(l => l.remove());
        const lightLink = document.createElement('link');
        lightLink.rel = 'stylesheet';
        lightLink.href = 'vendor/highlight-light.css';
        lightLink.dataset.hljs = '1';
        document.head.appendChild(lightLink);
        document.body.classList.add('print-mode');
        document.documentElement.classList.add('print-mode');   // html 也要放开 height/overflow
        // 等本地图片转成 data URI（图片是异步转的，不等会打印出空图）
        await whenLocalImagesReady();
        // 等浏览器完成布局刷新，确保打印的是新样式
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        try {
            await invoke('export_pdf', { path });
            showToast('PDF 已导出', 2500);
        } catch (e) {
            console.error(e);
            showError('导出 PDF 失败', e);
            hideToast();
        } finally {
            document.body.classList.remove('print-mode');
            document.documentElement.classList.remove('print-mode');
            // 恢复原来的代码高亮主题
            document.querySelectorAll('link[data-hljs]').forEach(l => l.remove());
            if (prevHljs) {
                const back = document.createElement('link');
                back.rel = 'stylesheet';
                back.href = prevHljs;
                back.dataset.hljs = '1';
                document.head.appendChild(back);
            }
        }
    } catch (e) {
        showError('导出 PDF 失败', e);
    }
}

// ============ 快捷键 ============

document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    // ⚠️ 按住 Shift 时 e.key 是**大写字母**（Ctrl+Shift+S 的 key 是 'S' 不是 's'），
    //    所以这里必须统一转小写再比 —— 不然 Ctrl+Shift+S / Ctrl+Shift+E / Ctrl+Shift+H
    //    一个都触发不了。
    const k = (e.key || '').toLowerCase();
    if (ctrl && k === 'o') { e.preventDefault(); openFile(); }
    else if (ctrl && e.shiftKey && k === 's') { e.preventDefault(); saveAsFile(); }
    else if (ctrl && e.shiftKey && k === 'e') { e.preventDefault(); exportPdf(); }
    else if (ctrl && !e.shiftKey && k === 's') { e.preventDefault(); saveFile(); }
    else if (ctrl && k === 'n') { e.preventDefault(); document.getElementById('btn-new').click(); }
    else if (ctrl && !e.shiftKey && k === 'f') { e.preventDefault(); openFindBar(false); }
    else if (ctrl && e.shiftKey && k === 'h') { e.preventDefault(); openFindBar(true); }
    // ---- 标题 / 列表快捷键 ----
    // ⚠️ 这些都是**改编辑区内容**的快捷键，必须要求焦点在编辑区 ——
    //    否则在设置面板（滑块、输入框）里按 Ctrl+1 也会去改正文。
    // ⚠️ Ctrl+1/2/3 在 Chrome 里是「切换标签页」的保留键，可能根本收不到。
    //    收不到就得去 WebView2 层拦（见 main.rs 的 install_reload_blocker），
    //    拦完记得 emit 事件通知前端。
    else if (ctrl && !e.shiftKey) {
        const m = /^Digit([1-6])$/.exec(e.code || '');
        if (m) {
            if (document.activeElement !== editor) return;
            e.preventDefault();
            applyHeading(Number(m[1]));
        }
        // ---- 格式化快捷键（只在编辑区聚焦时才生效）----
        else if (document.activeElement === editor) {
            if (e.code === 'KeyB') { e.preventDefault(); formatSelection('bold'); }
            else if (e.code === 'KeyI') { e.preventDefault(); formatSelection('italic'); }
            else if (e.code === 'Backquote') { e.preventDefault(); formatSelection('code'); }
        }
    } else if (ctrl && e.shiftKey && e.code === 'Digit7') {
        if (document.activeElement !== editor) return;
        e.preventDefault(); applyList('ol');
    }
    else if (ctrl && e.shiftKey && e.code === 'Digit8') {
        if (document.activeElement !== editor) return;
        e.preventDefault(); applyList('ul');
    }
    else if (ctrl && e.shiftKey && e.code === 'KeyX' && document.activeElement === editor) {
        e.preventDefault(); formatSelection('strike');   // 删除线
    }
});

// ============ TOC 高亮 ============
//
// ⚠️ 滚动的是 **#preview-wrap**，#preview 那个 article 高度自适应、自己不滚动 ——
//    scroll 事件必须挂在 previewScroll 上（挂到 preview 上等于永远不触发）。
let tocHighlightPending = false;

/** 标出当前读到的章节（预览区滚到哪个标题下面了） */
/** 滚动时刷新高亮：一帧最多算一次（编辑区滚动会带着预览区滚，事件很密） */
function scheduleTocHighlight() {
    if (tocHighlightPending) return;
    tocHighlightPending = true;
    requestAnimationFrame(() => {
        tocHighlightPending = false;
        updateTocHighlight();
    });
}

// 目录高亮跟着**编辑区顶行**走（编辑区是“真相”）——
// 预览区滚动时编辑区会跟着同步，一样会触发这个。
if (previewScroll) previewScroll.addEventListener('scroll', scheduleTocHighlight, { passive: true });
// 目录滚动位置缓存（scroll 事件里布局已算好，读 scrollTop 不会触发重排）
tocList.addEventListener('scroll', () => { tocKeepScroll = tocList.scrollTop; }, { passive: true });
editor.addEventListener('scroll', scheduleTocHighlight, { passive: true });

// ============ 面板拖拽调整宽度 ============
// 用 pointer capture + 不调 preventDefault，这样既不丢事件，浏览器也不阻塞默认行为。
// 计算简单：cursor 像素差 = 宽度像素差。

const MIN_TOC = 100;
const MIN_PREVIEW = 400;  // 预览区最小宽度，保证可读
const MIN_EDITOR = 250;  // 编辑区最小宽度
const DEFAULT_TOC = 240;

const content = document.getElementById('content');
const splitToc = document.getElementById('split-toc');
const splitPreview = document.getElementById('split-preview');
const tocEl = document.getElementById('toc');
const editorEl = document.getElementById('editor-wrap');
const previewEl = document.getElementById('preview-wrap');

let tocW = DEFAULT_TOC;
let editorW = 0;  // 0 = 用 flex 自适应初始宽度

function applyWidths(clearEditor) {
    // 面板宽度变了 → 工具栏布局变了 → 文件名可用宽度要重算
    refreshFilenameTarget();
    // ⚠️ 编辑区在视口里的位置也跟着变了 → 浮动工具栏的位置缓存要刷新
    //    （否则拖完分隔条，选区工具栏会出现在错误的地方）
    refreshEditorBox();
    const total = content.clientWidth;
    const t = Math.max(MIN_TOC, Math.min(tocW, total - MIN_EDITOR - MIN_PREVIEW));
    tocEl.style.width = t + 'px';
    if (clearEditor) {
        editorEl.style.width = '';
        editorW = 0;
    }
    // 查找栏开着时，位置/宽度要跟着目标区域走
    const fb = document.getElementById('find-bar');
    if (fb && fb.classList.contains('open')) placeFindBar();
}

function setupSplitter(splitter, onMove) {
    let dragging = false;
    let startX = 0;
    let startTocW = 0;
    let startEditorW = 0;

    splitter.addEventListener('pointerdown', (e) => {
        // 不调 preventDefault！否则 Chrome 会停止发送 pointer 事件。
        e.stopPropagation();
        dragging = true;
        startX = e.clientX;
        startTocW = parseFloat(getComputedStyle(tocEl).width) || DEFAULT_TOC;
        startEditorW = editorEl.getBoundingClientRect().width;
        try { splitter.setPointerCapture(e.pointerId); } catch (_) {}
        splitter.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
    });

    function onPointerMove(e) {
        if (!dragging) return;
        const delta = e.clientX - startX;
        onMove(delta, startTocW, startEditorW);
    }
    function endDrag(e) {
        if (!dragging) return;
        dragging = false;
        try { splitter.releasePointerCapture(e.pointerId); } catch (_) {}
        splitter.classList.remove('dragging');
        document.body.style.cursor = '';
    }
    splitter.addEventListener('pointermove', onPointerMove);
    splitter.addEventListener('pointerup', endDrag);
    splitter.addEventListener('pointercancel', endDrag);
    splitter.addEventListener('lostpointercapture', endDrag);
}

// 拖 TOC 分隔条：改 toc 宽度（editor/preview 自动 flex 填充）
setupSplitter(splitToc, (delta, startToc) => {
    const total = content.clientWidth;
    // toc 最大能到：总宽 - editor 最小 - preview 最小 - 2 个分隔条
    const maxToc = Math.max(MIN_TOC, total - 2 - MIN_EDITOR - MIN_PREVIEW);
    tocW = Math.max(MIN_TOC, Math.min(maxToc, startToc + delta));
    applyWidths(true);
});

// 拖 Preview 分隔条：editor 增/缩，但 preview 至少留 MIN_PREVIEW
setupSplitter(splitPreview, (delta, _st, startEd) => {
    const total = content.clientWidth;
    const tocW0 = parseFloat(getComputedStyle(tocEl).width) || DEFAULT_TOC;
    // editor 最大能到：总宽 - toc - 2 个 1px 分隔条 - preview 最小
    // 但下限至少 MIN_EDITOR（防止 maxEditor 负数 → editor 0 → preview 负）
    const maxEditor = Math.max(MIN_EDITOR, total - tocW0 - 2 - MIN_PREVIEW);
    const desired = startEd + delta;
    editorW = Math.max(MIN_EDITOR, Math.min(maxEditor, desired));
    editorEl.style.width = editorW + 'px';

});

splitToc.addEventListener('dblclick', () => {
    tocW = DEFAULT_TOC;
    applyWidths(true);
});
splitPreview.addEventListener('dblclick', () => {
    editorEl.style.width = '';
    editorW = 0;
    applyWidths();
});

window.addEventListener('resize', () => {
    // 窗口大小变了 → 查找栏的位置/宽度也得重算
    const fb = document.getElementById('find-bar');
    if (fb && fb.classList.contains('open')) placeFindBar();
    // 窗口缩放时保持 tocW 和 editorW，只让 preview 自适应
    if (editorW > 0) editorEl.style.width = editorW + 'px';
    tocEl.style.width = tocW + 'px';
    // 不调 applyWidths（它会清空 editor width）
    // 窗口宽度变了 → 文件名可用的宽度也变了 → 重新省略
    fitFilename();
});

// ============ 启动 ============

// 立即同步更新主题按钮（不等 async，避免显示旧值）
updateThemeButton();
(async function start() {
    // 先读设置（默认主题 / 默认模式）
    loadSettings();
    // 设置面板里的主题色块
    buildThemeChips();
    // 文字缩放
    initZoom();
    // 代码自动换行（首帧已由 theme.js 决定，这里再同步一次，保证与设置面板一致）
    applyCodeWrap();
    // 主题：默认跟随系统，用户在设置里改过就用他选的
    await applyTheme(settings.theme);
    fetchSystemTheme();   // 预热系统主题（"自动"色块的悬停预览要用）
    updateThemeButton();
    // 模式：默认阅读模式
    setEditMode(settings.mode === 'edit');
    // VMD 自己的右键菜单
    invoke('set_context_menu_enabled', { enabled: settings.ctxMenu !== false }).catch(() => { /* 忽略 */ });
    renderPreview();
    applyWidths(true);
    refreshEditorLineHeight();

    // 启动文件（用文件关联双击打开）：
    // Rust 已经把内容注进来了 → 首帧就是它；这里只补一下"大文件"的情况
    // （超过 512KB 的没注入内容，异步读一次）
    if (currentFile && STARTUP.content == null) {
        try {
            const file = await invoke('read_file', { path: currentFile });
            editor.value = file.content;
            currentEncoding = file.encoding || 'utf-8';
            renderPreview();
        } catch (e) {
            editor.value = WELCOME;
            currentFile = null;
            renderPreview();
        }
    }
    if (currentFile) {
        updateFilename();
        recordStamp();
    }
    // 上次没能正常退出的话（崩溃/断电），把没保存的内容捞回来
    maybeOfferDraftRestore();
})();

// 外部修改检测：每 3 秒查一次（窗口没焦点时不查，切回来立刻查）
setInterval(checkExternalChange, 3000);
// 崩溃恢复：有未保存修改时定时快照（不是自动保存，见 maybeSaveDraft 注释）
setInterval(maybeSaveDraft, DRAFT_INTERVAL);
if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('tauri://focus', () => {
        winFocused = true;
        checkExternalChange();
    });
    window.__TAURI__.event.listen('tauri://blur', () => { winFocused = false; });
}

// =================== 自定义右键菜单 ===================
(function () {
    const ctxMenu = document.getElementById('ctx-menu');
    const editor = document.getElementById('editor');
    const preview = document.getElementById('preview');         // 点击区域检测
    const previewScroll = document.getElementById('preview-wrap'); // 可滚动容器
    let menuTarget = null;   // 'editor' | 'preview'
    let menuLink = null;     // 当点在链接上，记录 <a>

    function closeMenu() {
        ctxMenu.style.display = 'none';
        menuTarget = null;
        menuLink = null;
    }

    function showMenu(x, y) {
        // 先设为隐藏 + display:block，让浏览器能测尺寸但不画到屏幕，一次定位完成
        ctxMenu.style.visibility = 'hidden';
        ctxMenu.style.left = '0px';
        ctxMenu.style.top = '0px';
        ctxMenu.style.display = 'block';
        const w = ctxMenu.offsetWidth;
        const h = ctxMenu.offsetHeight;
        // 量一下二级菜单的尺寸（临时显示，量完就藏）——
        // 用实际尺寸判断往哪边展开，比拍脑袋估一个 210px 准得多
        // （“链接 [文字](url)”那一行比预想的宽）。
        let subW = 0, subH = 0;
        const sub = ctxMenu.querySelector('.ctx-submenu');
        if (sub) {
            sub.style.display = 'block';
            subW = sub.offsetWidth;
            subH = sub.offsetHeight;
            sub.style.display = '';
        }
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        let newX = x, newY = y;
        if (newX + w > winW) newX = winW - w - 4;   // 右边不够 → 靠右
        if (newY + h > winH) newY = y - h - 4;       // 下边不够 → 菜单画在鼠标上方（而不是贴窗底，避免鼠标在菜单内）
        if (newX < 4) newX = 4;
        if (newY < 4) newY = 4;
        // 二级菜单往右展开 → 右边得再留出它的宽度，否则会跑出屏幕点不到
        let subLeft = false;
        if (subW > 0 && newX + w + subW + 4 > winW) {
            subLeft = true;
            // 翻到左侧后子菜单占 [newX+8-subW, newX+8]，得在屏幕内
            if (newX < subW - 8) newX = Math.max(4, subW - 8);
        }
        ctxMenu.classList.toggle('ctx-sub-left', subLeft);
        // 二级菜单往下展开 → 下方得留出它的高度；“插入”在菜单最后一项，
        // 菜单靠下时子菜单会跑出屏幕底部 → 改成向上展开
        ctxMenu.classList.toggle('ctx-sub-up', subH > 0 && newY + h + subH + 4 > winH);
        ctxMenu.style.left = newX + 'px';
        ctxMenu.style.top = newY + 'px';
        ctxMenu.style.visibility = 'visible';
    }

    function item(label, opts = {}) {
        const dis = opts.disabled ? ' ctx-item-disabled' : '';
        const danger = opts.danger ? ' ctx-item-danger' : '';
        const icon = opts.icon ? `<span class="ctx-item-icon">${opts.icon}</span>` : '';
        const shortcut = opts.shortcut ? `<span class="ctx-item-shortcut">${escHTML(opts.shortcut)}</span>` : '';
        return `<div class="ctx-item${dis}${danger}" data-act="${opts.act}">${icon}<span class="ctx-item-label">${escHTML(label)}</span>${shortcut}</div>`;
    }

    /**
     * 带二级菜单的菜单项。
     * 子菜单嵌套在父项内部（:hover 才显示）—— 见 style.css 里 .ctx-submenu 的说明。
     */
    function subItem(label, key, icon, childrenHtml) {
        return `<div class="ctx-item ctx-item-has-sub" data-sub="${key}">` +
            `<span class="ctx-item-icon">${icon}</span>` +
            `<span class="ctx-item-label">${escHTML(label)}</span>` +
            `<span class="ctx-item-arrow">›</span>` +
            `<div class="ctx-submenu">${childrenHtml}</div>` +
            `</div>`;
    }

    function sep() {
        return '<div class="ctx-separator"></div>';
    }

    // 会改编辑器内容的操作。
    // 注意：textarea 的 readOnly 只拦键盘输入，程序直接改 value 照样能改 ——
    // 所以只读模式下这些项必须单独挡住，否则"只读却能改"。
    const EDIT_ACTIONS = new Set([
        'undo', 'redo', 'cut', 'paste',
        'insert-link', 'insert-codeblock', 'insert-table', 'insert-image',
    ]);

    function editorMenu() {
        const ro = editor.readOnly;   // 自动重载开着 = 只读
        return [
            item('撤销',  { act: 'undo',  icon: '↶', shortcut: 'Ctrl+Z', disabled: ro }),
            item('重做',  { act: 'redo',  icon: '↷', shortcut: 'Ctrl+Y', disabled: ro }),
            sep(),
            item('剪切', { act: 'cut', icon: '✂', shortcut: 'Ctrl+X', disabled: ro }),
            item('复制', { act: 'copy', icon: '📋', shortcut: 'Ctrl+C' }),
            item('粘贴', { act: 'paste', icon: '📥', shortcut: 'Ctrl+V', disabled: ro }),
            sep(),
            item('全选', { act: 'selectAll', icon: '🔲', shortcut: 'Ctrl+A' }),
            sep(),
            // ---- 插入区：纯插入（会替换掉当前选区），归到二级菜单里 ----
            // ⚠️ 这里**不再放**加粗/斜体/代码那些格式化项 —— 它们由「选区浮动工具栏」
            //    负责（选中文字就自动浮现），重复放两份是冗余。
            subItem('插入', 'insert', '➕', [
                item('链接 [文字](url)', { act: 'insert-link', icon: '🔗', disabled: ro }),
                item('图片',             { act: 'insert-image', icon: '🖼', disabled: ro }),
                item('代码块 ```',       { act: 'insert-codeblock', icon: '{ }', disabled: ro }),
                item('表格',             { act: 'insert-table', icon: '⊞', disabled: ro }),
            ].join('')),
        ].join('');
    }

    function previewMenu() {
        const hasSel = !!window.getSelection().toString();
        return [
            item('复制',         { act: 'copy',         icon: '📋', shortcut: 'Ctrl+C', disabled: !hasSel }),
            item('全选',         { act: 'selectAll',    icon: '🔲', shortcut: 'Ctrl+A' }),
            sep(),
            item('回到顶部',     { act: 'scrollTop',    icon: '⤴' }),
            item('跳到底部',     { act: 'scrollBottom', icon: '⤵' }),
            sep(),
            menuLink
                    ? item('打开链接：' + (menuLink.textContent || menuLink.href).slice(0, 18) + ((menuLink.textContent || menuLink.href).length > 18 ? '…' : ''),
                          { act: 'open-link', icon: '🔗' })
                    : ''
        ].filter(Boolean).join('');
    }

    function openContextMenu(x, y, target) {
        menuTarget = target;
        ctxMenu.innerHTML = target === 'editor' ? editorMenu() : previewMenu();
        showMenu(x, y);
    }

    // 拦截全局 contextmenu + mousedown(右键) 双保险
    // WebView2 默认菜单会拦截 contextmenu 事件不派发到 DOM，所以同时监听 mousedown.button===2
    // 在菜单刚打开时设个“防护”标记，期间忽略点击（防右键连带 click 关掉菜单）
    let protectUntil = 0;
    function handleRightClick(e) {
        // 设置里关掉了 VMD 自己的右键菜单 → 放行，交给浏览器原生菜单
        if (!settings.ctxMenu) return;
        const targetEl = e.target;
        // 点菜单本身 → 不处理
        if (targetEl.closest('#ctx-menu')) return;
        // 点 toolbar/splitter → 不动作（菜单不出现）
        if (targetEl.closest('#toolbar') || targetEl.closest('.splitter')) return;
        e.preventDefault();
        e.stopPropagation();
        // 右键连带防护窗：右键后 50ms 内 的 click 是右键本身带的，不关菜单
        protectUntil = Date.now() + 50;
        if (targetEl.closest('#editor')) {
            openContextMenu(e.clientX, e.clientY, 'editor');
        } else if (targetEl.closest('#preview')) {
            const a = targetEl.closest('a[href]');
            menuLink = a || null;
            openContextMenu(e.clientX, e.clientY, 'preview');
        } else {
            closeMenu();
        }
    }
    // 用捕获阶段（capture:true），在事件到达 target 之前拦住，避免 WebView2 默认菜单出现
    document.addEventListener('contextmenu', handleRightClick, { capture: true });
    // mousedown.button===2 走 handleRightClick（捕获阶段拦截，阻止原生 contextmenu 出现）
    document.addEventListener('mousedown', (e) => {
        if (e.button === 2) {
            if (!settings.ctxMenu) return;   // 关掉了就放行原生菜单
            e.preventDefault();
            e.stopImmediatePropagation();
            handleRightClick(e);
        }
    }, { capture: true });

    // 点击任意位置或滚动时关闭（但菜单自身的点击交给下面的 ctxMenu.addEventListener）
    document.addEventListener('click', (e) => {
        // 右键后防护窗内，所有 click 都忽略（不关菜单）
        if (Date.now() < protectUntil) return;
        // 点菜单内部则不关（菜单自己处理）
        if (e.target.closest('#ctx-menu')) return;
        // 只在左键点其他位置时关
        if (e.button === 0) closeMenu();
    });
    // 右键后事件 WebView2 可能会用 mousedown.button=0 重发个“点空位”的事件——也兜底
    document.addEventListener('mousedown', (e) => {
        if (Date.now() < protectUntil) return;
        if (e.button !== 0) return;       // 只要左键
        if (e.target.closest('#ctx-menu')) return;
        closeMenu();
    });
    document.addEventListener('scroll', () => closeMenu(), true);
    window.addEventListener('blur', () => closeMenu());
    // 窗口尺寸变了 → 菜单（fixed 定位）会停在旧位置，可能跑到屏幕外 → 直接关掉
    window.addEventListener('resize', () => closeMenu());

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
    });

    // 菜单项点击
    ctxMenu.addEventListener('click', async (e) => {
        const row = e.target.closest('.ctx-item');
        if (!row || row.classList.contains('ctx-item-disabled')) return;
        // 点到二级菜单的父项（如“插入”）→ 只是展开子菜单，不执行任何动作
        if (row.classList.contains('ctx-item-has-sub')) return;
        const act = row.dataset.act;

        // 只读（自动重载）模式下不许改内容 —— 菜单项已经置灰，这里再挡一道（菜单可能是只读前打开的）
        if (menuTarget === 'editor' && editor.readOnly && EDIT_ACTIONS.has(act)) {
            showToast('自动重载模式下内容是只读的');
            closeMenu();
            return;
        }

        // ----- textarea 操作 -----
        if (menuTarget === 'editor') {
            // ⚠️ 点菜单时编辑区已经失焦（焦点被菜单抢走）——
            //    execCommand('undo'/'redo'/'cut'/'copy') 作用在失焦的编辑区上会无效，
            //    所以每个命令前都要先把焦点抢回来。preventScroll 防止视图乱跳。
            if (act === 'undo') { editor.focus({ preventScroll: true }); document.execCommand('undo'); }
            else if (act === 'redo') { editor.focus({ preventScroll: true }); document.execCommand('redo'); }
            else if (act === 'cut') { editor.focus({ preventScroll: true }); document.execCommand('cut'); }
            else if (act === 'copy') { editor.focus({ preventScroll: true }); document.execCommand('copy'); }
            else if (act === 'paste')  { editor.focus({ preventScroll: true }); document.execCommand('paste'); }
            else if (act === 'selectAll') editor.select();
            // 插入模板（会替换掉当前选区 —— 这是“插入”的语义）
            else if (act === 'insert-link')       insertAtCursor('[文字](https://)');
            else if (act === 'insert-codeblock')  insertAtCursor('\n```\n代码\n```\n');
            else if (act === 'insert-table')      insertAtCursor('\n| 列1 | 列2 |\n|---|---|\n| 内容 | 内容 |\n');
            // 插入图片：要弹文件选择框，得异步 —— 先把菜单关了
            else if (act === 'insert-image')      { closeMenu(); insertImage(); }
        }
        // ----- preview 操作 -----
        else if (menuTarget === 'preview') {
            if (act === 'copy')       copyPreviewSelection();
            else if (act === 'selectAll') selectPreview();
            else if (act === 'scrollTop')    previewScroll.scrollTop = 0;
            else if (act === 'scrollBottom') previewScroll.scrollTop = previewScroll.scrollHeight;
            else if (act === 'open-link' && menuLink) {
                const url = menuLink.href;
                if (url.startsWith('http')) {
                    try { invoke('open_url', { url }); } catch (e) { console.warn(e); }
                }
            }
        }

        // 触发渲染刷新（仅编辑器内容变更才重新渲染，preview 内操作不需要）
        if (menuTarget === 'editor') renderPreview();
        closeMenu();
    });

    // 直接改 editor.value 不会触发 input 事件 → dirty 标记要手动打，
    // 否则标题栏不显示 ●，用户以为没改就关窗口，改动静默丢失
    // （markEdited 现在是模块级的函数，见上方定义）

    // textarea 工具函数

    /**
     * 右键菜单改内容：插入 / 包裹。
     *
     * ⚠️ 必须走 `replaceSelectionKeepingUndo()`（内部用 execCommand('insertText')），
     *    **不能**直接改 `editor.value` —— 直接改会把浏览器的撤销历史冲掉，
     *    插入完按 Ctrl+Z 撤销不了（这个坑踩过）。
     *
     * @param text      要插入 / 替换的文本
     * @param selStart  替换区间起点
     * @param selEnd    替换区间终点（= selStart 就是纯插入）
     * @param caret     true = 光标落在插入内容末尾；false = 选中插入内容
     */
    function copyPreviewSelection() {
        const s = window.getSelection();
        if (s && s.toString()) {
            navigator.clipboard.writeText(s.toString()).catch(() => {});
        }
    }

    function selectPreview() {
        const range = document.createRange();
        range.selectNodeContents(preview);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
})();
