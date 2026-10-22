// VMD - 主题调色板
//
// 这个文件在 <head> 里加载（必须排在 style.css 之后），有两个作用：
//   1. 四套主题的配色只存在这一份，app.js 直接用 window.VMD_THEMES
//   2. 在首帧绘制之前就把启动主题的配色写进 <html> 的内联样式 ——
//      否则页面会先拿 style.css 里写死的暗色变量画一帧，
//      浅色系统上就会看到"先黑后白"的一下闪。
//
// 启动主题优先用 Rust 注入的 window.__VMD_INIT_THEME__
//（Rust 直接读注册表，没有异步等待，不会和实际生效的主题对不上）；
// 在浏览器里调试时退回 prefers-color-scheme。

window.VMD_THEMES = {
    auto: {
        name: '跟随系统',
        short: '自动',        // 设置面板的色块上显示（窄格子放不下 4 个字）
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
            '--danger': '#f85149',
            '--quote-bar': '#3b434b',
            '--quote-text': '#8b949e',
        },
    },
    gray: {
        name: '灰色',
        icon: '🌫️',
        css: 'vendor/highlight-gray.css',
        // 中性灰（不带蓝调），跟"暗色"的蓝调黑拉开距离
        vars: {
            '--bg': '#26282b',
            '--bg-panel': '#303338',
            '--bg-elevated': '#3c4046',
            '--bg-code': '#303338',
            '--border': '#4a4e55',
            '--border-soft': 'rgba(255,255,255,0.10)',
            '--text': '#d6d8db',
            '--text-strong': '#f4f5f6',
            '--text-dim': '#9b9ea3',
            '--link': '#8fb8de',
            '--accent': '#8fb8de',
            '--danger': '#f85149',
            '--quote-bar': '#5a5e64',
            '--quote-text': '#a8abb0',
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
            '--danger': '#cf222e',
            '--quote-bar': '#d0d7de',
            '--quote-text': '#57606a',
        },
    },
    // ---- 几套柔和的有色主题（低饱和，长时间看不刺眼）----
    // 四个浅色主题的底色刻意拉开色调（暖/绿/蓝/紫），不然在小色块上分不出来
    sepia: {
        name: '暖阳',
        icon: '🌾',
        css: 'vendor/highlight-light.css',
        vars: {
            '--bg': '#f7f0e2',
            '--bg-panel': '#f0e6d3',
            '--bg-elevated': '#e8dcc4',
            '--bg-code': '#efe5d2',
            '--border': '#ded0b4',
            '--border-soft': 'rgba(120,90,55,0.13)',
            '--text': '#4a4034',
            '--text-strong': '#2e271d',
            '--text-dim': '#8a7c68',
            '--link': '#9c6430',
            '--accent': '#9c6430',
            '--danger': '#b4472f',
            '--quote-bar': '#dccaa8',
            '--quote-text': '#796b57',
        },
    },
    bamboo: {
        name: '青竹',
        icon: '🎋',
        css: 'vendor/highlight-light.css',
        vars: {
            '--bg': '#ecf4ea',
            '--bg-panel': '#e2eee0',
            '--bg-elevated': '#d6e7d4',
            '--bg-code': '#e4efe2',
            '--border': '#c4dbbf',
            '--border-soft': 'rgba(60,110,60,0.13)',
            '--text': '#37452f',
            '--text-strong': '#22301c',
            '--text-dim': '#74856c',
            '--link': '#3f7a3f',
            '--accent': '#3f7a3f',
            '--danger': '#b0403a',
            '--quote-bar': '#bcd4b7',
            '--quote-text': '#64745d',
        },
    },
    mist: {
        name: '雾蓝',
        icon: '🌊',
        css: 'vendor/highlight-light.css',
        vars: {
            '--bg': '#e9f0f8',
            '--bg-panel': '#dfe9f4',
            '--bg-elevated': '#d3e0ef',
            '--bg-code': '#e0eaf5',
            '--border': '#c2d3e6',
            '--border-soft': 'rgba(60,90,130,0.13)',
            '--text': '#35404e',
            '--text-strong': '#1f2833',
            '--text-dim': '#6f7b8a',
            '--link': '#33659c',
            '--accent': '#33659c',
            '--danger': '#b0403a',
            '--quote-bar': '#b8cae0',
            '--quote-text': '#64707f',
        },
    },
    dusk: {
        name: '暮紫',
        icon: '💜',
        css: 'vendor/highlight-light.css',
        vars: {
            '--bg': '#f1eaf8',
            '--bg-panel': '#e9e1f4',
            '--bg-elevated': '#dfd5ef',
            '--bg-code': '#ebe3f5',
            '--border': '#d7cbe9',
            '--border-soft': 'rgba(90,70,130,0.13)',
            '--text': '#413952',
            '--text-strong': '#2a2337',
            '--text-dim': '#7c7492',
            '--link': '#6d54ab',
            '--accent': '#6d54ab',
            '--danger': '#a33a5c',
            '--quote-bar': '#d0c5e4',
            '--quote-text': '#6f6882',
        },
    },
};

// ---- 启动：立刻应用主题 + 模式（必须赶在首帧绘制之前）----
(function applyStartupTheme() {
    // 启动模式（阅读/编辑）也在这里定：这是 head 里的同步脚本，
    // document.documentElement 一定存在 → 首帧就是对的，不会闪一下再切。
    // （不能在 Rust 的注入脚本里设 class —— 那是"文档刚创建"时执行的，DOM 还是空的）
    const settings = window.__VMD_SETTINGS__ || null;
    const editMode = !!(settings && settings.mode === 'edit');
    document.documentElement.classList.toggle('read-mode', !editMode);

    // 优先级：用户保存的设置（Rust 启动时读设置文件后注入）→ 系统主题（Rust 读注册表）
    const savedTheme = settings && settings.theme ? settings.theme : '';
    const t = (savedTheme && savedTheme !== 'auto')
        ? savedTheme
        : (window.__VMD_INIT_THEME__
            || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    const theme = window.VMD_THEMES[t];
    if (!theme || !theme.vars) return;
    const root = document.documentElement;
    for (const [k, v] of Object.entries(theme.vars)) {
        root.style.setProperty(k, v);
    }
    // 让浏览器画布 / 滚动条跟着主题走（否则浅色主题下画布默认是黑的）
    root.style.colorScheme = (t === 'light') ? 'light' : 'dark';
    // highlight.js 配色表：追加在 style.css 之后，级联顺序和原来一致
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = theme.css;
    link.dataset.hljs = '1';
    document.head.appendChild(link);
})();
