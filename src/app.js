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

const THEMES = {
    auto: {
        name: '跟随系统',
        icon: '🖥️',
        css: null,   // 自动时用实际的 light/dark
        vars: null,
    },
    dark: {
        name: '暗色',
        icon: '🌙',
        css: 'vendor/highlight-dark.css',
        vars: {
            '--bg': '#0d1117',
            '--bg-panel': '#161b22',
            '--bg-elevated': '#21262d',
            '--bg-code': '#161b22',
            '--border': '#30363d',
            '--border-soft': 'rgba(255,255,255,0.09)',
            '--text': '#c9d1d9',
            '--text-strong': '#f0f6fc',
            '--text-dim': '#8b949e',
            '--link': '#58a6ff',
            '--accent': '#58a6ff',
            '--quote-bar': '#3b434b',
            '--quote-text': '#8b949e',
        },
    },
    gray: {
        name: '灰色',
        icon: '🌫️',
        css: 'vendor/highlight-gray.css',
        vars: {
            '--bg': '#22252a',
            '--bg-panel': '#2b2f36',
            '--bg-elevated': '#383d45',
            '--bg-code': '#2b2f36',
            '--border': '#454b54',
            '--border-soft': 'rgba(255,255,255,0.10)',
            '--text': '#d2d6db',
            '--text-strong': '#f2f4f7',
            '--text-dim': '#9aa3ae',
            '--link': '#7fb3f5',
            '--accent': '#7fb3f5',
            '--quote-bar': '#5a616b',
            '--quote-text': '#aab2bd',
        },
    },
    light: {
        name: '浅色',
        icon: '☀️',
        css: 'vendor/highlight-light.css',
        vars: {
            '--bg': '#ffffff',
            '--bg-panel': '#f6f8fa',
            '--bg-elevated': '#eaeef2',
            '--bg-code': '#f6f8fa',
            '--border': '#d0d7de',
            '--border-soft': 'rgba(27,31,36,0.12)',
            '--text': '#24292f',
            '--text-strong': '#0d1117',
            '--text-dim': '#57606a',
            '--link': '#0969da',
            '--accent': '#0969da',
            '--quote-bar': '#d0d7de',
            '--quote-text': '#57606a',
        },
    },
};

// 主题循环顺序
const THEME_ORDER = ['auto', 'dark', 'gray', 'light'];

let currentTheme = 'auto';   // 用户选的（可能是 auto）
let activeTheme = 'dark';    // 实际生效的（auto 时是系统决定的）
let currentAppTheme = 'dark'; // 供 Mermaid 选择配色用

/** 读系统当前是亮还是暗 */
function systemPrefersDark() {
    return !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
}

/** 把某个具体主题的 CSS 变量和 hljs 样式应用上去 */
function applyConcreteTheme(key) {
    const t = THEMES[key];
    const root = document.documentElement;
    for (const [k, v] of Object.entries(t.vars)) {
        root.style.setProperty(k, v);
    }
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
        let sys = 'light';
        try {
            sys = await invoke('system_theme');
        } catch (e) {
            sys = systemPrefersDark() ? 'dark' : 'light';
        }
        activeTheme = sys;
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
    applyConcreteTheme(activeTheme);
    renderPreview();
    updateThemeButton();
}

// 跟随系统时，系统主题变化要实时响应
// 监听 Tauri 的 tauri://theme-changed（窗口主题保持 Auto，tao 仍会感知系统变化）
if (window.__TAURI__ && window.__TAURI__.event) {
    window.__TAURI__.event.listen('tauri://theme-changed', () => {
        if (currentTheme === 'auto') applyTheme('auto');
    });
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
function highlightCodeBlocks() {
    if (!window.hljs) return;
    const pres = Array.from(preview.querySelectorAll('pre'));
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
function wrapTables() {
    const tables = Array.from(preview.querySelectorAll('table'));
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
const filenameEl = document.getElementById('filename');
const statusEl = document.getElementById('status');

// 预览中的链接点击 → 外部调系统浏览器打开，避免 WebView 被跳走
preview.addEventListener('click', async (e) => {
    const a = e.target.closest('a');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (!href) return;
    if (href.startsWith('#')) return;   // 锚点不处理（marked 会渲染成普通链接）
    try {
        await invoke('open_url', { url: href });
    } catch (err) {
        console.warn('open url failed:', err);
    }
});

let currentFile = null;
let dirty = false;

const WELCOME = `# 欢迎使用 VMD 👋

一个用 Tauri + 系统 WebView 写的 markdown viewer。

## 主要特性

- ✨ 实时预览，所见即所得
- 🎨 彩色 emoji (Twemoji)
- 🖱️ 左侧目录，点击跳转
- ⌨️ 快捷键：Ctrl+O 打开 · Ctrl+S 保存 · Ctrl+Shift+S 另存为

## 代码高亮

\`\`\`rust
fn main() {
    println!("Hello, VMD!");
}
\`\`\`

## 表格

| 名称 | 描述 |
|------|------|
| Rust | 🦀 系统编程 |
| VMD  | markdown viewer |
`;

editor.value = WELCOME;

// ============ 渲染 ============

let renderTimer = null;
editor.addEventListener('input', () => {
    dirty = true;
    updateFilename();
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(renderPreview, 100);
});

// 编辑区滚动 → 同步到预览区
const previewScroll = document.getElementById('preview-wrap');
let syncing = false;
editor.addEventListener('scroll', () => {
    if (syncing || !previewScroll) return;
    syncing = true;
    const maxEdit = editor.scrollHeight - editor.clientHeight;
    const maxPrev = previewScroll.scrollHeight - previewScroll.clientHeight;
    if (maxEdit > 0 && maxPrev > 0) {
        previewScroll.scrollTop = (editor.scrollTop / maxEdit) * maxPrev;
    }
    requestAnimationFrame(() => { syncing = false; });
});
// 反向同步：预览区滚动 → 编辑区
previewScroll && previewScroll.addEventListener('scroll', () => {
    if (syncing || !editor) return;
    syncing = true;
    const maxEdit = editor.scrollHeight - editor.clientHeight;
    const maxPrev = previewScroll.scrollHeight - previewScroll.clientHeight;
    if (maxEdit > 0 && maxPrev > 0) {
        editor.scrollTop = (previewScroll.scrollTop / maxPrev) * maxEdit;
    }
    requestAnimationFrame(() => { syncing = false; });
});

function renderPreview() {
    const text = editor.value;
    // [TOC] / [TOCM] 是目录占位符。代码块/行内代码里的不算（应该原样显示）。
    const { text: workText, types: tocTypes, count: tocCount } = replaceTocPlaceholders(text);
    let html = marked.parse(workText);
    preview.innerHTML = html;
    renderMermaidBlocks();    // 必须在 highlightCodeBlocks 前——后者会冲掉 language-* class
    highlightCodeBlocks();
    highlightUnmatchedDelimiters(text);   // 从源文本扫描错误写法，映射到 DOM 文本节点标黄
    wrapTables();
    if (tocCount > 0) renderInlineToc(tocTypes);
    renderMath();
    renderToc();
    updateFilename();
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

// ============ KaTeX 数学公式 ============
let katexReady = false;
let renderMathScheduled = false;
function ensureKatex() {
    if (katexReady) return Promise.resolve();
    if (!window.renderMathInElement) return Promise.reject('katex not loaded');
    if (katexReady) return Promise.resolve();
    katexReady = true;
    return Promise.resolve();
}
function renderMath() {
    if (!window.renderMathInElement || !preview) return;
    if (renderMathScheduled) return;
    renderMathScheduled = true;
    requestAnimationFrame(() => {
        renderMathScheduled = false;
        try {
            window.renderMathInElement(preview, {
                delimiters: [
                    { left: '$$', right: '$$', display: true },
                    { left: '$', right: '$', display: false },
                    { left: '\\(', right: '\\)', display: false },
                    { left: '\\[', right: '\\]', display: true },
                ],
                throwOnError: false,
                errorColor: '#cc0000',
                ignoredClasses: ['md-unmatched'],
            });
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
            container.innerHTML = '<pre style="color:#cc0000;background:#fff5f5;padding:10px;">KaTeX 渲染失败：' + e.message + '\n\n' + source + '</pre>';
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
            securityLevel: 'loose',
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
                    container.innerHTML = '<pre style="color:#cc0000;background:#fff5f5;padding:10px;">Mermaid 渲染失败：' + e.message + '</pre>';
                });
        });
    });
}
function renderMermaidBlocks() {
    if (!window.mermaid) return;
    // 支持 mermaid、seq、flow、sequence、diagram 作为代码块语言别名
    const codes = preview.querySelectorAll('pre code.language-mermaid, pre code.language-seq, pre code.language-flow, pre code.language-sequence, pre code.language-diagram');
    // 已知关键字：跳过这些的都是“无头”的代码块
    const KNOWN_KEYWORDS = /^\s*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|gantt|pie|erDiagram|journey|gitGraph|timeline|sankey-beta|quadrantChart|requirementDiagram|C4Context|mindmap|zenuml)/i;
    // 老式 flowchart 语法检测（id=>type: text）
    const OLD_FLOW_SYNTAX = /^\s*\w+\s*=>\s*(start|end|operation|inputoutput|condition|subroutine)\s*:/im;
    codes.forEach(code => {
        if (code.dataset.mermaidRendered) return;
        let source = code.textContent;
        // 用户友好的转义：\n → <br/>（Mermaid 多行 Note 语法）、\t → tab、\" → "
        source = source.replace(/\\n/g, '<br/>').replace(/\\t/g, '\t').replace(/\\"/g, '"');
        // 自动补 sequenceDiagram 关键字 + 老式 flowchart 语法转新语法
        if (OLD_FLOW_SYNTAX.test(source)) {
            source = convertOldFlowchart(source);
        } else if (!KNOWN_KEYWORDS.test(source)) {
            // 检测序列图特征：-> / -> / --> / -- / Note
            if (/^\s*\w+\s*(->|-->|->>|-->>|--)\s*\w+/m.test(source) || /^\s*Note\b/m.test(source)) {
                source = 'sequenceDiagram\n' + source.trim();
            }
        }
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
            container.innerHTML = '<pre style="color:#cc0000;background:#fff5f5;padding:10px;">Mermaid 渲染失败：' + e.message + '\n\n' + source + '</pre>';
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

    // 在源文本里找 **..** / *..*，只看那些“不紧贴”的
    const pattern = /(?<!\\)(\*\*?)([^\*\n]+?)\1(?!\\)/g;
    const errRanges = [];   // [{ start, end }]
    let m;
    while ((m = pattern.exec(sourceText))) {
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
            errRanges.push({ start: startPos, end: startPos + m[0].length, delimLen: delim.length });
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
                // 跳过已被 marked 正确渲染为粗/斜体的文本（不该报黄）
                if (tag === 'STRONG' || tag === 'EM') return NodeFilter.FILTER_REJECT;
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
        const d = range.delimLen || 2;
        const inner = snippet.slice(d, snippet.length - d);        // 去掉 delimiter
        if (!inner) continue;
        for (const tn of textNodes) {
            const text = tn.textContent;
            // 跳过已被标过的
            if (tn.parentNode && tn.parentNode.classList && tn.parentNode.classList.contains('md-unmatched')) continue;
            // 优先匹配完整 snippet（marked 原样输出未渲染的 **..**）
            const idx = text.indexOf(snippet);
            if (idx >= 0) {
                wrapWithUnmatched(tn, idx, snippet);
                break;
            }
            // 退而求其次：匹配 inner（去掉 delimiter 后的文字）
            const idx2 = text.indexOf(inner);
            if (idx2 >= 0) {
                wrapWithUnmatched(tn, idx2, inner);
                break;
            }
        }
    }
}

function wrapWithUnmatched(textNode, start, middle) {
    const text = textNode.textContent;
    const end = start + middle.length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const isBold = middle.includes('**');
    const span = document.createElement('span');
    span.className = 'md-unmatched';
    span.textContent = middle;
    span.title = isBold
        ? '** 紧贴内容才能形成粗体（CommonMark 规则）'
        : '* 紧贴内容才能形成斜体（CommonMark 规则）';
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(span);
    if (after) frag.appendChild(document.createTextNode(after));
    textNode.parentNode.replaceChild(frag, textNode);
}

function renderToc() {
    tocList.innerHTML = '';
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length === 0) {
        tocList.innerHTML = '<div style="padding: 12px; color: #6e7681; font-size: 12px;">(无标题)</div>';
        return;
    }
    let lastId = '';
    headings.forEach((h, i) => {
        if (!h.id) {
            h.id = 'h-' + i + '-' + slugify(h.textContent);
        }
        const level = parseInt(h.tagName.charAt(1));   // H4 → 4
        const div = document.createElement('div');
        div.className = `toc-item lvl${level}`;
        div.textContent = h.textContent;
        div.dataset.id = h.id;
        div.addEventListener('click', () => {
            const previewWrap = document.getElementById('preview-wrap');
            if (!previewWrap) return;
            // 点击 TOC 期间禁止同步，防止 smooth scroll 的中间帧跳回原位置
            syncing = true;
            const top = h.getBoundingClientRect().top - previewWrap.getBoundingClientRect().top + previewWrap.scrollTop - 12;
            previewWrap.scrollTo({ top, behavior: 'smooth' });
            // smooth scroll 完成后释放同步锁（设长一点保险）
            setTimeout(() => { syncing = false; }, 800);
        });
        tocList.appendChild(div);
        lastId = h.id;
    });
}

function slugify(s) {
    return s.toLowerCase().replace(/[^a-z0-9一-龥]+/g, '-').replace(/^-|-$/g, '');
}

function updateFilename() {
    const name = currentFile ? currentFile.replace(/^.*[\\\/]/, '') : '(未保存)';
    filenameEl.textContent = dirty ? name + ' ●' : name;
    // 窗口标题也带上文件名，方便多文档时区分
    document.title = (currentFile ? name + (dirty ? ' ●' : '') : '未命名') + ' - VMD';
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
    document.getElementById('app').classList.toggle('read-mode', !on);
    segBtns.forEach(b => b.classList.toggle('is-active', (b.dataset.mode === 'edit') === on));
    applyWidths();
}

segBtns.forEach(btn => {
    btn.addEventListener('click', () => setEditMode(btn.dataset.mode === 'edit'));
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
    item.addEventListener('click', (e) => {
        e.stopPropagation();
        applyTheme(item.dataset.theme);
        updateThemeButton();
        themeDropdown.classList.remove('open');
    });
});

// 点击其他地方关闭
document.addEventListener('click', () => {
    themeDropdown.classList.remove('open');
});

function updateThemeButton() {
    const t = THEMES[currentTheme];
    // auto 显示"跟随系统"，tooltip 里提示当前实际生效的是哪个
    const label = t.icon + ' ' + t.name;
    themeLabel.textContent = label;
    themeToggle.title = currentTheme === 'auto'
        ? '跟随系统（当前：' + THEMES[activeTheme].name + '）'
        : t.name;
    // 高亮当前选中项
    themeMenu.querySelectorAll('.dropdown-item').forEach(item => {
        item.classList.toggle('active', item.dataset.theme === currentTheme);
    });
}

document.getElementById('btn-new').addEventListener('click', () => {
    if (dirty && !confirm('放弃当前修改？')) return;
    editor.value = '';
    currentFile = null;
    dirty = false;
    renderPreview();
    updateFilename();
});
document.getElementById('btn-open').addEventListener('click', openFile);
document.getElementById('btn-save').addEventListener('click', saveFile);
document.getElementById('btn-save-as').addEventListener('click', saveAsFile);
document.getElementById('btn-export-pdf').addEventListener('click', exportPdf);

async function openFile() {
    try {
        console.log('[VMD] openFile() called');
        const path = await open({
            multiple: false,
            filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
        });
        console.log('[VMD] open() returned:', path);
        if (!path) return;
        const content = await invoke('read_file', { path });
        editor.value = content;
        currentFile = path;
        dirty = false;
        renderPreview();
        updateFilename();
        statusEl.textContent = '已打开';
        setTimeout(() => statusEl.textContent = '', 1500);
    } catch (e) {
        alert('打开失败：' + e);
    }
}

async function saveFile() {
    if (!currentFile) return saveAsFile();
    try {
        await invoke('write_file', { path: currentFile, content: editor.value });
        dirty = false;
        updateFilename();
        statusEl.textContent = '已保存';
        setTimeout(() => statusEl.textContent = '', 1500);
    } catch (e) {
        alert('保存失败：' + e);
    }
}

async function saveAsFile() {
    try {
        const path = await save({
            filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
            defaultPath: currentFile || 'untitled.md',
        });
        if (!path) return;
        await invoke('write_file', { path, content: editor.value });
        currentFile = path;
        dirty = false;
        updateFilename();
        statusEl.textContent = '已保存';
        setTimeout(() => statusEl.textContent = '', 1500);
    } catch (e) {
        alert('保存失败：' + e);
    }
}

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

        statusEl.textContent = '正在导出 PDF…';
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
        // 等浏览器完成布局刷新，确保打印的是新样式
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        try {
            await invoke('export_pdf', { path });
            statusEl.textContent = 'PDF 已导出';
        } catch (e) {
            console.error(e);
            alert('导出 PDF 失败：' + (e && e.message ? e.message : e));
            statusEl.textContent = '';
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
        setTimeout(() => statusEl.textContent = '', 2500);
    } catch (e) {
        alert('导出 PDF 失败：' + e);
    }
}

// ============ 快捷键 ============

document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'o') { e.preventDefault(); openFile(); }
    else if (ctrl && e.shiftKey && e.key === 's') { e.preventDefault(); saveAsFile(); }
    else if (ctrl && e.shiftKey && e.key === 'e') { e.preventDefault(); exportPdf(); }
    else if (ctrl && !e.shiftKey && e.key === 's') { e.preventDefault(); saveFile(); }
    else if (ctrl && e.key === 'n') { e.preventDefault(); document.getElementById('btn-new').click(); }
});

// ============ TOC 高亮 ============

preview.addEventListener('scroll', () => {
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    let current = null;
    headings.forEach(h => {
        if (h.getBoundingClientRect().top < 200) current = h;
    });
    if (!current) return;
    tocList.querySelectorAll('.toc-item').forEach(el => {
        const active = el.dataset.id === current.id;
        el.style.background = active ? 'var(--bg-elevated)' : 'transparent';
        el.style.color = active ? 'var(--link)' : '';
    });
});

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
    const total = content.clientWidth;
    const t = Math.max(MIN_TOC, Math.min(tocW, total - MIN_EDITOR - MIN_PREVIEW));
    tocEl.style.width = t + 'px';
    if (clearEditor) {
        editorEl.style.width = '';
        editorW = 0;
    }

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
    // 窗口缩放时保持 tocW 和 editorW，只让 preview 自适应
    if (editorW > 0) editorEl.style.width = editorW + 'px';
    tocEl.style.width = tocW + 'px';
    // 不调 applyWidths（它会清空 editor width）
});

// ============ 启动 ============

// 立即同步更新主题按钮（不等 async，避免显示旧值）
updateThemeButton();
(async function start() {
    // 初始跟随系统主题（async：要等 system_theme 命令返回）
    await applyTheme('auto');
    setEditMode(false);  // 初始进入阅读模式
    renderPreview();
    applyWidths(true);
})();

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
        const winW = window.innerWidth;
        const winH = window.innerHeight;
        let newX = x, newY = y;
        if (newX + w > winW) newX = winW - w - 4;   // 右边不够 → 靠右
        if (newY + h > winH) newY = y - h - 4;       // 下边不够 → 菜单画在鼠标上方（而不是贴窗底，避免鼠标在菜单内）
        if (newX < 4) newX = 4;
        if (newY < 4) newY = 4;
        ctxMenu.style.left = newX + 'px';
        ctxMenu.style.top = newY + 'px';
        ctxMenu.style.visibility = 'visible';
    }

    function escHTML(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function item(label, opts = {}) {
        const dis = opts.disabled ? ' ctx-item-disabled' : '';
        const danger = opts.danger ? ' ctx-item-danger' : '';
        const icon = opts.icon ? `<span class="ctx-item-icon">${opts.icon}</span>` : '';
        const shortcut = opts.shortcut ? `<span class="ctx-item-shortcut">${escHTML(opts.shortcut)}</span>` : '';
        return `<div class="ctx-item${dis}${danger}" data-act="${opts.act}">${icon}<span class="ctx-item-label">${escHTML(label)}</span>${shortcut}</div>`;
    }

    function sep() {
        return '<div class="ctx-separator"></div>';
    }

    function editorMenu() {
        const sel = editor.value.substring(editor.selectionStart, editor.selectionEnd);
        const hasSel = sel.length > 0;
        return [
            item('撤销',  { act: 'undo',  icon: '↶', shortcut: 'Ctrl+Z' }),
            item('重做',  { act: 'redo',  icon: '↷', shortcut: 'Ctrl+Y' }),
            sep(),
            item('剪切', { act: 'cut', icon: '✂', shortcut: 'Ctrl+X' }),
            item('复制', { act: 'copy', icon: '📋', shortcut: 'Ctrl+C' }),
            item('粘贴', { act: 'paste', icon: '📥', shortcut: 'Ctrl+V' }),
            sep(),
            item('全选', { act: 'selectAll', icon: '🔲', shortcut: 'Ctrl+A' }),
            sep(),
            item('加粗 **',    { act: 'fmt-bold',   icon: 'B', disabled: !hasSel }),
            item('斜体 *',     { act: 'fmt-italic', icon: 'I', disabled: !hasSel }),
            item('行内代码 `', { act: 'fmt-code',   icon: '<>', disabled: !hasSel }),
            sep(),
            item('链接 [文字](url)', { act: 'insert-link', icon: '🔗' }),
            item('代码块 ```',       { act: 'insert-codeblock', icon: '{ }' }),
            item('表格',             { act: 'insert-table', icon: '⊞' }),
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

    // ESC 关闭
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeMenu();
    });

    // 菜单项点击
    ctxMenu.addEventListener('click', async (e) => {
        const row = e.target.closest('.ctx-item');
        if (!row || row.classList.contains('ctx-item-disabled')) return;
        const act = row.dataset.act;
        const sel = editor.value.substring(editor.selectionStart, editor.selectionEnd);

        // ----- textarea 操作 -----
        if (menuTarget === 'editor') {
            if (act === 'undo')        document.execCommand('undo');
            else if (act === 'redo')   document.execCommand('redo');
            else if (act === 'cut')    document.execCommand('cut');
            else if (act === 'copy')   document.execCommand('copy');
            else if (act === 'paste')  { editor.focus(); document.execCommand('paste'); }
            else if (act === 'selectAll') editor.select();
            // 格式化选中
            else if (act === 'fmt-bold' && sel.length)      wrapSelection(`**${sel}**`);
            else if (act === 'fmt-italic' && sel.length)    wrapSelection(`*${sel}*`);
            else if (act === 'fmt-code' && sel.length)      wrapSelection('`' + sel + '`');
            // 插入模板
            else if (act === 'insert-link')       insertAtCursor('[文字](https://)');
            else if (act === 'insert-codeblock')  insertAtCursor('\n```\n代码\n```\n');
            else if (act === 'insert-table')      insertAtCursor('\n| 列1 | 列2 |\n|---|---|\n| 内容 | 内容 |\n');
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

    // textarea 工具函数
    function wrapSelection(text) {
        const s = editor.selectionStart, e = editor.selectionEnd;
        editor.value = editor.value.slice(0, s) + text + editor.value.slice(e);
        editor.selectionStart = s;
        editor.selectionEnd = s + text.length;
        editor.focus();
    }

    function insertAtCursor(text) {
        editor.focus();
        const s = editor.selectionStart, e = editor.selectionEnd;
        editor.value = editor.value.slice(0, s) + text + editor.value.slice(e);
        editor.selectionStart = editor.selectionEnd = s + text.length;
    }

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
