# dsh-annotate

在 DeepSeek Harness（DSH）右侧栏的**网页**或**文件预览**上圈出一块，写一句批注，直接把「裁剪图 + 带定位的提示词」放进输入框。

> 说「这一块」「这里不对」很难讲清楚。截图加标注是最省事的表达，这个插件把这件事压缩成：点一下 → 拖一个框 → 写一句话 → 插入。

---

## 它解决什么问题

DSH 的右侧栏可以直接打开网页，也能预览 PDF、Markdown、txt、代码、图片。但要跟模型描述「我说的是这一段」时，只能靠文字复述——尤其是长 PDF，你截了第 12 页，模型并不知道那是哪一章哪一句。

这个插件做两件事：

1. **让你框**：在右侧栏画面上拖出任意多个框，每个框写一句批注。
2. **让模型对上号**：插入时除了裁剪图，还会自动带上定位信息——PDF 的页码 + 框内文字，纯文本的行号区间 + 框内文字，Markdown 的最近小标题，网页的方位 / 最近标题 / 前 120 字。

插入结果示例（每按一次回车追加一行，没有前后缀）：

```
1. docs/guide.pdf · 第 12/40 页 · “缓存失效以后，页面还在用旧样式” · 这里应该改成按版本号失效
2. docs/guide.pdf · 第 13/40 页 · “默认 TTL 是 5 分钟” · 这个值和配置文档不一致
```

## 功能

- **网页**：把右侧栏浏览器冻结成一张真实位图（Electron `<webview>` 的 `capturePage()`），所见即所得——滚动位置、缩放、暗色模式都和你看到的一样，然后在图上框选、裁剪。
- **文件**：不冻结画面，你还能继续滚动；框跟着内容走，插入时 PDF 从页面 canvas 按设备分辨率裁剪，图片按自然分辨率裁剪。
- **一次一条**：回车只把当前选中的框送进输入框，标注不退出，接着框下一处。
- **气泡可回收**：插入过的框会变成一个蓝色玻璃小气泡，里面是它的编号；点气泡能重新打开那条批注改字，改完回车即同步到草稿；点气泡卡片的 `✕` 就把这条连提示词里那一行**和它的裁图**一起删掉。气泡一直留到这批提示词真正发出去为止（草稿里那行没了，气泡就消失）。
- **编号看存活**：编号按"现在还剩几处"排，删掉中间任何一条，后面的自动补位；已插入条目的行号变化会同步改写草稿里对应的那一行。退出标注后重新开始，又从 1 数起。
- **不挡手**：刚点「标注」时画面上什么卡片都没有，批注卡片要等你画出第一个框才出现，而且紧贴着你刚画的框（优先在它右边，放不下就换到左边、下面或上面），始终留在窗口内；拖新框时卡片会先让开。
- **追加而不是覆盖**：插入走 `requestDraftInitialization({ whenDraftExists: 'append' })`，你已经写在输入框里的字不会被吃掉。
- **一行一条**：按住回车重复触发只算一次；批注里换行（`Shift+Enter`）在插入时会折成空格，保证每条就是一行——气泡正是靠"整行"找回自己的。
- **侧栏换了就收尾**：标注途中侧栏切走或关掉，标注会自动结束并恢复页面显示，未插入的框丢弃，已插入的气泡保留。
- **跟随主题**：颜色、圆角、字号都用 DSH 的 `--dsw-*` / `--dsh-*` 变量，深浅色自动适配。
- **中英双语**：跟随 DSH 界面语言；宿主没给 `t` 时按 `navigator.language` 兜底。

## 安装

### 前置条件

- DSH 桌面版（Electron）。标注网页需要 `<webview>` 元素和 `capturePage()`，浏览器里的 web 版右侧栏是沙箱 iframe，拿不到像素——那种环境下按钮会根据实际能力隐藏。
- 标注**文件预览**（PDF / Markdown / txt / 代码 / 图片）在两种宿主上都能用。
- 不需要额外依赖，也不需要本机装 Chrome。

### 用 `plugin_manager` 从本地目录安装

DSH 的插件以「bundle」为单位安装。这个包的 id 是 `@wuwen1994/dsh-annotate`；目前还没有发到 npm，所以安装源用仓库的**目录**（下面第 2 步），target 要指向目录而不是包名。

1. 把仓库克隆到本地任意位置（建议放在不会被清理的目录）：

   ```bash
   git clone https://github.com/wuwen1994/dsh-annotate.git ~/dsh-plugins/dsh-annotate
   ```

2. 在 DSH 会话里让助手安装这个目录（或者在插件管理器里选择「从本地目录安装」）：

   > 用 plugin_manager install_bundle 安装 `~/dsh-plugins/dsh-annotate` 的绝对路径

   助手会调用 `plugin_manager({ action: "install_bundle", target: "<绝对路径>" })`。target 必须是**包的根目录**（里面直接有 `package.json`）。

3. 看安装结果，不要看日志：

   ```json
   { "stage": "enable", "enabled": true, "application": "applied", "version": "0.12.3", "warnings": [] }
   ```

   `application: "applied"` 且 `warnings` 为空，才算装上了。若是 `"failed"`，把返回里的错误行贴出来再排查。

4. 刷新界面（`Ctrl+R` / `Cmd+R`）。右侧栏打开一个网页或文件，顶部工具栏的刷新按钮右边应该多一个标注图标。

### 更新

```bash
cd ~/dsh-plugins/dsh-annotate && git pull
```

改动了 `client.js` 这类纯前端文件，刷新界面即可生效；改动了 `index.js`（Host 半）或 `package.json` 版本号，需要重新装一次：

> 用 plugin_manager 先 remove_bundle 再 install_bundle 这个目录

### 卸载

> 用 plugin_manager remove_bundle 卸载 `@wuwen1994/dsh-annotate`

### 不要这样做

- 不要手动改 `~/.dsh/profiles/<profile>/package.json` 或 `cordis.patch.yml` 来「装」插件——DSH 会在下一次插件操作时把它们改回来，而且坏掉的 profile 很难修。
- 不要在 profile 目录里跑 `pnpm install`。

## 使用

1. 在右侧栏打开网页，或预览一个 PDF / Markdown / txt / 代码 / 图片文件。
2. 面板顶部的工具栏里、刷新按钮右边会出现一个标注图标，点它。
   - 网页：画面定格成截图，边框会标成主色。
   - 文件：画面不变，可以继续滚动。
3. 在画面上拖出要标注的区域。框出来之后，批注卡片才贴着这个框出现（右侧优先），不会跑到屏幕角落，也不会挡住你正要框的地方。
4. 写批注。定位信息只在后台记着、写进提示词，卡片上不显示。
5. 按 `Enter`：这块区域连同批注变成输入框里的一行，画面上的框缩成一个蓝色气泡，标注**不退出**——接着框下一处、写下一句、再按回车。`Shift+Enter` 在批注里换行。
6. 想改某一条：点它的气泡，卡片会重新打开，改完回车即同步；不想要了就点卡片右上角 `✕`——这条气泡连同输入框里那一行一起删除，其余自动重新编号。
7. 全部写完后按 `Esc` 或右键退出标注，检查输入框里的若干行和附图，照常发送。发送后气泡自动消失。

快捷键与操作：`Esc` 或**右键**退出标注；点空白处取消选中；框上的编号可以直接点；选中某个框后按 `Delete` 删掉这一个框（没插入的框直接消失，已插入的用气泡卡片的 `✕` 删，两种都会让后面的编号补位）。

## 定位是怎么算出来的

| 预览类型 | 锚点来源 | 提示词里写成 |
| --- | --- | --- |
| PDF（含 Word / PowerPoint，DSH 内部转成 PDF 再渲染） | `[data-pdf-page]` 的页码 + 该页文字层（`[data-pdf-text]`）与框相交的文字 | `docs/a.pdf · 第 12/40 页 · “框内文字”` |
| 纯文本 / 代码 | `[data-textpreview-line="N"]` 的行号区间 + 相交行文字 | `notes/a.txt · 第 140–152 行 · “框内文字”` |
| Markdown | 最近的标题 + 相交叶子元素的文字 | `notes/a.md · “小节标题” · “框内文字”` |
| 图片 | 无文字锚点 | `assets/a.png · ` 只有批注 |
| 网页 | `executeJavaScript` 尽力取最近的 `h1`–`h6`、`innerText` 前 120 字 | `左上 · “…”` |

定位是**线索**，不是保证：PDF 的文字层可能缺字，Markdown 没有行号。文件路径和页码/行号会写进每一行，方便模型自己回去核对。

## 兼容与限制

- **只标注可见区域**。网页是位图，滚出视口的部分没有像素；文件模式可以滚动后再框。
- **不转发鼠标悬停 / 双击 / 把文件拖进页面**。框选状态下这些操作属于标注层。
- **Excel 预览不裁图**（FortuneSheet 栅格），只给批注文字。
- **网页模式依赖 Electron**，web 宿主的沙箱 iframe 无法读取像素。
- 粘贴/输入法这类页面内输入不支持，标注层不接管键盘焦点。

## 工作原理

- 一个 bundle，包含 **Client 半**（`client.js`）和一个空的 **Host 半**（`index.js`）。Host 半只是为了 bundle 能被启用——所有逻辑都在渲染进程。
- UI 挂在 Client 的 `shell.overlay` 槽（全窗口、默认点击穿透的浮层）。触发图标本身是往面板自带的工具栏里插一个占位 `<span>` 再 `createPortal` 进去的——右侧栏没有提供扩展工具按钮的槽位，这是唯一能挨着刷新按钮的办法。
- 网页：`document.querySelectorAll('webview[data-sidebar-browser-frame]')` 找到可见的右侧栏浏览器，`capturePage()` 取 `NativeImage` → `toDataURL()` 作背景；插入时 canvas 按 `naturalWidth / rect.width` 的缩放比裁剪。
- 文件：不截图，直接覆盖透明层画框；PDF 从 `[data-pdf-page]` 里的 `<canvas>` 裁剪（canvas 宽度就是设备像素宽度）。
- 写输入框走官方服务链，不碰 DOM：

  ```
  sessions.binding(sessionId).ctx  →  conversation.createDrafts(files)
                                   →  input.requestDraftInitialization({ whenDraftExists: 'append' })
                                   →  input.addAttachments(draftIds)
                                   →  input.focus()
  ```

## 开发

```
client.js          Client 半：探测目标、截图/画框/裁剪、提示词与写入
index.js           Host 半：空实现（仅用于 bundle 启用）
cordis.patch.yml   把 bundle 插进 profile
package.json       包元数据 + dsh.client 注入声明
locale/*.json      插件管理页里的标题/描述
docs/DETAIL.md     面向用户的详细说明（插件详情页直接引用）
test/smoke.mjs     无浏览器冒烟测试
icon.svg           插件图标
```

跑测试（不需要 DSH、不需要浏览器，纯 Node）：

```bash
node test/smoke.mjs
```

它用一个微型假 DOM 跑四个场景：网页（冻结位图 + 裁图）、纯文本（行号定位、不发图）、PDF 页码 + 引文并按 canvas 2× 裁剪、图片按自然分辨率裁剪；另外覆盖「没画框时不渲染批注卡片」「右边放不下时卡片翻到左边」「点框时卡片跟着跳」「卡片只留关闭按钮、框上不留按钮、回车插入一条并继续标注、编号递增」「插入后出现气泡、气泡能重新打开并改写草稿」「发送后气泡消失、剩余框补位」「气泡卡片的 ✕ 删掉气泡并清掉那一行」「图标落在刷新按钮后」「元素路径不进提示词」「只注册 overlay 槽」「按住回车只插一次」「多行批注压成一行」「面板消失时自动收尾」「源码里没有上一代的残留」。输出 `ok — 32 checks` 即通过。

改动后自检顺序：`node --check client.js` → `node test/smoke.mjs` → 用 `plugin_manager` 重装（或 `set_bundle` 关再开）→ 刷新界面肉眼确认。

### 发版

市场按**固定提交**收录本插件（见 [issue #492](https://github.com/polang233/dsh-plugin-index/issues/492)），所以每次发版都要把新 SHA 回帖过去，否则条目还指着旧提交。一条命令做完：

```bash
GH_TOKEN=$(gh auth token) node scripts/release.mjs patch -m "fix: …"
```

它按顺序做：算新版本 → 跑 `node --check` 和冒烟测试（不过就中止）→ 改 `package.json`、README/DETAIL 里的旧版本号、README 的 `ok — N checks` → 通过 GitHub API 推整个目录（blob → tree → commit → 移动 `main`）→ 在 #492 回帖（版本 + 完整 SHA + `github:wuwen1994/dsh-annotate#<sha>` 安装目标）→ 打印结果并提醒重装本地 bundle。

常用变体：

```bash
node scripts/release.mjs patch --dry-run      # 只演算，不写任何东西
node scripts/release.mjs minor                # 0.12.x → 0.13.0
node scripts/release.mjs --announce <sha>     # 只回帖（补发漏掉的通知）
```

`--no-push` / `--no-comment` 可分别跳过推送与回帖；`--force` 允许覆盖远端有而本地没有的文件（默认会中止并列出来）。

这台机器 `github.com:443` 不通、只有 `api.github.com` 通，所以脚本一律走 REST，不依赖 `git push`。

## English

Box a region on a page opened in the DeepSeek Harness (DSH) sidebar, or on a
PDF / Markdown / txt / code / image preview, write one short note per region,
and insert the crops plus a prompt into the composer. Each line of the prompt
carries a locator taken from the preview itself — page number and quoted text
for PDFs, a line range for plain text, the nearest heading for Markdown — so
the model can find the spot in a long document instead of guessing.

**Install** (DSH keeps plugins as *bundles* installed from a directory, not
from a package name):

```bash
git clone https://github.com/wuwen1994/dsh-annotate.git ~/dsh-plugins/dsh-annotate
```

Then ask the DSH agent to install that folder, i.e. call
`plugin_manager({ action: "install_bundle", target: "<absolute path to the folder>" })`.
Success looks like `{"stage":"enable","application":"applied","warnings":[]}`.
Refresh the window afterwards. To update: `git pull`, then
`remove_bundle` + `install_bundle` when `index.js` or the version changed.
To remove: `plugin_manager({ action: "remove_bundle", target: "@wuwen1994/dsh-annotate" })`.

**Requirements**: annotating a *web page* needs the DSH desktop (Electron)
build, because it reads pixels through the sidebar `<webview>` and its
`capturePage()`. Annotating a *file preview* works in both builds. No extra
dependencies, no local Chrome.

**Limits**: only the visible area can be marked (the page becomes a bitmap);
hover / double-click / file-drop into the page are not forwarded; Excel previews
get notes but no crops.

**Tests**: `node test/smoke.mjs` — runs the client through a tiny fake DOM, no
DSH and no browser needed.

## License

MIT，见 [LICENSE](LICENSE)。
