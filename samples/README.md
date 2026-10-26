# 测试样例

手动验证用的固定样例，改动相关功能后拿它们回归一遍（VMD 没有自动化 UI 测试）。

| 文件 | 用来验什么 |
|---|---|
| `sanitize-check.md` | 预览 HTML 消毒。整篇分成「恶意样例」和「必须照常工作」两部分，逐条对照文件里的预期。**任何一处 `alert` 弹窗 = 消毒失效。** |
| `encoding-gbk.txt` | GBK 编码的中文 `.txt`（无 BOM）。打开应正常显示；改一个字保存后**必须仍是 GBK**，不能被悄悄转成 UTF-8。 |
| `encoding-utf8-bom.md` | 带 UTF-8 BOM。打开后正文第一行不能出现乱码/不可见字符，保存后 BOM 应保留。 |
| `encoding-utf16le.md` | UTF-16LE 带 BOM。能正确打开，保存后仍是 UTF-16LE。 |
| `mermaid-check.md` | Mermaid `securityLevel: strict` 回归：click 不生效、`<br>` 变字面量、渲染失败的提示块不执行源码里的 HTML。 |
| `image-check.md` | 图片显示回归：data URI 内联 / 相对路径 / 引用式 / 列表里 / 引用块里，共 8 张图都要显示出来（浅灰边框的白色矩形 320×120）；带 `onerror` 的那张图**照常显示但脚本不执行**。 |
| `blank.png` | `image-check.md` 用的空白图片（纯白 + 浅灰边框，纯白图在白底页面上看不见）。 |

编码相关的判断办法：

```bash
# 看前几个字节（GBK 没有 BOM；UTF-8 BOM = efbbbf；UTF-16LE = fffe）
xxd samples/encoding-gbk.txt | head -1
```

或者在编辑器里改完保存后，直接对比文件大小有没有显著变化（GBK → UTF-8 会让中文变长）。
