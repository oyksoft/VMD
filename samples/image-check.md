# 图片显示自检样例

打开这个文件后，下面的图片应该**都能看到**（浅灰边框的白色矩形，320×120）。

> 纯白图在白色背景上会「消失」，所以这张图加了浅灰边框 —— 看得见边框就说明图片加载成功了。

## 1. data URI 内联（base64）

图片直接编码在 markdown 里，不依赖任何外部文件：

![内联空白图 data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAB4CAIAAAAMrLyJAAABHUlEQVR42u3TAQkAMAzAsPmXMpO7i0Mh](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAAB4CAIAAAAMrLyJAAABHUlEQVR42u3TAQkAMAzAsPmXMpO7i0MhkVDoLJA1EkB+4ANSDAwGBgwMGBgMDBgYMDBgYDAwYGDAwGBgA4OBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDAY2MBgYMDAgIHBwICBAQMDBgYDAwYGDAwGNjAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQODgQ0MBgYMDBgYDAwYGDAwYGAwMGBgwMBgYAODgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgZ+DQwUGRjCHlPBjqjRdemQAAAAAElFTkSuQmCC)

## 2. 相对路径（同级目录）

![相对路径空白图](blank.png)

## 3. 相对路径（子目录写法）

![子目录写法](./blank.png)

## 4. 带 title

![带标题的空白图](blank.png "这是 title，鼠标悬停应该显示")

## 5. 引用式图片

![引用式空白图][ref-blank]

[ref-blank]: blank.png

## 6. 图片在列表里

- 第一项，前面带图片：

  ![列表里的空白图](blank.png)

- 第二项，纯文字。

## 7. 图片在引用块里

> ![引用块里的空白图](blank.png)

## 8. 消毒检查（这张图**会显示**，但脚本不会执行）

下面这行是原始 HTML 图片，带 `onerror`。DOMPurify 应该**去掉 `onerror`、保留 `src`** ——
所以图片**照常显示**，但 `onerror` 里的脚本不会跑：

<img src="blank.png" onerror="window.__vmd_pwned = true" alt="这个应该显示出来">

验证方法：在 WebView 里执行 `window.__vmd_pwned`，应该是 `undefined`。
如果它是 `true`，说明消毒被绕过了 —— 那就是安全问题。

## 9. 导出 HTML 的额外说明

- 第 1 条（data URI）和第 8 条（原始 HTML）原样保留。
- 第 2~7 条是本地相对路径，**导出 HTML 时 Rust 侧会按「markdown 文件所在目录」解析并转成 base64 内嵌**，
  所以导出的单文件 HTML 换台电脑打开也能显示。
- 但第 5 条（引用式定义）和第 7 条（引用块）也依赖同一个相对路径 —— 导出时同样会被内嵌。
