# AGENTS.md

给任何在这个仓库里干活的 Agent 看的。人也可以读，但它是写给机器的。

## 这是什么

一个陪伴型插件。**内核不认识 DSH**——`buildCompanion(host, config)` 只依赖五个宿主方法：
`register` / `emit` / `log` / `warn` / `on`。所以同一套记忆、权限、账本、人格，能跑在
DSH 插件里，也能跑成 MCP server 给 Claude Desktop / Cursor / Cline / Zed 用。

安装步骤在 `INSTALL.md`。要改代码，先读完这一页。

## 怎么跑

```bash
node test/doctor.mjs        # 环境自检，只读不写
node test/smoke.mjs         # 假宿主跑通全部工具
node test/policy.test.mjs   # 权限闸与时段策略
node test/mcp.test.mjs      # MCP 协议 + stdout 纯净度
node adapters/mcp.mjs --list   # 看 25 个工具
npm run gallery             # 生成形象总览页
```

零外部依赖，**不要 `npm install`**。

## 结构

```
src/companion.js    核心：25 个工具的业务逻辑。不认识任何客户端。
src/host.js         宿主适配器。把不同客户端翻译成同一组五个方法。
src/index.js        DSH 入口，20 行薄壳。
adapters/mcp.mjs    MCP 入口，手写 stdio JSON-RPC，零依赖。
client/client.cjs   浏览器端：形象渲染、CSS 动画、四套配色。
src/browse-*.js     刷视频：四道闸、CDP 直连、评论独立闸。
```

## 不变量（改了就等于换了个项目）

1. **记忆永存在模型之外。** 换模型只是换嗓子；绝不靠微调存事实，否则换模型＝失忆。
   所以记忆是磁盘上人可读的 Markdown，在 `~/.dsh-companion/memory`。
2. **核心不碰宿主 API。** 只能在 `src/host.js` 里调用具体客户端。如果发现必须改核心才能适配
   新宿主，说明有东西漏在核心外面了，那才是 bug。
3. **权限 fail-closed。** 宿主没有审批通道时（MCP、无头脚本），「每次询问」级别一律拒绝。
   这是设计不是缺陷，不要为了"能跑通"改成默认放行。
4. **记账用上游回报的真实 token**，不估算、不按字数猜。
5. **stdout 是协议通道。** MCP 下 stdout 只能有 JSON-RPC，一行 `console.log` 就能弄坏协议；
   日志一律走 `host.log` → stderr。
6. **形象可运行时换，不重启。** 换形象只推一个 `character` 事件 + 写 `~/.dsh-companion/character.json`，
   绝不去改用户的配置文件。

## 别做

- 不要改 `test/` 里的断言让测试变绿。红了就是真有问题。
- 不要 `sudo` / 管理员权限；它只写自己的 `~/.dsh-companion/`。
- 不要动用户自己的 Edge / Chrome 配置；刷视频用独立 profile `~/.dsh-companion/browser`。
- 不要把 API key 写进代码、日志、提交里；只进 `keys.json`（600）或环境变量。
- 不要替用户打开「自己刷视频」和「评论发送」，也不要关 `requireApproval`。
- 不要给 `findFfmpeg()` 之类的探测函数加"兜底返回值"——兜底值长得像成功的时候，
  故障会转移到更难查的地方（这个坑踩过一次：返回 `'ffmpeg'` 导致 `spawn ENOENT`）。

## 文档地图

| 文件 | 讲什么 |
|---|---|
| `README.md` | 是什么、能做什么、配置项、机制 |
| `INSTALL.md` | 怎么装（写给 Agent 执行） |
| `ADAPTERS.md` | 换宿主 / 换模型 / 写新适配器 |
| `PERMISSIONS.md` | 21 项能力逐条说明 |
| `CHARACTER.md` | 角色包格式（dsh-pet v1）与自制方法 |
| `BROWSING.md` | 刷视频：四道闸、成本阶梯、平台差异 |
| `LICENSE` | 代码 MIT；`packs/` 里的角色美术不适用 MIT |
