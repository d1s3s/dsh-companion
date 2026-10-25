# 换宿主 / 换形象

两件事分开看：

- **换形象**是换「她长什么样」——一条命令，立刻生效。
- **换宿主**是换「谁在跑她」——记忆、权限、人格、账本都不动，只换外壳。

后者是这个插件和普通桌宠最大的区别：**核心不知道自己是 DSH 插件**。

---

## 一、换形象

### 现在就能换，不用重启

```bash
# 看有哪些
companion_character action=list

  大肥鱼 · 成年版       bigfish-adult       8 个动作   8.8 MB  自带
  大肥鱼 · 内置         bigfish-classic     60 个动作  4 MB    自带  ← 当前

# 换
companion_character action=use pack=bigfish-adult

# 回到配置里的默认
companion_character action=use reset=true
```

切换会做三件事：重新读图集 → 推一个 `character` 事件给前端（`applyArt` 就地换图，不用重开会话）→ 写进 `~/.dsh-companion/character.json`，下次启动还是这个。

**为什么单独存一个文件而不改你的配置**：配置文件是你的，插件不该悄悄动它。`character.json` 是它的运行时状态，删掉就等于回到配置里的默认值。

### 放自己的形象

```bash
mkdir -p ~/.dsh-companion/packs
# 把 dsh-pet 包解开丢进去，或者：
node tools/import-pack.mjs "C:\Users\你\.dsh\plugins\某个桌宠" --name 你的名字
```

`~/.dsh-companion/packs/` 优先于插件自带的 `packs/`——你自己放的不该被插件升级覆盖。

### 包格式

吃社区的 `dsh-pet` v1，不自己发明：

```
pet.json            # 画布、图集清单、fallbacks
animations.json     # id / label / tags / frames[rect, durationMs]
dialogue.json       # 台词（可选）
assets/*.png        # 图集
```

所以别人做好的 `.dshpet` 直接能放进来，不用转格式。细节见 `CHARACTER.md`。

---

## 二、换宿主

### 为什么这么设计

陪伴的价值不在「哪个 Agent 能调截屏」，而在**记住你、知道分寸、说人话**。换模型、换客户端都不该让这些重来一遍。

所以代码分成三层：

```
src/companion.js    核心。23 个工具的业务逻辑，不认识任何客户端。
src/host.js         宿主适配器。把不同客户端翻译成同一组五个方法。
src/index.js        DSH 入口。薄薄一层，只有 20 行。
adapters/mcp.mjs    MCP 入口。stdio JSON-RPC，零依赖。
```

核心只认这五个方法：

| 方法 | 干什么 | MCP 下 |
|---|---|---|
| `host.register(spec)` | 注册一个工具 | 收进 tools 表 |
| `host.emit(ev, data)` | 往界面推状态 | 没有事件通道 → 收进 `state.latest` |
| `host.log(msg)` | 普通日志 | 走 **stderr** |
| `host.warn(msg)` | 警告 | 走 **stderr** |
| `host.on(name, fn)` | 挂钩子 | 没有钩子 → 返回 `false`，核心降级 |

### MCP：一份 server，所有客户端都能接

这是「适配其它 Agent」最省力的做法。MCP 是现在 Agent 世界的通用插座，Claude Desktop、Cursor、Cline、Continue、Zed、DSH 都认它。

```bash
node adapters/mcp.mjs --list      # 人看：有哪些工具
node adapters/mcp.mjs             # 机器用：stdio，给客户端连
```

客户端配置（以 Claude Desktop 的 `claude_desktop_config.json` 为例）：

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

Cursor / Cline 之类换成它们各自的 MCP 配置文件，字段一样。

**记忆是同一个**：MCP 下默认读 `~/.dsh-companion/`，和 DSH 插件共用一套记忆、权限、账本。所以你在 DSH 里跟她聊过的，换到 Claude Desktop 里接上，她照样记得——这正是「记忆必须外置」的意义。

### MCP 下的两个硬约束

**1. stdio 下 stdout 只能放 JSON-RPC。**

一行 `console.log` 就能把整个协议弄坏，而且客户端报的是「连接失败」，没人会想到是打印干的。所以 `host.log` 走 stderr，`test/mcp.test.mjs` 里有一项专门验证「stdout 每一行都是合法 JSON」。

**2. 没有审批弹窗，所以「询问」级别的能力一律拒绝。**

这是 **fail-closed**，故意的。MCP 没有 DSH 那样的 `approval.request`，如果因为「没人能问我」就默认放行，等于把权限模型拆了。

想让某个能力在 MCP 下可用，两种办法：

```json
// ~/.dsh-companion/permissions.json
{ "levels": { "screen.snapshot": "session" } }
```

或者用 `companion_permission action=set` 改成 `session` / `always`。**默认保持 deny 是安全的，放宽要显式做。**

### 写新的宿主适配器

照 `src/host.js` 里的模板，实现那五个方法就行：

```js
export function myHost(client) {
  return {
    kind: 'mine',
    register(spec) { client.addTool(spec); },
    emit(ev, data) { client.push(data); },
    log(m) { client.debug(m); },
    warn(m) { client.warn(m); },
    on() { return false; },     // 没钩子就老实返回 false
  };
}
```

然后：

```js
import { buildCompanion } from '../src/companion.js';
const core = buildCompanion(myHost(client), { home, characterPack, profile });
```

`buildCompanion` 返回 `{ pm, mem, gate, ledger, browse, browser, character, host }`，需要查账本或记忆时直接摸。

**不用改核心一行。** 如果发现必须改，说明有东西漏在核心外面了，那才是 bug。

### 各宿主能力对照

| 能力 | DSH | MCP | 无头（脚本/测试） |
|---|---|---|---|
| 23 个工具 | ✅ | ✅ | ✅ |
| 记忆 / 权限 / 账本 | ✅ | ✅ | ✅ |
| 形象显示 | ✅ 挂在界面上 | ⚠ 只能文字（`companion_character`） | — |
| token 药丸 | ✅ | ⚠ 靠 `state.latest.usage` | — |
| 跟着 Agent 状态换动作 | ✅ 钩子 | ❌ 没有钩子，按调用推 | ❌ |
| 权限「询问」 | ✅ 弹窗，一次一授权 | ❌ **fail-closed 拒绝** | ❌ 默认拒绝 |

表里的 ⚠ 和 ❌ 不是缺陷，是宿主没有那个位置。核心会自己降级，不会崩。

---

## 三、换模型

这一层有两件事，别混：

**1. 宿主换模型 —— 不需要做任何事**

因为记忆不在模型里。

```bash
companion_recall keywords="项目 决定"     # 换模型前，记忆在磁盘上，人可读的 Markdown
# 换模型后，同一条命令，同一批结果
```

`AGENTS.md` 那条不变量就是为这个写的：**记忆永存在模型之外。换模型只是换嗓子；绝不靠微调存事实，否则换模型＝失忆。**

人格（`tender` / `sharp` / `pro` / `casual`）是加权方式，不是模型参数——所以换模型后性格仍在，只是说话方式跟着新模型走。

**2. 她自己去问模型 —— 要配 API**

有几件事不能等宿主调她：刷完一堆视频要判断哪条值得留、评论草稿要说人话、看了一帧要猜你在干嘛。以前这些靠硬编码关键词，效果一眼假。

```bash
companion_model_key provider=qwen key=sk-xxxx    # 配一个
companion_model action=status                    # 看哪些配好了
companion_model input="这条在讲什么：…"          # 用一次
```

| provider | 端点 | 认证 | 国内直连 |
|---|---|---|---|
| `qwen` | `dashscope.aliyuncs.com/compatible-mode/v1` | `Bearer` | ✅ |
| `deepseek` | `api.deepseek.com/v1` | `Bearer` | ✅ |
| `openai` | `api.openai.com/v1` | `Bearer` | ⚠ 需代理 |
| `anthropic` | `api.anthropic.com/v1` | `x-api-key` + `anthropic-version` | ⚠ 大陆 IP 403 |

三家的形状差异只有两处，代码里用一个 `style` 字段就收住了：

- **Anthropic** 的 `system` 是顶层字段（不在 `messages` 里），而且 `anthropic-version` 头不能少——少了直接 400，报错还不说原因。
- 另外三家的 `usage` 字段名不同（`prompt_tokens` vs `input_tokens`），token 数和钱按各家自己的报数记账。

自定义端点（走代理、企业网关）：设 `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` / `DASHSCOPE_BASE_URL` / `DEEPSEEK_BASE_URL`，代码里不写死任何地址。

**密钥安全**：只存 `~/.dsh-companion/keys.json`（权限 600），或者走环境变量。不进代码、不进日志、回显时一律打码（`sk-abc1…f9e2`）。

**权限独立**：`model.ask` 是单独一项，和 `network` 分开——因为这一项**真的会产生账单**，每小时封顶 60 次，循环调用在这里被挡住。
