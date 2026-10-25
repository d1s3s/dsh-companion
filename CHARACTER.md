# 角色形象

## 三种模式

| 模式 | 用什么 | 什么时候 |
|---|---|---|
| `svg` | 插件内置的鲸鱼，手写 SVG | 兜底。没装角色包时一定有东西在 |
| `image` | 简单图包，一个状态一张图 | 角色只有几张静态图时 |
| `atlas` | **dsh-pet v1 角色包**（社区通用格式） | 主流。大肥鱼就是这个，60 个动作逐帧播 |

内置那只只是占位，几 KB，随插件走。真正的形象靠角色包。

## 为什么不自己发明格式

社区的 `.dshpet` 已经把「素材 + 帧序 + 每帧时长 + 台词 + 状态标签」定义清楚了。跟它对齐的好处是**免费继承所有人已经做好的角色**：别人做的包丢进来就能用，不用改插件代码，也不用我替他们转格式。

所以本插件原生吃 `dsh-pet` v1：

```
pet.json            # 画布、图集清单、fallbacks
animations.json     # 动作表：id / label / tags / frames[rect, durationMs]
dialogue.json       # 台词（可选）
assets/*.png        # 图集（精灵表）
```

```json
{
  "format": "dsh-pet",
  "formatVersion": 1,
  "canvas": { "width": 222, "height": 222 },
  "assets": { "classic": { "path": "assets/classic.png", "width": 724, "height": 543 } },
  "fallbacks": { "idle": "bigfish:rest-calm" }
}
```

```json
[{ "id": "bigfish:thinking", "label": "书桌·想一想",
   "tags": ["reasoning", "thinking"], "loop": true, "cooldownMs": 4000,
   "frames": [{ "asset": "quiet", "rect": [0, 0, 222, 222], "durationMs": 333 }] }]
```

## 自带两个角色包

两个包的**来源不同**，用之前请分清：

| 包 | 来源 | 说明 |
|---|---|---|
| `bigfish-classic` 大肥鱼·内置 | 从 npm 包 `dsh-bigfish@0.6.0` 转换 | 第三方美术，版权归上游作者 `gosomea`。60 个动作、6 张图集，含上游 160 句台词 |
| `bigfish-adult` 大肥鱼·成年版 | 由 `image_gen` 工具生成（2026-09-17） | 基于用户提供的原始蓝鲸女仆形象重绘，8 组动作、4 张图集 |

图集在转换时按 0.5 倍降采样：444px → 222px，体积从 12.5 MB 掉到 4 MB，而角色实际只显示 170px 上下，肉眼看不出差别。

```yaml
characterPack: packs/bigfish-classic   # 相对插件目录，也可以写绝对路径
characterSize: 170
```

| 包 | 动作 | 图集 | 画布 |
|---|---|---|---|
| `bigfish-classic` 大肥鱼·内置 | 60 | 6 张 | 222×222 |
| `bigfish-adult` 大肥鱼·成年版 | 8 | 4 张 | 372×512 |

只重转 classic（换倍率、换上游版本）：

```bash
# 1. 拿到上游包
npm pack dsh-bigfish && tar -xzf dsh-bigfish-*.tgz

# 2. 转成本插件吃的格式（--scale 1 保留原分辨率）
node tools/build-bigfish-pack.mjs ./package --scale 0.5
```

## 换成别的角色

### 运行时切换（不用重启）

```bash
companion_character action=list                    # 看有哪些，带 ← 当前
companion_character action=use pack=bigfish-adult  # 换，立刻生效
companion_character action=use reset=true          # 回到配置里的默认
```

切换会重新读图集、推一个 `character` 事件给前端就地换图、并记进 `~/.dsh-companion/character.json`。下次启动还是这个。

**不改你的配置文件**：配置文件是你的，插件不该悄悄动它。`character.json` 是它的运行时状态，删掉就回到默认。

`~/.dsh-companion/packs/` 优先于插件自带的 `packs/`——你自己放的不该被插件升级覆盖。

### 放一个自己的包

任何 `.dshpet` / 兼容 ZIP 解开后放进上面任一个 `packs/`，`action=list` 就能看到。

只有一堆散图、没有动画表的老式桌宠目录，用导入工具扫一遍，它会按文件名猜状态：

```bash
node tools/import-pack.mjs "C:\Users\你\.dsh\plugins\dsh-pet-dafeiyu" --list   # 先看
node tools/import-pack.mjs "C:\Users\你\.dsh\plugins\dsh-pet-dafeiyu" --name 大肥鱼
```

## 十种状态 → 动作标签

状态名照样是 Agent 的真实生命周期，映射走 `dsh-pet` 的通用标签，所以别人的包也能对上：

| 状态 | 找哪些标签 | 说明 |
|---|---|---|
| `idle` | `idle` | 待着 |
| `greet` | `greeting` | 开场打招呼 |
| `think` | `thinking` | 思考中 |
| `type` | `writing` / `working` | 输出文字 |
| `tool` | `tool` / `working` | 调工具 |
| `wait` | `wait` / `attention` | 等你确认 |
| `done` | `success` | 完成 |
| `error` | `error` | 出错 |
| `sleep` | `idle` | 闲置 10 分钟 |
| `happy` | `success` / `greeting` | 被点、被鼓励 |

同一状态有好几段可选时**按「最久没播过」轮换**，并尊重每段的 `cooldownMs`——
不然大肥鱼会一直重复同一个呼吸动作，看着像卡住了。这也是「有人在」和「一个循环 GIF」的区别。

闲置 3 分钟自己变淡，10 分钟睡着。**陪伴助手最容易变成屏幕上的噪音**，所以「不动就退场」是默认行为。`prefers-reduced-motion` 全停。

## 预览

```bash
node client/build-preview.mjs                      # 默认看 bigfish-classic
node client/build-preview.mjs packs/bigfish-adult  # 看别的包
# 然后打开 client/preview.html
```

单文件、双击就开（源码与图集全内联，不依赖本地服务器）。左边是活的角色，右边是全部动作，点一个就播。
排障时可以带 hash 直接定位：`preview.html#tool`、`preview.html#anim:bigfish:workshop-repair`。

## token 显示

头顶那个药丸是角色的一部分：

```
3.4k token · ¥0.0068 · 🍚 3 碗
```

- 悬停显示；`hud: always` 常驻
- **双击角色**切换常驻 / 只悬停，并让角色把今天吃了多少说出来
- 价格按 `pricePerMTokens`，白饭按 `tokensPerBowl`

「吃了多少白饭」是玩梗，但把一个抽象数字变成一个能感知的量，这件事本身不是梗——不然没人会看一眼自己今天烧了多少钱。

## 授权

角色美术**不是 MIT**。上游 `dsh-bigfish` 的 NOTICE 写得很清楚：代码 MIT，角色与标志单独授权，
原始参考图作者未确认，代码许可不代表对第三方角色权利的授权。

所以：自己机器上用、自己看，没问题；要对外分发插件，就把 `packs/` 换成你有权分发的素材
（内置那只鲸鱼就是为此存在的），或者分发时干脆不带 `packs/`，让用户自己放。
