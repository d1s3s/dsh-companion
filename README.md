# dsh-companion

陪伴型 DSH 插件。装上之后你的 Agent 就多四件事：**记得你**、**看得见屏幕**、**能看摄像头**、**能替你说话**——以及一件更重要的事：**这些能力每一项都由你单独发钥匙，随时能收回。**

不是又一个桌宠。桌宠只负责好看，这个负责记得你昨天否决了什么。

**核心不认识 DSH。** 它只依赖五个宿主方法，所以同一个内核能跑在 DSH 插件里，也能跑成 MCP server——Claude Desktop、Cursor、Cline、Zed 接上就是同一套记忆、同一套权限、同一套账本。换模型、换客户端，记忆不用重来一遍。怎么换见 `ADAPTERS.md`。

---

## 能力

| 能做什么 | 工具 | 出厂权限 |
|---|---|---|
| 截一张屏 | `companion_see_screen` | 每次询问 |
| 连看一段屏幕（盯进度、看变化） | `companion_watch_screen` | **禁止** |
| 看一段本地视频（抽帧，刷视频/看录屏） | `companion_watch_video` | 每次询问 |
| **不用截图知道你在看什么**（前台窗口 + 平台识别，约 0 token） | `companion_now_viewing` | 本会话允许 |
| **自己开网页刷**（B站/抖音/小红书/快手，读标题作者热评） | `companion_open_site` | 每次询问 |
| **自己往下刷**（滚动、切下一条，不点按钮） | `companion_browse_next` | 每次询问 |
| **在 App 里刷**（抖音客户端，只发滚轮绝不点击） | `companion_app_scroll` | **禁止** |
| **按时段自己刷**（受四道闸约束） | `companion_browse_auto` | **禁止** |
| **按主题收集视频**（给个话题拿回一串结果） | `companion_collect` | 每次询问 |
| **把看到的视频记下来**（进长期记忆，以后能主动提） | `companion_keep_video` | 允许 |
| **评论**（默认只准备不发送，核对后才发） | `companion_comment` | 发送**禁止** |
| **改刷视频的设置**（时段/时长/评论配额） | `companion_browse_settings` | 允许 |
| 开一次摄像头 | `companion_see_camera` | 每次询问 |
| 枚举摄像头 | `companion_list_cameras` | 允许 |
| 记住一条结论 | `companion_remember` | 每次询问 |
| 按关键词回忆 | `companion_recall` | 本会话允许 |
| 取否决 / 认知修订 | `companion_valuable` | 本会话允许 |
| 起草消息 | `companion_draft_message` | 允许 |
| 发出去 | `companion_send_message` | 每次询问 |
| 看 token 花了多少 | `companion_cost` | 允许 |
| 调权限 | `companion_permission` | 只能自己收权 |
| **换形象 / 列出所有形象**（立刻生效，不用重启） | `companion_character` | 允许 |
| **用外部模型想一件事**（OpenAI / Claude / 千问 / DeepSeek） | `companion_model` | 每次询问 |
| **配模型的密钥**（存本机 `keys.json`，权限 600） | `companion_model_key` | 每次询问 |

「连看屏幕」和「截一张屏」是**两项独立权限**，不是同一个开关。允许你截一张图，不等于允许你一直看着——这个区别在别的产品里经常被抹掉，这里不抹。

## 形象：六种可选，随时换

```bash
companion_character action=list                  # 看全部
companion_character action=use pack=theme-gpt    # 换，立刻生效
```

| 内置配色皮肤（零体积，随插件走） | 角色包（真美术） |
|---|---|
| `theme-default` 深海蓝 | `bigfish-classic` 大肥鱼·内置（60 个动作） |
| `theme-gpt` 青绿（像 OpenAI 的配色） | `bigfish-adult` 大肥鱼·成年版（8 组动作） |
| `theme-claude` 陶土橙（像 Claude 的配色） | 你自己的 `.dshpet`（放进 `~/.dsh-companion/packs/`） |
| `theme-qwen` 星紫（像通义千问的配色） | |

**为什么是配色不是官方形象**：OpenAI / Anthropic / 阿里都是有法务的商业主体，复制它们的官方形象是商标问题——这和用社区角色不是一回事。这里借的是气质（青绿偏工程、陶土偏人文、星紫偏科技），不复制任何 logo。你自己的素材放进 `packs/` 就行，那些包优先级更高。

## 接自己的模型

有些事得她自己会想：刷完一堆视频判断哪条值得留、写评论草稿、看一帧猜你在干嘛。以前靠关键词硬编码，一看就假。

```bash
# 配一个（三家都行，另外还支持 DeepSeek）
companion_model_key provider=qwen key=sk-xxxx
# 或走环境变量：DASHSCOPE_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY

companion_model action=status     # 看哪些配好了
companion_model input="这条视频在讲什么：…" provider=qwen
```

| provider | 默认模型 | 端点 | 国内直连 |
|---|---|---|---|
| `qwen` | `qwen-plus` | DashScope 兼容模式 | ✅ 推荐 |
| `deepseek` | `deepseek-chat` | api.deepseek.com | ✅ |
| `openai` | `gpt-4o-mini` | api.openai.com | ⚠ 需代理（可设 `OPENAI_BASE_URL`） |
| `anthropic` | `claude-3-5-haiku-latest` | api.anthropic.com | ⚠ 大陆 IP 返回 403，需代理 |

实测：三家协议都验证过（假 key 打真端点，千问回 401、Anthropic 回 403 而不是 400，说明请求结构全对）。**模型花的钱按上游回报的实际 token 记账**，不用估算糊弄。

密钥只存 `~/.dsh-companion/keys.json`（权限 600），不写进代码、不进日志、不回显全文。

---

## 安装

**要求**：Node 20 以上。零外部依赖，不用 `npm install`。

下面几项都是**可选**的，缺了只掉对应的能力，不影响记忆和聊天：

| 缺什么 | 会掉哪些能力 | 怎么补 |
|---|---|---|
| ffmpeg | 截屏、摄像头、看视频、连看屏幕 | `winget install Gyan.FFmpeg` / `brew install ffmpeg` / 发行版包管理器 |
| Edge 或 Chrome | 自己开网页刷、收集资讯 | 装一个即可 |
| PowerShell | 知道你在刷什么（读前台窗口） | Windows 自带，一般不会缺 |

```bash
git clone <仓库地址> dsh-companion
cd dsh-companion

# 装之前先自检，它会告诉你这台机器上缺什么、缺了影响哪几个工具
node test/doctor.mjs

# 桌面端
dsh plugin --profile desktop add .

# Web 端（两套 profile 是独立的，要分别装）
dsh plugin --profile web add .
```

装完在「插件」页启用，然后到设置里填配置。

### 不用 DSH 也能用

同一个内核可以跑成 MCP server，给任何支持 MCP 的客户端接：

```bash
node adapters/mcp.mjs --list    # 看有哪些工具
node adapters/mcp.mjs           # stdio，给客户端连
```

```json
{
  "mcpServers": {
    "companion": {
      "command": "node",
      "args": ["C:/path/to/dsh-companion/adapters/mcp.mjs"]
    }
  }
}
```

记忆、权限、账本都在 `~/.dsh-companion/`，和 DSH 插件共用——在 DSH 里聊过的，换到别的客户端接上照样记得。

⚠ MCP 没有审批弹窗，所以「询问」级别的能力在那里**一律拒绝**（fail-closed）。想放开就把那项权限改成 `session` 或 `always`，见 `ADAPTERS.md`。

### 先跑这四条

```bash
node test/doctor.mjs      # 环境：能不能干活（ffmpeg / 浏览器 / PowerShell / 角色包 / 目录可写）
node test/smoke.mjs       # 功能：假 ctx 跑通全部工具、权限、记账
node test/policy.test.mjs # 策略：刷视频的四道闸、评论独立闸、跨午夜时段
node test/mcp.test.mjs    # 协议：MCP 握手 / 工具列表 / fail-closed / stdout 纯净度
```

`doctor` 只判环境，不写任何文件；它按「一项挂了不影响其他项」的方式全查一遍，
让你一次看到所有缺口，而不是修一个再发现一个。

### 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | `~/.dsh-companion/memory` | 接到已有记忆库就填绝对路径 |
| `profile` | `tender` | `tender` / `sharp` / `pro` / `casual` 四种人格 |
| `characterPack` | `packs/bigfish-classic` | 角色包目录（`dsh-pet` v1 或简单图包），见 `CHARACTER.md` |
| `characterSize` | `170` | 桌宠像素宽 |
| `pricePerMTokens` | `2` | 元 / 百万 token，按你的价目填 |
| `tokensPerBowl` | `1000` | 一碗白饭换多少 token（纯玩梗） |
| `hud` | `always` | `always` 常驻显示 / `hover` 只悬停显示 |
| `webhook` | 空 | 配了才允许直接外发消息 |

---

## token 显示在角色头上

角色头顶浮一个小药丸，三件事一起看：

```
3.4k token · ¥0.0068 · 🍚 3 碗
```

- **双击角色** → 在「常驻显示 / 只悬停显示」之间切换，同时她会把今天吃了多少说出来（「今天吃了 3 碗白饭…我是鲸鱼，能消化」）。
- 价格和白饭换算都在配置里。白饭是玩梗，但把一个抽象数字变成看得懂的量这件事本身不是梗。

**为什么要显示**：陪伴助手最贵的不是聊天，是看图。一张 1280×720 的截图约 1200 token，连看 60 帧就是 7 万——比一整天打字还贵。数字不摆在脸上，用户永远不知道自己刚才那一眼花了多少钱。

配套的三道闸：

- 单次 ≥4000 token 打 ⚠️
- 单次 >60000 token **直接拒**，并给出更省的参数（降帧率、缩宽度、裁区域）
- 每天 >200 万 token **直接拒**

---

## 记忆

插件**不调用任何 Python 脚本**，直接用正则读同一批 Markdown。这是刻意的：记忆库的价值全在「任何东西都能读懂它」。哪天脚本烂了、语言换代了，插件照样能读。

```bash
node -e "const {Memory}=require('./src/memory.js')"
```

支持的目录结构（和 `mem.py` 那套完全兼容，两边可互写）：

```
memory/
  index.md            年代目录：哪一年、多少件、几个主题
  index/<年>.md       年索引：一句话 → D编号
  raw/<日期>.md       原文：只追加，永不改写
  counter.json        下一个编号
```

---

## 形象

角色包直接吃社区的 `dsh-pet` v1 格式，所以别人做好的 `.dshpet` 丢进来就能用，不用改代码。

| 包 | 是什么 | 动作 | 体积 |
|---|---|---|---|
| 内置鲸鱼（SVG） | 手绘，兜底，随包分发 | CSS 动作 ×10 | 几 KB |
| `packs/bigfish-classic` | 大肥鱼·内置 | 60 个动作 / 6 张图集 | 4 MB |
| `packs/bigfish-adult` | 大肥鱼·成年版 | 8 组动作 / 4 张图集 | 8.8 MB |

动作不是「一个循环 GIF」：同一状态有多段可选，按「最久没播过」轮换并尊重冷却，所以看着像有人在，不像在放动画。细节和授权边界见 `CHARACTER.md`。

```bash
node client/build-preview.mjs     # 单文件预览：活角色 + 全部动作，点一个就播
```

---

## 自检

```bash
node test/doctor.mjs       # 环境：ffmpeg / 浏览器 / PowerShell / 角色包 / 目录可写
node test/smoke.mjs        # 假 ctx 跑通全部工具、权限、记账、角色包
node client/build-preview.mjs && 打开 client/preview.html   # 看形象、全部动作、十种状态
node tools/build-bigfish-pack.mjs ./package                # 从上游 dsh-bigfish 重转角色包
```

`smoke.mjs` 会验证：工具注册、权限拦截四条、fail-closed、配额封顶、超预算拒绝、记忆读写互通、审计落盘。**真机上唯一还需要验的是钩子名**——不同 DSH 版本的 `agent/session-start` 可能叫别的，代码里三个名字都试了，都不中时用 `companion_brief` 手动兜底。

---

## 已知边界

1. **摄像头要能出图，得先看系统隐私设置**。Electron 外壳本身把 `media` 权限封了（issue #655），所以这里绕过浏览器、直接从宿主调 ffmpeg（Windows 走 dshow，mac 走 avfoundation，Linux 走 v4l2）。没装 ffmpeg 时相关工具会直接说「去装 ffmpeg」，而不是报一句看不懂的 `spawn ENOENT`。
2. **发消息默认不直发**。剪贴板 → 本机客户端 → webhook，三级降级。前两级把「最后一下」留给你按，这不是保守，是这类动作发出去就收不回。
3. **钩子注入是 best-effort**。DSH 没公开完整的钩子契约，所以这里做的是「试三个名字 + 失败静默降级」，不会因为钩子对不上而把宿主弄崩。
4. **评论默认不发**。五道关里第四关是「把字打进输入框、逐字读回核对」，第五关是「确认按钮上写的是发送」。默认停在第四关，等你点头。
5. **App 里只滚不点**。抖音客户端是自绘窗口，读不到内容。看不见还发点击等于闭眼乱按，所以只发滚轮，且每次滚之前都会确认前台真是那个 App。

## 许可

**代码 MIT**（见 `LICENSE`）。

**角色美术不属于 MIT**。`packs/bigfish-classic` 是从上游 `dsh-bigfish` 转的第三方美术，版权归原作者 `gosomea`；`packs/bigfish-adult` 是 `image_gen` 生成的图。各包来源与授权写在各目录的 `NOTICE.txt` 里。

个人使用无碍。要在你自己的产品里分发，请换成你有权分发的素材——内置那只手绘鲸鱼（`svg` 模式）就是为此留的后路：把 `characterPack` 留空，插件照样有形象。
