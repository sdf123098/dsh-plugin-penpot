# dsh-plugin-penpot

把 [Penpot](https://penpot.app) 接进 DSH。两个能力面：

- **控制面** —— 把 Penpot 官方托管的 MCP 服务器 / 本机自构建的 / 自己服务器上部署的，接成 DSH 的模型侧工具；两种启动方式；插件页控制面板；从其他 MCP 客户端迁移配置。
- **设计面** —— 在不需要浏览器的情况下读写设计稿。建文件、加页面、加图层、改属性、删图层，全走 REST。

---

## 一分钟看懂它跟别的 Penpot 集成有什么不同

Penpot 的 MCP 服务器有个硬约束：`execute_code` 是在**设计稿标签页里**跑的插件代码，所以必须有浏览器开着。这对「我点一下让你改个颜色」没问题，但对自动化是致命的。

这个插件多做了一件事：它发现 Penpot 的 REST 命令集**也支持写**，只要一个 `Token` 头，**零浏览器**。于是：

| | MCP 通道 | REST 通道 |
|---|---|---|
| 需要 Penpot 标签页 | **是** | 否 |
| 能读设计数据 | 是 | 是 |
| 能写设计稿 | 是（任意 Plugin API） | 是（文件/图层级常规操作） |
| 能读编辑器上下文（当前选中、插件 API） | 是 | 否 |
| 适合 | 交互式改稿 | 自动化、批量、无人值守 |

**两条通道各自独立**，所以面板顶部是两格并排的状态条，不是一个总开关。标签页没开只让 MCP 变黄，REST 绿着就照样能干活。

---

## 安装

需要 **Node 22+**（驱动浏览器那段用的是全局 `WebSocket`；只用 REST 通道的话 20 也够）。

```bash
# npm
npm install -g dsh-plugin-penpot
# 或让 DSH 装
dsh plugin install dsh-plugin-penpot
# 或从 GitHub
dsh plugin install github:sdf123098/dsh-plugin-penpot
```

装好后在 **设置 → 插件** 里启用，配置卡片就在插件那一页里。

插件加载后不做任何副作用动作：不拉进程、不开浏览器、不发请求。它在后台做一次**只验 REST 通道**的自检（一个 `get-teams`），然后安静等你的下一个动作。

---

## 三条要背下来的事实

Penpot 的鉴权模型和大多数服务不一样，不理解这三点会觉得插件「行为奇怪」。

**一、Penpot 没有 OAuth。** 凭据就是拼在 URL 上的 MCP key：`https://design.penpot.app/mcp/stream?userToken=<key>`，在 Penpot 里「账户 → Integrations → MCP Server」生成。`Authorization` 头对 MCP 通道是**被忽略**的。

**二、MCP 服务端不校验 key 本身。** 它只是拿 key 去索引「已经连上来的那个 Penpot 标签页」。所以：

- 随便填个字符串，`initialize` 和 `tools/list` 照样 200
- key 对不对，在没有 Penpot 会话时**无法离线判断**
- 「连上了」不是布尔值，是一个台阶

**三、REST 通道能验证凭据 —— MCP 通道做不到这件事。** REST 认 `Authorization: Token <值>`，401 就是真无效，200 就是真有效。而且 **Integrations 里那个 MCP key 本身就是有效 PAT**，同一个字符串两个用途，不必另建令牌。

> 顺带一个坑：REST **只认 `Token` 前缀**，`Bearer` 一律 401。所以本插件在迁移配置时绝不把 key 写成 Bearer。

---

## 面板

插件页的卡片分成五个标签页，互不干扰：

| 标签页 | 放什么 |
|---|---|
| **概览** | 两格通道状态、档位、端点、工具数、启停按钮、日志 |
| **连接** | 连到哪个 Penpot（三档 + 自动）、该档的地址与凭据、PAT、启动方式 |
| **自动化** | 不需要浏览器能做什么、无人值守浏览器、工具与审批 |
| **迁移** | 扫描并导入其他 MCP 客户端的 penpot 配置 |
| **高级** | 超时、空闲停止 |

只有「连接」「自动化」「高级」里有可改的表单项；「概览」「迁移」是操作与结果。保存按钮**只在真有改动时出现**，浮在右下角、不挡任何设置项，点一次跨标签页生效。

### 两格通道状态

MCP 卡绿 = 能跑任意插件代码。REST 卡绿 = 能读写设计稿。

- 只有 MCP 绿：全功能
- 只有 REST 绿（最常见）：能读能写，但没有编辑器上下文
- 两张都红：真出事了，看卡片上的 detail

---

## 连接目标

四档，第一档是默认：

**自动识别** —— 首次加载时扫描本机已有的 penpot MCP 配置（DSH profile / Codex / Claude Code / Claude Desktop / Cursor / Gemini / 项目级 `.mcp.json`），用扫到的那条当默认，并在面板标出来源。找不到就回落到本地档。优先级：DSH > 项目 > Codex/Claude > 其他。

**官方托管** —— `https://design.penpot.app/mcp/stream`。凭据是 Integrations 里的 MCP key。

**本地自构建** —— 本机跑 `packages/server/dist/index.js` 或 `npx @penpot/mcp`。单用户模式，不鉴权。比官方多一个 `import_image`。

**自部署** —— 自己服务器上的 Penpot，协议同官方。自签证书可以放行。

### 启动方式

- **加载即启动** —— 插件加载后立刻建连
- **首次调用才启动（之后常驻，不随回合结束释放）** —— 默认

本地档的进程是 detached 的，`local-run.json` 让下次加载能接管已有实例。停止时会核对 pid 的命令行再动手，绝不盲杀端口占用者。

---

## 模型侧工具

九个：

| 工具 | 说明 |
|---|---|
| `penpot_status` | 两条通道各自的状态与诊断。出问题先调它 |
| `penpot_execute_code` | 在设计稿里跑 JS（需要标签页） |
| `penpot_high_level_overview` | 上游的「能做什么、怎么写」 |
| `penpot_api_info` | Penpot Plugin API 的类型/成员查询 |
| `penpot_export_shape` | 导出图形 |
| `penpot_import_image` | 导入本地图片（仅本地档） |
| `penpot_read` | **REST 只读**，不需要标签页 |
| `penpot_write` | **REST 写**，不需要标签页 |
| `penpot_control` | start / stop / restart / probe / detect / logs / config / openDesign / browserStatus / closeBrowser |

审批闸门拦三个：`penpot_execute_code`、`penpot_import_image`、`penpot_write` —— 它们都会改东西。`penpot_read` 不过闸门：它只发白名单里的读命令，改不了任何东西。

---

## 不用浏览器的自动化

```js
// 建文件
penpot_write  op=createFile  projectId=<项目id>  name=我的稿子

// 加图层（一次提交，一个版本）
penpot_write  op=addShapes  fileId=<文件id>
  shapes=[{"type":"frame","name":"Board","width":1440,"height":900,"fill":"#ffffff"}]

penpot_write  op=addShapes  fileId=<文件id>
  shapes=[{"type":"text","name":"标题","x":40,"y":40,"width":400,"height":40,
           "text":"你好","fontSize":32,"fontWeight":"700","parentId":"<boardId>"}]

// 改属性 / 删图层 / 增删页面 / 改名 / 复制 / 删文件
penpot_write  op=modifyShape   fileId=…  pageId=…  shapeId=…  set={"x":500,"name":"新名字"}
penpot_write  op=deleteShapes  fileId=…  pageId=…  shapeIds=a,b
penpot_write  op=addPage       fileId=…  name=第二页
penpot_write  op=deletePage    fileId=…  pageId=…
penpot_write  op=renameFile    fileId=…  name=新名字
penpot_write  op=duplicateFile fileId=…
penpot_write  op=deleteFile    fileId=…
```

### 两个会让你卡半小时的门槛

**`features` 数组必填。** `create-file` 和 `update-file` 缺了会 400 `feature-not-supported`。插件已经内置一份保守集合。

**对象字段「少给不行、多给也不行」。** `add-obj` 的 obj 有 malli schema。必填 13 个：`id/type/name/x/y/width/height/selrect/points/transform/transform-inverse/frame-id/parent-id`；`type=frame` 还要 `shapes: []`。但 `fills` 恰恰相反：**多给 `fill-image` 或 `fill-color-gradient`（哪怕是 null）就 400** —— 只给 `fill-color` + `fill-opacity` 才行。这些都在 `makeShape` 里处理好了。

### 安全边界

写命令在 `WRITE_ALLOWED` 白名单里，且必须显式 `allowWrite: true` —— 读路径就算参数拼错也不可能改稿子。白名单**不含**删团队、改权限这类。

---

## 真要浏览器时

给「必须走 MCP 通道、但没人在旁边开网页」兜底：

```
penpot_control  op=openDesign     fileId=<设计稿id>
penpot_control  op=browserStatus
penpot_control  op=closeBrowser
```

它会自己拉起一个 Chromium（Chrome / Edge / Brave），用**独立 profile**（`~/.dsh/data/dsh-plugin-penpot/browser/profile`），**完全不碰你的默认浏览器**。复用已有实例；关闭时先 `Browser.close`（让 cookie 落盘），兜底再 kill。

开关默认**关** —— 这是替你开程序，该由你决定。

### 为什么 Zen 用不了、但你照样能用它

| 浏览器 | 内核 | 能脚本驱动 |
|---|---|---|
| Chrome / Edge / Brave | Chromium | ✅ CDP |
| **Zen / Firefox** | Gecko | ❌ 没有 CDP |
| Safari | WebKit | ❌ |

**插件本身是浏览器无关的** —— Penpot 把它放在 iframe 里跑。你在 Zen 里 `文件 → 插件 → 从 URL 载入` 一样能用，只是我驱动不了它。

而且**大多数自动化根本不需要浏览器** —— 见上一节。找不到可驱动浏览器时，报错会直接指向 `penpot_write`。

---

## 从其他 MCP 客户端迁移

面板「迁移」标签页：扫描 → 勾选 → 应用。支持 DSH / Codex / Claude Code / Claude Desktop / Cursor / Gemini / 项目级 `.mcp.json`。

每条可以选「只导入」「导入并禁用原条目」「导出一段配置片段」。写入前自动备份。

三条底线：

- **绝不把 key 写成 Bearer** —— REST 会 401
- **绝不按「Auth=OAuth」筛** —— Penpot 没有 OAuth
- **绝不改 `*.bak` 文件**

---

## 配置项

```yaml
mode: auto              # auto | official | local | selfhost
startup: lazy           # lazy | auto
requireApproval: true
exposeControlTool: true
toolCallTimeoutMs: 180000
connectTimeoutMs: 60000
idleStopMinutes: 0      # 0 = 不停

official:
  endpoint: https://design.penpot.app/mcp/stream
  token: ''             # 单独存，不从 URL 里抠

selfhost:
  url: ''
  allowInsecureTLS: false

local:
  sub: repo            # repo | npm
  repoDir: ''
  entry: ''
  nodePath: ''
  httpPort: 4401
  wsPort: 4402
  replPort: 4403
  pluginHosting: bundled   # bundled | port | external
  pluginPort: 4400

pat:
  token: ''
  reuseMcpKey: true    # Integrations 那个 key 本来就是有效 PAT

browser:
  autoLaunch: false
  path: ''
  headless: false
```

覆盖文件在 `~/.dsh/data/dsh-plugin-penpot/config.json`，面板保存时写入。

**凭据只回「配没配」，从不回显。** 面板里令牌输入框永远是空的，留空 = 不改。这条规则是拿真事故换来的（早期版本会把脱敏后的 `?userToken=***` 写回去，把 key 弄丢两次）。

---

## 数据目录

```
~/.dsh/data/dsh-plugin-penpot/
├── config.json       面板保存的覆盖
├── detected.json     自动识别的结果
├── local-run.json    本地进程的 pid / 端口（用于接管）
├── browser.json      自己起的浏览器实例
├── browser/profile/  独立浏览器 profile
└── logs/
```

---

## 已知边界

- **导出不走 REST。** `/api/export` 在官方托管上返回 500，所以 `penpot_export_shape` 仍然需要 MCP 标签页。`shapeId="page"` 会自动先选中这一页的顶层图形再导（上游直接导整页会因为等根容器而超时）。
- **`get-profile` 被 Cloudflare 单独挡**（403 `Just a moment`），所以验凭据用 `get-teams`。
- **`rename-file` / `delete-file` 返回 204 无正文** —— 别把它当失败。
- **`get-file-info` 只回 `id`**，拿不到名字；要名字用 `get-project-files`。
- **REST 读回来是 camelCase**（`frameId`、`fillColor`），写进去是 kebab-case（`frame-id`、`fill-color`）。同一个字段两种拼法，代码里两种都认。
- **Penpot 标签页会被浏览器冻结**。后台标签页的定时器停摆，`execute_code` 就报「tab has been frozen」。插件启动浏览器时已经带上防冻结的开关，并把标签页提到前台；但如果你手动把它最小化很久，仍可能触发。
- 本地档没有 REST API，所以 REST 通道在本地档下会回落到已配置的远端端点（这是有意为之：本机跑 MCP、同时读云端文件是常见情形）。
- 面板状态是**探测结论**，不是握手结果。官方服务端对任何 key 都 200，拿握手当绿灯会骗人。
- **Zen / Firefox 驱动不了**（没有 CDP）。插件自己起的是 Chromium 系；你手动在 Zen 里加载插件照常可用。

---

## 开发

```bash
node --test                            # 220 条单元/装载测试
PENPOT_LIVE=1 PENPOT_LIVE_TOKEN=<key> node --test test/live.test.js
PENPOT_BROWSER_E2E=1 node --test test/browser.test.js
```

开发时这个包用 `link:` 装进 profile，改完直接重载插件即可（不用重启 DSH）。

---

## License

MIT © [sdf123098](https://github.com/sdf123098)
