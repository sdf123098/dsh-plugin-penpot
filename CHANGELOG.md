# Changelog

## 0.6.0 — 2026-11-09

发布前的收尾。这一轮是「找问题并修」，不是加功能。

### 一、Penpot 标签页被浏览器冻结（无人值守下最致命的一个）

现象：`execute_code` 报 `The Penpot plugin tab has been frozen by the browser and cannot run tasks. Please click/focus the Penpot tab to wake it, then retry.`

原因是 Chromium 在窗口被最小化或被完全遮挡时会**冻结**渲染进程 —— 定时器和 rAF 停摆，WebSocket 心跳断掉。而 Penpot 的插件正是跑在设计稿标签页里的。对自动化来说这等于整条 MCP 通道随机失效，只能人工去点一下那个窗口。

修法两层：

1. 启动参数加防冻结开关：

```js
'--disable-background-timer-throttling',
'--disable-backgrounding-occluded-windows',
'--disable-renderer-backgrounding',
'--disable-features=Translate,CalculateNativeWinOcclusion',
```

其中 `CalculateNativeWinOcclusion` 是 Windows 上最坑的那个（窗口一被遮挡就冻结）。

2. 导航之后 `Page.bringToFront` 把标签页提到前台。

### 二、`shapeId = "page"` 导出必然 500

上游拿到 `page` 会去等 `#screenshot-00000000-0000-0000-0000-000000000000`（根容器）可见，
可根容器是个 `0.01×0.01` 的隐藏 SVG，永远等不到 —— 10 秒后 500，报的还是
`locator.waitFor: Timeout`，看起来像网络问题。

现在插件先把这一页的顶层图形全选中，再走 `selection`。导出的东西一样，走的是上游唯一稳的那条路。

### 三、迁移的「导出片段」是个空操作

面板上能选「导出一段配置片段」，但 `applyMigration` 里**根本没处理这个动作** ——
选了什么也不会发生。现在真的产出 `{ url, json, toml }`，并在面板里用 `<pre>` 显示出来可以直接复制。

### 四、`penpot_read what=page` 看不到板块里的图层

只列板块本身，不列板块**里面**的东西。于是「我明明写了圆，怎么读不到」是个高频误会。

根因很隐蔽：**REST 读回来的字段是 camelCase**（`frameId` / `fillColor`），
而写进去的是 kebab-case（`frame-id` / `fill-color`）。按 kebab 去筛嵌套图层，永远匹配不到。

现在两种拼法都认，并新增「板块内的图层」段落。

### 五、发布准备

- **`DEFAULT_REPO_DIR` 写死了某个用户的绝对路径** —— 打包发出去后别人的机器上根本没这个路径。改成按 `homedir()` 推。
- `test/live.test.js` 里也有同样的写死路径，一并改掉。
- 新增 `LICENSE`（MIT）与 `.gitignore`。
- `package.json` 补 `repository` / `homepage` / `bugs` / `author`。
- `engines.node` 从 `>=20` 收紧到 `>=22`（全局 `WebSocket` 需要），并在 `CdpClient.connect` 里显式判一下，老 Node 上给可读提示而不是 `ReferenceError`。
- `npm test` 脚本从 `node --test test/` 改成 `node --test`（前者在 Node 24 上会把 `test` 当模块解析然后报 `MODULE_NOT_FOUND`）。
- 清理 3 处未使用的 import。
- `describeIntent` / `exportSnippet`（未用的旧版）等死代码清掉。

### 验收

- `npm pack` 出的 tarball：22 个文件、约 130 KB，**没有** `node_modules`、没有配置、没有凭据、没有写死的本机路径。
- 全新 `DSH_HOME` 下装载：9 个工具全部注册，`penpot_status` 正确报出「MCP 红 / REST 绿」。
- 双 Node 版本跑测试：Node 24.21 与 Node 26.13 都是 220 条全绿。

版本 0.6.0；220 条测试。

## 0.5.2 — 2026-11-09

### 一、保存按钮原来带了一整条横条

用户截图指出：保存按钮底下拖着一整条边框 + 背景的横条，滚动时会盖住底下的设置项。

原因是 `.pnp-foot` 上有 `border-top` + `background` + `backdrop-filter`，它虽然只有
一个按钮，视觉上却是一条通栏。改成：

```css
.pnp-foot{position:sticky;bottom:10px;display:flex;justify-content:flex-end;
  align-self:flex-end;margin-top:4px;pointer-events:none;z-index:2}
.pnp-foot>.pnp-btn{pointer-events:auto;
  box-shadow:0 2px 8px #00000029,0 0 0 1px #0000000d;
  padding:7px 16px;font-weight:500}
```

三个关键点：

- **去掉边框与背景** → 只剩按钮本身
- `align-self:flex-end` → 容器宽度收缩到按钮宽度（实测 wrapper 58px vs 面板 413px，不再是通栏）
- `pointer-events:none` 在容器上、`auto` 在按钮上 → 容器**不吃点击**，鼠标可以穿过它点到下面的输入框

实测（420×600 视口，塞了 8 个占位设置项制造滚动）：

```
wrapper 58×34  button 58×34  pointerEvents: none  covered: []
```

`covered: []` 表示没有任何输入框被按钮压住。

### 二、`penpot_export_shape` 用 `selection` 但没选中时的报错

原来的错误是上游内部文本：`Cannot read properties of undefined (reading 'export')` ——
对使用者毫无意义。现在先探一次 `penpot.selection.length`，是 0 就直接说：

> 当前没有选中任何图形。先在右边画布上点一个图层，或把 shapeId 换成具体 id / "page"（整页）。

（用户说「可以手改」，所以这次是手工改的，不是脚本批量替换。）

版本 0.5.2；216 条测试。

## 0.5.1 — 2026-11-09

用户报：「有点荒诞，我用我自己的号还需要访问权限？」

**不是权限问题。** 查完之后是两个真 bug，都修了。

### 一、`openDesign` 少了 `team-id` → Penpot 静默重定向到 dashboard

Penpot 的 workspace 路由要 **三个** 参数：`team-id` + `file-id`（+ 可选 `page-id`）。
只给 `file-id` 时它**不报错**，而是把 `?screen=workspace&file-id=…` 重定向到
`?screen=dashboard-recent&team-id=…` —— 用户看到的是一张「最近文件」页，
`hasApp` 是 true、控制台没有任何错误，所以极容易被读成「我没权限访问自己的文件」。

修法：

- 新增 `workspaceUrl(appUrl, { fileId, teamId, pageId })`，参数齐了才拼进地址
- 新增 `service.locateFile(fileId)`：串 `get-teams → get-projects → get-project-files`
  反查 fileId 属于哪个团队，顺手带上第一页 id
- `penpot_control op=openDesign` 和面板都支持显式 `teamId`，不给我就自动反查
- 反查不到时给出**明确警告**（而不是让人对着 dashboard 发愣）

实测：修完后 `openDesign` 一次就落到设计稿上，返回的 URL 里三个参数齐全。

### 二、`addShapes` 没法在「同一次提交」里把图层放进新建的画板

`parentId` 要的是 id，但画板的 id 在提交之前不存在 —— 调用方只能先建画板、
读回 id、再建圆，两次往返，还可能撞 revn。空着 parentId 又会把圆挂到根容器，
和画板**并列**（看起来像「没生效」）。

实测报错：`400 params-validation ... [:changes 0 :add-obj :obj 1 :circle :malli.core/in :parent-id 0]`

修法：新增 `resolveParents(specs)`，允许 `parent` 写**同批次里另一个图层的名字**：

```json
[{"type":"frame","name":"画板", ...},
 {"type":"circle","name":"圆","parent":"画板", ...}]
```

一次提交、一个版本。给了显式 `parentId` 时以它为准；指向不存在的名字、或指向自己
都安静退回根容器（不炸）。

### 三、验收：全部新建文件

两个文件、两条通道、各画一个圆，互相交叉验证：

| 文件 | 谁写 | 谁读回 |
|---|---|---|
| 验收 REST - 全新建 | `penpot_write`（无浏览器） | `execute_code` 读到 `画板` + `绿圆` |
| 验收 MCP - 全新建 | `execute_code`（浏览器 + Plugin API） | REST `get-page` 读到 `画板` + `蓝圆` |

两条通道写出来的文件**彼此都能被另一条读到**，说明落在同一份数据模型上。

### 顺带修掉的

- `penpot_export_shape` 用 `shapeId: "selection"` 时，若当前没有选中会报
  `Cannot read properties of undefined (reading 'export')` —— 这次靠先手动
  `penpot.selection = [board]` 绕过去了，错误信息本身仍不够友好（记在已知边界）。

版本 0.5.1；216 条测试。

## 0.5.0 — 2026-11-09

用户反馈：「设计太丑太挤，并且为何 readme 还在上头」。两条都要认。

### 一、界面重做

老版的问题不是细节难看，是**结构错**：状态、选项、说明、日志、迁移全部堆在一列里，读起来像一堵墙。所以这次不是调样式，是重排。

**五个标签页**，每页只回答一个问题：

| 标签页 | 只放 |
|---|---|
| 概览 | 两条通道、档位、端点、工具数、启停、日志 |
| 连接 | 连到哪个 Penpot、地址与凭据、PAT、启动方式 |
| 自动化 | REST 能做什么、无人值守浏览器、工具与审批 |
| 迁移 | 扫描与导入 |
| 高级 | 三个超时 |

**通道从「大方块」改成「两格横排」**：一行 `● MCP   Penpot 未连上来` + 一行说明，两列并排。原来每块占半屏、信息密度却很低。

**说明文字大幅收缩**：删了 3 条「只是把标签复述一遍」的（比如 `<label>调用超时（秒）</label>` 下面再写一句「单次工具调用最多等多久（秒）」），压短 18 条长句 —— 只留会让人做错事的那部分。

**保存栏改为按需出现**：之前三个段各有一个保存按钮，还藏在折叠区里；现在底部一条，**只在真有改动时出现**，并且正确排除了三个一次性输入框（贴 key 的框不该让保存栏永远挂着）。

**顺手修掉的真 bug**：

- `publicConfig()` 从来没返回 `browser` 段 —— 面板读不到「允许自己起浏览器」等开关，改了也保存不上。补上。
- 加载后如果 `saved` 快照和 `form` 不同步，保存栏会一直亮着。改成用同一套快照函数比对。
- `useStatus` 在重写中被误删，导致侧栏页一渲染就 `ReferenceError`。测试抓到了，已恢复。
- 面板文案里的 `**独立 profile**` 会原样显示成星号 —— 面板不是 Markdown。

### 二、对比度与字号

`check_design` 量出来的：

- `.pnp-hint` / `.pnp-chan-state` / `.pnp-tab` 等 9 处用了 tertiary（`#81858c`），在浅底上只有 **3.26:1**，达不到 4.5:1。全部改用 secondary（`#61666b`，约 6.9:1）—— 这些是正经要读的信息，不是装饰。
- mono 与多处正文 **10.5–11px 偏小**，统一提到 12px（日志区 11.5px 保留，它是等宽密排）。

改完 `check_design` 从 24 个问题降到 **0**。

### 三、README 彻底重写

473 行 → 按使用路径重组。删掉了排查过程的叙述（那些属于 CHANGELOG）：

- 一分钟看懂它跟别的 Penpot 集成有什么不同
- 三条要背下来的事实（没有 OAuth / 不校验 key / REST 能验凭据）
- 面板五个标签页各自放什么
- 不用浏览器的自动化（含两个真会卡住人的 schema 门槛）
- 真要浏览器时的兜底，以及 Zen 为什么用不了但照样能用

### 四、新增的防线

三条测试，防止同类问题再犯：

- 渲染里用到的每个 `t.xxx` 必须在**中英两套**里都有定义（防止某半边显示 undefined）
- 不许有定义了却没人用的死文案键（防止读代码的人以为这里还有个开关）
- 文案里不许出现 Markdown 记号

加上两条渲染冒烟测试（空状态 + 有状态各渲一遍），`useStatus` 那种「一渲染就炸」的问题不会再溜过去。

版本 0.5.0；206 条测试。

## 0.4.0 — 2026-11-09

三条用户反馈，逐条处理。

### 一、「识别状态没有结合个人访问令牌判断，依然沿用了旧判断」

这是真 bug，而且是我上一版自己引入的。

旧逻辑：MCP 探测到 `no-instance`（标签页没开）→ 看 PAT 能不能验通 → 绿的标 `waiting`（黄）、红的标 `degraded`（红）。

**错在哪**：它默认「只有 MCP 通道算能用」。而 REST 通道**不需要标签页**就能读、能写、能建文件。一个「Penpot 没打开」但 PAT 有效的插件，功能其实完好 —— 把它标成红色「已中断」是在撒谎，用户会去查错东西。

新模型：两条通道各自独立判断，再看合起来能不能干活。

| MCP | REST | state | 含义 |
|---|---|---|---|
| ✅ | 任意 | `running` | 全功能 |
| ❌ | ✅ | `rest` | 能读写设计稿，只是没有编辑器上下文 |
| ❌ | 未验证 | `waiting` | 可能只是标签页没开 |
| ❌ | ❌ | `degraded` | 真出事了 |

`this.state` 现在只记 **MCP 通道自己的**结论，不再揉进「能不能干活」。

### 二、「要自动检测，无论是否开启服务」

新增 `service.autoCheck()`，在 `index.js` 里挂了一个独立的定时器（启动 1.2 秒后一次，之后每 2 分钟）。

关键点：**它不建 MCP 连接、不拉本地进程、不改 `state`**，只发一个 `get-teams` 验 REST 通道。因为 REST 通道根本不需要 MCP 服务 —— 让它跟着 MCP 的启停走，`lazy` 档下就永远不检测，面板一直显示「未启动」。

60 秒内复用上一次结论，不会每次轮询都打远端。定时器 `unref()`，不吊着 DSH 进程。

实测：`state` 为 `idle` 时自检照样跑，拿到「凭据有效 · 可以读到 1 个团队」，面板状态变成 `rest`。

### 三、「选项杂乱无章，多有重复文字，readme 和选项不要放在一起，分成几个标签页」

面板重构成五个标签页：

| 标签页 | 内容 |
|---|---|
| 概览 | 两张通道卡、档位、端点、工具数、启停、日志 |
| 连接 | 三档 + 自动、地址与凭据、PAT、启动方式 |
| 自动化 | REST 能做什么、无人值守浏览器、工具与审批 |
| 迁移 | 扫描与导入 |
| 高级 | 超时、空闲停止 |

顺手清掉的重复：

- 「连接目标」既当段标题又当字段标签 → 分成 `tabConnection` / `connMode`
- 「本地自构建」「自部署」同理
- 端口那一组的 `ports httpPort` 拼成一句怪话 → 只留 `httpPort`
- 「官方托管 · 官方端点」→ 只留 `officialEndpoint`
- 三个段各自一个「保存」按钮（还藏在折叠里）→ 底部一条固定保存栏
- `t.apply` 既当迁移按钮又当自动识别按钮 → 拆开

通道状态从「一个圆点」改成**两张卡**，各带 badge，明确标出「需要标签页 / 不需要标签页」。这是第一点那个 bug 的可视化根源 —— 一个圆点概括两条通道必然说谎。

### 四、README 彻底重写

473 行 → 重写为按使用路径组织的版本。去掉了大段排查过程的叙述（那些属于 CHANGELOG），保留：

- 一分钟看懂它跟别的 Penpot 集成有什么不同
- 三条要背下来的事实（没有 OAuth / 不校验 key / REST 能验凭据）
- 面板五个标签页各自放什么
- 不用浏览器的自动化（含两个真会卡住人的 schema 门槛）
- 真要浏览器时的兜底，以及 Zen 为什么用不了但照样能用

### 其他

- `penpot_status` 也改成两条通道分开报（`MCP 通道:` / `REST 通道:`），不再让一个 `probe:` 行代表全部
- 版本 0.4.0；201 条测试

## 0.3.0 — 2026-11-09

用户问：「如果我要自动化，我不可能手动打开网页，而且我不一定开 Edge/Chrome，
而是默认浏览器 Zen。这对插件自动化不利。」

这个顾虑成立，但拆开看是两件不同的事，而且**第一件比第二件重要得多**。

### 一、绝大多数自动化压根不需要浏览器（`src/design.js` + `penpot_write`）

实测（design.penpot.app，2026-11-09）Penpot 的 REST 命令集**支持写**，
只要 `Authorization: Token`，**零浏览器**：

| 能力 | 命令 |
|---|---|
| 建文件 / 删 / 改名 / 复制 | `create-file` / `delete-file` / `rename-file` / `duplicate-file` |
| 建/删页面 | `update-file` 的 `add-page` / `del-page` |
| 加图层 / 改属性 / 删图层 | `update-file` 的 `add-obj` / `mod-obj` / `del-obj` |

`DesignWriter` 把这一套封好了，新工具 `penpot_write` 有 9 个 op：
`createFile` / `addPage` / `addShapes` / `modifyShape` / `deleteShapes` /
`deletePage` / `renameFile` / `duplicateFile` / `deleteFile`。

真机验证（建了一个文件、写了画板+矩形+文字、改了 x 和名字、删了图层、加删了页面、
改了名、删了文件，全程没开浏览器）。

两个必须知道的门槛，都已在代码里处理：

- **`features` 数组必填**：`create-file` / `update-file` 缺了会 400
  `feature-not-supported`。用一份保守集合（与官方前端默认一致）。
- **对象字段「少给不行、多给也不行」**：`add-obj` 的 obj 有 malli schema。
  必填：`id/type/name/x/y/width/height/selrect/points/transform/transform-inverse/frame-id/parent-id`，
  `type=frame` 还要 `shapes: []`。但 `fills` 里**多给 `fill-image` 或
  `fill-color-gradient`（哪怕是 null）就 400** —— 只给 `fill-color` + `fill-opacity` 才行。

安全边界：写命令在 `WRITE_ALLOWED` 白名单里，且必须显式 `allowWrite: true` ——
读路径就算参数拼错也不可能改稿子。白名单**不含**删团队/改权限这类。

另外修了一个真 bug：`rename-file` / `delete-file` 返回 **204 无正文**，
之前被当成失败（`HTTP 204:` 报错）。204 现在正确判为成功。

### 二、真要浏览器时，用插件自己的实例（`src/browser.js`）

给「必须走 MCP 通道、但没人在旁边开网页」的场景兜底：

- 自己拉起一个 Chromium（Chrome / Edge / Brave），用**独立 profile**
  （`<DSH_HOME>/data/dsh-plugin-penpot/browser/profile`）——
  **完全不碰用户的默认浏览器**，Zen 也好 Chrome 也好都不受影响。
- CDP 驱动（Node 24+ 自带 WebSocket，不引 puppeteer）：`Page.navigate` +
  `Runtime.evaluate`，判断登录态（URL 在站上 / 没停在 `/auth/` / 有 `#app`）。
- 复用已有实例，不重复开；关闭时先 `Browser.close`（让 cookie 落盘），兜底再 kill。
- `penpot_control` 新增三个 op：`openDesign` / `closeBrowser` / `browserStatus`。
- 面板加「无人值守浏览器」区块（开关默认**关**：这是替你开程序，该由你决定）。

关于 Zen：它是 Firefox 内核，**没有 CDP**，脚本驱动不了。但 Penpot 插件本身
是浏览器无关的（Penpot 把它放在 iframe 里跑），你在 Zen 里照常
`从 URL 载入` 手动用完全没问题。缺浏览器时的报错会把这一点写清楚，
并指向 `penpot_write` 这条不需要浏览器的路。

### 踩到的坑（都写进注释了）

- `/json/list` 里排在前面的可能是 `edge://sync-confirmation-dialog/` 这类内部页，
  「取第一个 type=page」会拿到它 —— 导航能提交，但 `#app` 永远为空，登录判断就错。
  现在只认 `http(s)://`，同站优先。
- 新 profile 启动时可能一个 http 页面都没有，得用 `/json/new` 主动开一个。
- 刚导航过去时 `document.body` 还是 null，表达式一抛异常 CDP 就回
  `exceptionDetails` 而不是值 —— 看起来像「页面空」，其实只是读早了。
  现在表达式内部自己兜错。
- SPA 路由会晚一步才跳到 `/auth/login`，只在固定延时后读一次会误判成已登录。改成轮询等 URL settle。

### 其他
- 9 个模型侧工具（新增 `penpot_write`）；`penpot_control` 加 3 个 op。
- 197 条单元/装载测试 + 7 条 live/E2E（默认跳过）。
- 版本 0.3.0。

## 0.2.1 — 2026-11-09

### 修复：MCP key 第二次被面板保存抹掉（上一版没修干净）

用户问「为何配完密钥还是不全绿」，一查：**config.json 里的 userToken 又没了**。

根因和上一版不是同一个：

| 版本 | 症状 | 上一版的修法 | 漏在哪 |
|---|---|---|---|
| 0.2.0 前 | 回显 `userToken=***` 被写回 | `guardPatch` 拦占位符 | —— |
| 0.2.0 | 表单 `cleanEndpoint()` 把 token 连 `***` 一起删了，提交上来是**真的没有 token 的干净 URL** | 同上 | 护栏只认 `***`，那时字符串里连 `***` 都没有 |

**根治：token 不再住在 URL 里。** `resolveConfig` 用 `splitUserToken()` 把
`…?userToken=xxx` 拆成「干净 endpoint + 独立 `.token` 字段」，连接时由
`mcp-client.withToken()` 拼回去。这样端点输入框可以安心显示干净地址，
用户编辑地址也碰不到凭据 —— 从形态上消灭了「二选一」。

配套两道防线（`src/store.js`）：
- `guardPatch()` —— 占位符不写盘（原有）
- `keepCredentials()` —— **新增**：patch 里没带 token 就沿用磁盘上已有的；
  显式传空串仍然表示「我要清空」，用户粘了带新 key 的地址则让新的赢。

`test/credentials.test.js` 14 条测试盯住这条链路，包括「连点三次保存 key 仍在」。

### 改进：状态语义不再谎报「已中断」

以前只要 `execute_code` 探测失败就标 `degraded`（界面红点「已中断」），
用户看到「配完密钥还是红的」以为插件坏了。实际上 Penpot 的 MCP 通道
**按协议就必须有设计稿标签页在线** —— 那是 Penpot 的设计，不是插件出错。

新增 `waiting` 状态（黄点「就绪，等 Penpot 打开」）：
- 探测停在 `no-instance`，但 PAT 通道证明**凭据有效** → `waiting`
- 探测停在 `no-instance` 且凭据无法证明 → 仍然是 `degraded`（真出事了）

`snapshot().state` 现在以**探测结论**为准，而不是「握手成功」——
官方服务端对任何 key 都返回 200，握手成功不代表能干活。

## 0.2.0 — 2026-11-09

### 新增：本地档的插件 UI 由插件自己托管（`src/plugin-host.js`）

Penpot 的连接是**两段**的：浏览器标签页加载插件 UI → 插件连本机 MCP。
第二段一直有，**第一段原来没人管** —— 上游靠 `pnpm run bootstrap` 起 vite preview，
要用户自己装依赖、记端口、手动起服务，而且它和 MCP 服务器是两条命。

- `local.pluginHosting = bundled`（新默认）：本地档建连时顺手起一个静态服务，
  发 `packages/plugin/dist`，停服务时一起停；端口 `local.pluginPort`（默认 4400）。
- 三种托管方式：`bundled` / `port`（交给 MCP 的 4400）/ `external`（你自己）。
- `resolvePluginDir()` 找不到产物时给**能动手的理由**（"只构建了 server？"），
  而不是一句"去构建"。
- 安全边界（`test/plugin-host.test.js` 10 条）：只服务 dist 内文件、路径穿越与
  URL 编码穿越拒绝、**符号链接 / Windows 目录联接逃逸拒绝**、MIME 白名单、
  只 GET/HEAD、端口占用报 EADDRINUSE 并说明可能是谁。
- `Access-Control-Allow-Origin: *` 是**必须的**：Penpot 页面在 `design.penpot.app` 域下。
- 失败不阻断 MCP 连接 —— 用户可能已用自己的 nginx 托管。

### 新增：个人访问令牌（PAT）只读通道

用户指出「你是不是忘了还有个人访问令牌」——确实漏了，而且它比预想的更重要。

实测（`design.penpot.app`，2026-11-09）：Penpot 有**两条独立通道**，凭据与认证头都不同：

| 通道 | 凭据 | 认证头 | 需标签页在线 | 能力 |
|---|---|---|---|---|
| MCP `/mcp/stream` | MCP key（URL `userToken`） | 无（头被忽略） | 必须 | 执行插件代码 |
| REST `/api/rpc/command/*` | PAT，或**同一个 MCP key** | `Authorization: Token` | 不需要 | 只读 |

- `src/rest.js`：只读 RPC 通道。白名单 `ALLOWED_COMMANDS` 里**只有读命令**；
  PAT 有写权限，但插件不该在用户没通过 Penpot 插件确认时改他的稿子。
- 新工具 `penpot_read`：`teams` / `team` / `projects` / `projectFiles` / `recentFiles` /
  `fileInfo` / `pages` / `page` / `fileSummary` / `fileLibraries` / `teamMembers` / `verifyToken`。
  不过审批 —— 改不了任何东西。
- `service.probePat()` + `PAT_STAGES`：五级（端点可达 / 没配令牌 / 令牌无效 / 被网关挡了 / 凭据有效）。
  **这是 MCP 通道做不到的事**：MCP 服务端对任何 key 都返回 200，只有 REST 的 401 能证明令牌是死的。
- `probe()` 停在 `no-instance` 时**自动借 PAT 通道验一次凭据**，把「key 错了」和「标签页没连」
  这两件 MCP 通道分不清的事分开写进诊断里。
- PAT 通道的地址：远端档用当前端点；**本机档回落到已配置的远端端点**（PAT 走 REST，
  与「MCP 连本地还是连云端」无关）。所以本机跑 MCP 服务器时照样能读云端设计文件。
- `penpot_status` 多报一行 PAT 状态与令牌来源。

关键实测结论：
- **Integrations 里那个 MCP key 本身就是有效 PAT** —— 不必另建令牌，`pat.reuseMcpKey` 默认开。
- REST **只认 `Token` 前缀**，`Bearer` 一律 401。
- `get-profile` 被 Cloudflare 单独挡（403 Just a moment），其余命令不受影响 → 验凭据用 `get-teams`。
- 文件格式里板块 `type` 是 `frame`（编辑器里叫 board）；`get-page` 必须同时给
  `file-id` + `page-id`，只给前者拿回默认页（Page 1，只有一个 Root Frame）。
- Node 直连 `design.penpot.app` 的 REST：`get-teams` / `get-projects` / `get-file` 都通，
  只有 `get-profile` 被网关拦。

### 修复：面板保存会把脱敏占位符写回磁盘（**真事故**）

面板把后端回显的 `…?userToken=***` 填进输入框，用户点「保存」就把占位符存下来，
**当场覆盖掉真 MCP key**。两道防线：
- 前端：`cleanEndpoint()` 初始化表单时先摘掉 `userToken`，凭据单独一行只显示「配没配」。
- 宿主：`guardPatch()` 写盘前把带占位符的字段整条摘掉并回落上一层，其余字段照常保存
  （不能因为一个字段就丢掉用户这一轮真正想改的东西）。
- `test/guard.test.js` 6 条测试 + `test/client.test.js` 里一条源码守卫盯住它。

### 其他
- 8 个模型侧工具（新增 `penpot_read`）。
- 153 条单元/装载测试 + 6 条 live 联调（默认跳过）。

## 0.1.0 — 2026-11-09

首个版本。四个需求点全部落地，外加 dsh-better-sidebar 适配。

### 连接目标
- **`auto`（默认）**：首启扫描本机已有的 penpot MCP 配置（DSH profile / Codex / Claude Code /
  Claude Desktop / Cursor / Gemini CLI / 项目级 `.mcp.json`），同源去重、并发探测、
  按来源亲疏挑一条，并把「来自哪条配置」显示在面板上。手动改档后不再自动覆盖。
- `official`：`design.penpot.app/mcp/stream`（含 beta 端点），凭据是 Penpot Integrations 的 MCP key。
- `local`：本机跑 `packages/server/dist/index.js`，或 `npx @penpot/mcp@<tag>`。
- `selfhost`：自己部署的 Penpot，协议同官方。

### 启动方式
- `auto`（加载即启动）/ `lazy`（首次调用才启动，之后常驻，不随回合结束释放）。
- 本地进程 detached 启动，`local-run.json` 记录 pid；DSH 重启后**接管**而不是重起。
- 端口被占时先验证对面是不是 penpot，是才接管，否则报占用者 PID 且**绝不盲杀**。

### 控制面板
- 挂在 `plugins.bundle.config` 槽（侧边栏「插件」→ 本插件页），**默认展开**。
- 七块：状态条（含四级探测与溯源）、连接目标、启动方式、动作、工具与审批、迁移、高级。
- `/api/penpot/*` 走 DSH 自己的 `/api` 信任栅栏（`ctx.connection.requestRejection`，
  每次请求现读）；写请求要 `x-dsh-penpot` 头；token 只回「配没配 + 尾 4 位」。

### 迁移
- 扫描 8 类来源，按名字/URL/命令特征识别（**不按 Auth=OAuth**，那会误伤 hyperframes）。
- 三个动作：只导入（默认，不动别人）/ 导入 + 就地停用（先备份，可还原）/ 只导出片段。
- 停用按格式：TOML 插 `enabled = false`、JSON 加 `"disabled": true`、
  YAML 逐行加注释前缀（保留 `!!js` 表达式与缩进）。
- **不把 key 写成 Bearer** —— 实测 Penpot 忽略 `Authorization` 头，只认 URL 的 `userToken`。

### 四级探测
- 端点可达 / 缺 MCP key / Penpot 未连上来 / 已打通，四句全都来自真实服务端报错文本。
- 关键修正：Penpot 的失败**不设 `isError`**，必须看 `Tool execution failed` 文本前缀，
  否则会把「插件没连」误判成「已打通」。

### dsh-better-sidebar 适配
- 装了 better-sidebar 时注册 `penpot:dashboard` 侧栏页（状态 / 探测 / 日志）。
- 用 `ctx.inject(['betterSidebar'])` 等它；没装就跳过，不影响插件页卡片。

### 其他
- 8 个模型侧工具；`execute_code` 与 `import_image` 走 DSH 审批闸门，`penpot_read` 不过审批。
- 系统提示公告（中英双段），说明三档、四级探测与「没有 OAuth」这件事。
- 138 条单元/装载测试 + 3 条 live 联调（默认跳过）。

### 落地阶段修的三处真问题
- **桥文件归一**：老的 `mcp-lazy-penpot` 配置指向 `penpot-stdio-bridge.mjs`，
  迁移时若照抄这个入口，会再套一层 stdio→HTTP 的桥、多起一个进程去抢 4401。
  现在 `classifyStdio` 把桥归一成真正的服务器入口 `packages/server/dist/index.js`。
- **`drainSession` 卡死**：等 socket 关闭的 150ms 定时器原本 `unref` 了，
  没有别的句柄时进程会直接退出、`await` 永不 resolve（实测 `disconnect` 后
  报 "Detected unsettled top-level await"）。改成正常定时器。
- **客户端半边补测**：`lib/client.js` 是经典脚本，浏览器里白屏最难查。
  新增 `test/client.test.js`，用假 window + react 替身在 vm 里真装载一遍，
  断言 `plugins.bundle.config` 的 key 是包名、better-sidebar 缺失时不抛。
