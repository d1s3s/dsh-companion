# 装它：把这一页交给 Agent

**人类只做一件事**——把下面这段连同仓库地址一起丢给你的 Agent（Claude Code / Cursor / Cline / DSH / Codex，都行）：

> 帮我装这个插件：`https://github.com/d1s3s/dsh-companion`。
> 按仓库里的 `INSTALL.md` 走，装完跑一遍自检，把结果和「需要我决定的选项」一起告诉我。

剩下的它自己能读完。下面就是它要读的东西。

---

**给 Agent 的话**：照第 0 步到第 4 步顺序做，**每步都有验证命令，验证不过就停在那一步报告，不要跳过、不要猜、不要换个写法绕过去**。第 4 步有三个必须问用户的选择，不要替用户定。第 6 步是不能碰的线。

---

## 0. 先确认这台机器跑得动

```bash
node -v          # 要求 >= 20（package.json 的 engines）
git --version
```

两条都得有。**这个项目零外部依赖，不需要 `npm install`**——如果你准备跑它，方向就错了；它只用 Node 内置模块。

可选组件（缺了只掉对应能力，记忆和聊天不受影响，**不要为了凑齐而折腾用户**）：

| 组件 | 缺了会掉什么 | 装法 |
|---|---|---|
| ffmpeg | 截屏、看摄像头、看视频、连看屏幕 | `winget install Gyan.FFmpeg` / `brew install ffmpeg` / 发行版包管理器 |
| Edge 或 Chrome | 自己开网页刷、收集资讯 | 装一个就行 |
| PowerShell（仅 Windows） | 知道你在刷什么（读前台窗口） | 系统自带 |

## 1. 放代码

放**固定位置**，不要放临时目录（升级时会重新拉，路径变了 MCP 配置就断）：

```bash
git clone https://github.com/d1s3s/dsh-companion.git ~/dsh-companion
cd ~/dsh-companion
node test/doctor.mjs
```

Windows 上 `~/dsh-companion` 就是 `C:\Users\<你的用户名>\dsh-companion`。

`doctor` 会一次列出全部缺口（不是修一个报一个）。**先让它跑完，把结果念给用户听**，再决定补不补。期望形态：

```
  ✓ Node 版本                 v22.x
  ✓ ffmpeg                    ...
  ✓ 浏览器（Edge / Chrome）   ...
  ✓ 读前台窗口（PowerShell）  ...
  ✓ 角色包                    2 个（bigfish-adult, bigfish-classic）
  ✓ 配置目录可写              C:\Users\you\.dsh-companion
  ✓ 权限表自洽                21 项能力
  ✓ 外部依赖                  零依赖（只用 Node 内置模块）
  全通。
```

`doctor` 只读不写，随便跑。

## 2. 选一种接法

### A. 你在用 DSH（插件形态，有界面、有桌宠、有 token 药丸）

```bash
cd ~/dsh-companion
dsh plugin --profile desktop add .     # 桌面端
dsh plugin --profile web     add .     # Web 端（两套 profile 独立，要分别装）
```

命令不被识别就看 `dsh plugin --help`，**不同版本子命令可能不同，别照着报错重试**，先确认命令再说。

装完到「插件」页启用 → 进设置填配置。完整配置项见 `README.md` 的「配置」表。

### B. 你用的是别的客户端（MCP 形态：Claude Desktop / Cursor / Cline / Zed）

**不改代码，只加一段配置。** 先把路径换成绝对路径，然后：

```json
{
  "mcpServers": {
    "companion": {
      "command": "node",
      "args": ["C:/Users/you/dsh-companion/adapters/mcp.mjs"]
    }
  }
}
```

- Claude Desktop → `claude_desktop_config.json`
- Cursor → `~/.cursor/mcp.json`
- Cline / Continue / Zed → 各自的 MCP 配置文件，字段名一样

先验证这个 server 本身没问题：

```bash
node adapters/mcp.mjs --list     # 打印全部工具，人看
```

⚠ MCP 没有审批弹窗，所以「每次询问」级别的能力在那里**一律拒绝**（fail-closed，故意的）。这不是装坏了。想放开某一项，改 `~/.dsh-companion/permissions.json`：

```json
{ "levels": { "screen.snapshot": "session" } }
```

**默认保持拒绝是安全的，放宽必须用户自己点头。**

### C. 只是想先看看，不装

```bash
node test/smoke.mjs                    # 假宿主跑通全部工具、权限、记账
node adapters/mcp.mjs --list           # 看它到底能干什么
npm run gallery                        # 生成形象总览页 preview/gallery.html
```

## 3. 验证（装没装好，看这四条）

```bash
node test/doctor.mjs        # 环境：ffmpeg / 浏览器 / PowerShell / 角色包 / 目录可写
node test/smoke.mjs         # 功能：全部工具、权限、记账
node test/policy.test.mjs   # 策略：刷视频四道闸、评论独立闸、跨午夜时段
node test/mcp.test.mjs      # 协议：MCP 握手 / 工具表 / fail-closed / stdout 纯净
```

四条全绿才算装好。**任何一条红了，把原始输出原样贴给用户，不要自己改代码绕过。**

## 4. 装完必须问用户的三件事

**不要替他决定，不要用默认值糊过去。**

| # | 问题 | 可选项 | 默认 |
|---|---|---|---|
| 1 | 用什么人格 | `tender` 温柔 / `sharp` 直接 / `pro` 干活 / `casual` 随便聊 | `tender` |
| 2 | 用什么形象 | 内置手绘鲸鱼（零素材）/ `bigfish-classic`（60 动作）/ `bigfish-adult`（8 组）/ 自己的 dsh-pet 包 | `bigfish-classic` |
| 3 | token 怎么算钱 | 每百万 token 多少元（用来显示"今天花了多少"和"吃了几碗白饭"） | `2` |

顺带确认两件**默认关着**的事（别自作主张开）：

- **自己刷视频**：`browse.enabled` 出厂 `false`，要用户明确说开才开，且时段/时长/间隔要一起定
- **评论发送**：`comment.enabled` 出厂 `false`，和"能刷"是**两套独立开关**；`requireApproval` 不要关

配完重启客户端，或让用户新开一个会话。

## 5. 故障对照

| 现象 | 真实原因 | 怎么办 |
|---|---|---|
| `doctor` 报 ffmpeg 缺失 | 没装或不在 PATH | 装 ffmpeg；不会自动兜底成 `ffmpeg` 这个假命令，会明确报 `NO_FFMPEG` |
| 浏览器那项空着 | 没装 Edge/Chrome，或装在非标准路径 | 装一个；路径按 `Program Files` / `homedir` 自动探测，装在很奇怪的位置会读不到 |
| 装了但没生效 | `cordis.patch.yml` 里 `name` 和目标行对不上，加载器只警告不报错 | 看启动日志里有没有 warn，对 `name` |
| 角色包读不了 | 路径写错 / 包缺 `pet.json` | 会自动回退到内置鲸鱼，不会崩；先让用户看到提示再修路径 |
| MCP 连不上 | `args` 里写了相对路径，或 Node < 20 | 换成绝对路径；升 Node |
| MCP 里工具"没权限" | 正常，fail-closed | 见 2.B，改 `permissions.json` 里那一项 |
| 刷视频不动 | 四道闸任一不合（总开关/时段/单次/每日+间隔） | 用 `companion_browse_settings` 看是哪道闸拦的，别直接改配置 |
| 换了模型，她不记得之前 | 记忆目录不一致 | 确认两次都指向同一个 `~/.dsh-companion/memory` |

## 6. 红线（别做）

- **不要 `sudo` / 管理员权限**。它只写自己的 `~/.dsh-companion/`。
- **不要 `npm install`**。零依赖是设计，不是偷懒。
- **不要动用户自己的 Edge / Chrome 配置**。刷视频用独立 profile `~/.dsh-companion/browser`，第一次要在那个窗口里扫码登录一次。
- **不要往仓库里塞 API key**。密钥只进 `~/.dsh-companion/keys.json`（权限 600）或环境变量。
- **不要替用户打开「自己刷视频」和「评论发送」**，也不要关 `requireApproval`。
- **不要为了通过测试去改 `test/` 里的断言**。红了就是真有问题。

---

## 装完之后，日常怎么用

不用记工具名，**跟它说话就行**：

| 你说 | 它做 |
|---|---|
| 「记住我这个项目用 pnpm 不用 npm」 | 写进长期记忆，带权重，下次自动想起 |
| 「我昨天说的那个方案叫什么来着」 | 模糊回忆 → 命中后给出细节，不是关键词硬匹配 |
| 「我这半天在忙什么」 | 读前台窗口，约 0 token（不截图） |
| 「帮我看看 B 站现在火的 AI 视频」 | 开独立浏览器刷、读标题作者、按播放排序 |
| 「刷到好的记下来，回头跟我聊」 | 进记忆库，以后能主动提 |
| 「这条视频在讲啥」 | 抽帧 + 用你自己的模型（OpenAI/Claude/千问/DeepSeek）判断 |
| 「这条评论你觉得该怎么回」 | 只出草稿，**不发送**；你点头才发 |
| 「今天花了多少钱 / 吃了几碗白饭」 | 账本按上游真实 token 报数，显示在角色头上（双击切换常驻） |
| 「换成青绿那个样子」 | 立刻换皮肤，不用重启 |
| 「换成大肥鱼成年版」 | 换角色包，同样立刻生效 |

人格、形象、记忆、账本全都存在 `~/.dsh-companion/` 里——**换模型、换客户端，这些都不重来**。

细节文档：`README.md`（机制与权限）、`ADAPTERS.md`（换宿主 / 换模型）、`CHARACTER.md`（角色包格式）、`BROWSING.md`（刷视频细节）、`PERMISSIONS.md`（21 项能力逐条说明）。
