# dsh-annotate

在 DeepSeek Harness（DSH）右侧栏的**网页**或**文件预览**上圈出一块，写一句批注，直接把「裁剪图 + 带定位的提示词」放进输入框。

> 说「这一块」「这里不对」很难讲清楚。截图加标注是最省事的表达，这个插件把这件事压缩成：点一下 → 拖一个框 → 写一句话 → 插入。

---

## 它解决什么问题

DSH 的右侧栏可以直接打开网页，也能预览 PDF、Markdown、txt、代码、图片。但要跟模型描述「我说的是这一段」时，只能靠文字复述——尤其是长 PDF，你截了第 12 页，模型并不知道那是哪一章哪一句。

这个插件做两件事：

1. **让你框**：在右侧栏画面上拖出任意多个框，每个框写一句批注。
2. **让模型对上号**：插入时除了裁剪图，还会自动带上定位信息——PDF 的页码 + 框内文字，纯文本的行号区间 + 框内文字，Markdown 的最近小标题，Excel 的单元格范围，网页的方位 / 最近标题 / 前 120 字。

插入结果示例（每按一次回车追加一行，没有前后缀）：

```
1. docs/guide.pdf · 第 12/40 页 · “缓存失效以后，页面还在用旧样式” · 这里应该改成按版本号失效
2. docs/guide.pdf · 第 13/40 页 · “默认 TTL 是 5 分钟” · 这个值和配置文档不一致
```

## 功能

- **网页**：把右侧栏浏览器冻结成一张真实位图（Electron `<webview>` 的 `capturePage()`），所见即所得——滚动位置、缩放、暗色模式都和你看到的一样，然后在图上框选、裁剪。
- **文件**：不冻结画面，你还能继续滚动；框跟着内容走，插入时 PDF 从页面 canvas 按设备分辨率裁剪，图片按自然分辨率裁剪，Excel 从表格 canvas 裁并把行列写成 `Sheet1!B2:D14`（优先用单元格的 aria 行列属性；HTML 表格退到 `rowIndex` / `cellIndex`，第一行折成 1，单格写 `Sheet1!B2`）。
- **选中即批注**：不想框的时候，直接在 PDF / Markdown / txt / 代码 / 网页里划出一句话，右键菜单里除了「复制」还多一条「批注」；点它弹出批注卡片，写完按回车，这句话连同页码/行号就进了输入框——不截图，一行一条。网页里的划词由注入的小脚本接管，页面跳转后自动重新注入。
- **元素拾取**：按住 `Shift` 点工具栏图标，鼠标划过段落、列表项、表格单元、标题会高亮，单击即选框，省得手画。
- **一次一条，也能一次全插**：回车只把当前选中的框送进输入框，标注不退出；框多于一个时，标尺栏上出现「全部插入 · N」，一次把剩下的都插进去，编号连续。
- **气泡可回收**：插入过的框会变成一个蓝色玻璃小气泡，里面是它的编号；点气泡能重新打开那条批注改字，改完回车即同步到草稿；点气泡卡片的 `✕` 就把这条连提示词里那一行**和它的裁图**一起删掉。气泡只代表草稿里还在的那一行：发送、清空草稿或换会话后就整批消失，不留灰色历史记录。
- **编号按批次重来**：同一批里每条取已经画出的最大值 +1，删掉中间一条不会让后面的重排；这一批发出去之后下一批重新从 1 开始。
- **对账不靠整行**：气泡与草稿行按「行号 + 引文片段 / 路径 / 批注片段」对账，改个标点或补个词都不会让气泡消失；草稿空了就判定为已发送，草稿里被手删掉的行直接丢弃（缩略图一并回收）。
- **气泡跟着页面走**：同一个面板里换标签或换文件，旧页的气泡不会叠到新页面上。
- **不挡手**：刚点「标注」时画面上什么卡片都没有（第一次进入有一句 3 秒提示）；批注卡片要等你画出第一个框才出现，而且紧贴着你刚画的框（优先在它右边，放不下就换到左边、下面或上面），始终留在窗口内；拖新框时卡片会先让开。
- **追加而不是覆盖**：插入走 `requestDraftInitialization({ whenDraftExists: 'append' })`，你已经写在输入框里的字不会被吃掉；同一文件一轮里到 3 条以上时自动加一行分组标题 `[批注 · 文件路径]`。
- **一行一条**：按住回车重复触发只算一次；批注里换行（`Shift+Enter`）在插入时会折成空格，保证每条就是一行。
- **裁图省流量**：统一 JPEG，长边超过 1568px 先等比缩到 1568、q0.9 编码；框四周外扩 8px，避免正好切在字腰上。鼠标停在气泡上可看那张裁图的缩略图。
- **缺图可补**：PDF 页的 canvas 还没挂上时插入会先等最多 2 秒；仍然没有就只写文字定位，并在卡片上给「裁图缺失 · 重试」。重试用的是点下去那一刻的框。
- **侧栏换了就收尾**：标注途中侧栏切走或关掉，标注会自动结束并恢复页面显示，未插入的框丢弃，已插入的气泡保留到这批结束。
- **快捷键**：`Alt+A` 进 / 出标注；`Esc` 或右键退出；`Delete` 删当前选中的框。
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
   { "stage": "enable", "enabled": true, "application": "applied", "version": "0.15.0", "warnings": [] }
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
6. 想改某一条：点它的气泡，卡片会重新打开，改完回车即同步；不想要了就点卡片右上角 `✕`——这条气泡连同输入框里那一行和它的裁图一起删除。编号不会补位：删中间一条，后面的保持原号。
7. 全部写完后按 `Esc` 或右键退出标注，检查输入框里的若干行和附图，照常发送。发送后气泡整批消失，不留灰色记录；想再标注就重新拉框，编号从 1 开始。

快捷键与操作：`Alt+A` 进 / 出标注；`Esc` 或**右键**退出标注；点空白处取消选中；选中某个框后按 `Delete` 删掉这一个框；网页上按住 `Shift` 点工具栏图标进入元素拾取，`Esc` 退出。

### 只批注一句话（不拖框）

标注模式适合「这块不对」，一句话的疑问更适合直接划词：

1. 在 PDF / Markdown / txt / 代码预览里用鼠标划出要说的那句话。
2. 在选区上右键，菜单里是「复制」和「批注」——「复制」和原来的系统行为一样。
3. 点「批注」，选区旁边弹出批注卡片（顶部是这句话的预览）；写一句想说的，按 `Enter`，`Shift+Enter` 换行，`Esc` 不要了。
4. 回车后这段话就进了输入框，光标也跟过去，接着写或直接发送。

进输入框的样子（没有编号，也没有截图）：

```
docs/guide.pdf · 第 12/40 页 · 「浏览器会缓存旧样式」 · 这里和正文的矛盾要说清楚
notes/a.md · 第 140 行 · 「缓存失效以后，页面还在用旧样式。」 · 这句解释得太含糊
```

选区批注不带编号，也不生成气泡——它不占画面，删掉就是删掉输入框里那一行。

## 定位是怎么算出来的

| 预览类型 | 锚点来源 | 提示词里写成 |
| --- | --- | --- |
| PDF（含 Word / PowerPoint，DSH 内部转成 PDF 再渲染） | `[data-pdf-page]` 的页码 + 该页文字层（`[data-pdf-text]`）与框相交的文字 | `docs/a.pdf · 第 12/40 页 · “框内文字”` |
| 纯文本 / 代码 | `[data-textpreview-line="N"]` 的行号区间 + 相交行文字 | `notes/a.txt · 第 140–152 行 · “框内文字”` |
| Markdown | 最近的标题 + 相交叶子元素的文字 | `notes/a.md · “小节标题” · “框内文字”` |
| Excel / 表格 | 单元格的 `aria-rowindex` / `data-row` 等属性推出的行列范围 | `budget.xlsx · Sheet1!B2:D14 · “框内文字”` |
| 图片 | 无文字锚点 | `assets/a.png · ` 只有批注 |
| 网页 | `executeJavaScript` 尽力取最近的 `h1`–`h6`、`innerText` 前 120 字 | `左上 · “…”` |

定位是**线索**，不是保证：PDF 的文字层可能缺字，Markdown 没有行号。文件路径和页码/行号会写进每一行，方便模型自己回去核对。

选区批注用同一套读取逻辑取页码和行号，但引号里只放你划中的那句话，而不是整行/整框的文字。

## 兼容与限制

- **只标注可见区域**。网页是位图，滚出视口的部分没有像素；文件模式可以滚动后再框。
- **不转发鼠标悬停 / 双击 / 把文件拖进页面**。框选状态下这些操作属于标注层。
- **Excel 预览的裁图与单元格锚点依赖 DOM 暴露的行列信息**；暴露不全时退化为文件名 + 框内文字，但仍尽量从表格 canvas 裁图。
- **网页模式依赖 Electron**，web 宿主的沙箱 iframe 无法读取像素。
- **预览里的右键菜单被接管**：选中文字时给出「复制 / 批注」，没选中时（以及右键输入框时）仍是系统自带菜单。文档预览走 DSH 的 `contextMenus` 服务；网页里由注入脚本在页面内拦截并把选区回报宿主。系统菜单本身在 Electron 主进程里，插件加不进去，所以这里是自己画一份。
- **不保存历史**：没有账本、不写 localStorage、不落项目文件；这一批的气泡在发送、清空草稿或换会话时就没了，下一批重新从 1 编号。
- 粘贴/输入法这类页面内输入不支持，标注层不接管键盘焦点。

## 工作原理

- 一个 bundle，包含 **Client 半**（`client.js`）和一个空的 **Host 半**（`index.js`）。Host 半只是为了 bundle 能被启用——所有逻辑都在渲染进程。
- UI 挂在 Client 的 `shell.overlay` 槽（全窗口、默认点击穿透的浮层）。触发图标本身是往面板自带的工具栏里插一个占位 `<span>` 再 `createPortal` 进去的——右侧栏没有提供扩展工具按钮的槽位，这是唯一能挨着刷新按钮的办法。
- 网页：`document.querySelectorAll('webview[data-sidebar-browser-frame]')` 找到可见的右侧栏浏览器，`capturePage()` 取 `NativeImage` → `toDataURL()` 作背景；插入时 canvas 按 `naturalWidth / rect.width` 的缩放比裁剪。
- 文件：不截图，直接覆盖透明层画框；PDF 从 `[data-pdf-page]` 里的 `<canvas>` 裁剪（canvas 宽度就是设备像素宽度）。
- 选区批注：在 document 的**捕获阶段**监听 `contextmenu`，确认选区落在预览正文里就 `preventDefault()`（这也是压掉 Electron 原生右键菜单的唯一办法），再把自己注册的 `contextMenus` 贡献打开；菜单项只有「复制 / 批注」两条，「批注」把选区交给同一张批注卡片，回车同样走下面这条服务链，只是不带附件。
- 网页里的划词与元素拾取：往 `<webview>` 注入一段脚本（`dom-ready` 时注入并重注入），页面内 `mousemove` 高亮、`click` 取矩形，`contextmenu` 取选区，用 `console.log("__DWA__"+json)` 回报宿主；宿主按 webview 的 `getBoundingClientRect` 偏移坐标后再调 `contextMenus.open`。
- 气泡与草稿的对账：每条记下行号 + 引文 / 路径 / 批注片段，按「行首编号 + 任一 token」匹配，整行消失才判定发送；发送阶段（`phase` 为 `submitting`/`sending`）直接清空这批气泡，不留记录。
- 裁图：`capturePage()` / 页面 canvas / 图片元素 → 按缩放比裁剪，四周外扩 8px，长边超过 1568 先缩小，最后以 JPEG q0.9 编码。
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

它用一个微型假 DOM 跑七个场景：网页（冻结位图 + 裁图 + 记账 + 批量插入）、纯文本（行号定位、不发图）、PDF 页码 + 引文并按 canvas 2× 裁剪、图片按自然分辨率裁剪、划词右键（压掉原生菜单、复制走选区、批注卡片回车写入且不带图）、会话切换（换会话清空气泡、切回来不恢复、草稿不动）、表格单元格范围（HTML 表格首行也算进去，输出 `Sheet1!A1:B2`）；另外覆盖「没画框时不渲染批注卡片」「右边放不下时卡片翻到左边」「点框时卡片跟着跳」「卡片只留关闭按钮、框上不留按钮、回车插入一条并继续标注」「插入后出现气泡、气泡能重新打开并改写草稿」「发送后气泡整批消失、剩余框编号不重排」「关掉一个活动气泡删行并释放附件」「新一批从 1 重新编号」「图标落在刷新按钮后」「元素路径不进提示词」「只注册 overlay 槽」「按住回车只插一次」「多行批注压成一行」「面板消失时自动收尾」「没有选区时不动系统菜单」「Esc 关掉批注卡片」「源码里没有上一代的残留」。输出 `ok — 46 checks` 即通过。

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

**Selection instead of a box.** Select a sentence in a PDF / Markdown / txt /
code preview and right-click: the menu offers *Copy* and *Annotate*. Annotate
opens the same note card, and Enter drops one line into the composer — file,
page or line, the quoted words, your note — with no crop. The native Electron
copy menu cannot host extra rows, so the plugin intercepts the gesture, cancels
the native menu and renders its own.

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
fall back to the file name when the grid exposes no row/column attributes.

**Tests**: `node test/smoke.mjs` — runs the client through a tiny fake DOM, no
DSH and no browser needed.

## License

MIT，见 [LICENSE](LICENSE)。
