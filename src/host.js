/**
 * host.js —— 「谁在跑我」的唯一接触面
 *
 * 核心（companion.js）只认五个方法。这个文件负责把不同客户端翻译成那五个方法：
 *
 *   dshHost(ctx)      DSH 插件宿主。有界面挂载点，能推形象事件。
 *   mcpHost(opts)     MCP 客户端（Claude Desktop / Cursor / Cline / DSH …）。
 *                     一份 server，任何支持 MCP 的客户端都能接——这是「适配其它 Agent」
 *                     的真正含义：不重写工具，只换传输。
 *   headlessHost()    没有界面的宿主（测试、脚本、无人值守）。工具照常注册，
 *                     事件收进数组，方便断言。
 *
 * 三者的差异只有三件事：怎么注册工具、怎么把状态推给人、有没有钩子。
 * 把这三点抽出来之后，核心代码一行都不用为宿主改。
 */

/* ------------------------------------------------------------------ */
/* DSH                                                                  */
/* ------------------------------------------------------------------ */

/**
 * DSH 的 ctx 长这样：tools.register / emit / logger.{info,warn} / on。
 * 注意 DSH 是「先声明 inject 再用」——所以在 index.js 里必须 export inject = ['tools']。
 */
export function dshHost(ctx) {
  if (!ctx) throw new Error('dshHost 需要 ctx');
  return {
    kind: 'dsh',
    register(spec) { ctx.tools?.register?.(spec); },
    emit(ev, data) { try { ctx.emit?.(ev, data); } catch { /* 没界面就算了 */ } },
    log(msg) { ctx.logger?.info?.(msg); },
    warn(msg) { ctx.logger?.warn?.(msg); },
    on(name, fn) {
      if (typeof ctx.on !== 'function') return false;
      try { ctx.on(name, fn); return true; } catch { return false; }
    },
  };
}

/* ------------------------------------------------------------------ */
/* MCP                                                                  */
/* ------------------------------------------------------------------ */

/**
 * MCP 宿主。
 *
 * 三处必须记住的约束：
 *   1. stdio 传输下 **stdout 只能放 JSON-RPC**。任何 console.log 都会把协议弄坏，
 *      所以这里所有日志一律走 stderr。
 *   2. MCP 没有自定义事件通道。形象要显示的那些事件（usage / character）被收进
 *      state.latest，再由 companion_state 工具读出来——客户端自己决定怎么画。
 *   3. MCP 没有钩子。所以「跟着 Agent 状态换动作」这条在 MCP 下是关的，
 *      核心会降级成「按调用推状态」，这是设计好的退路，不是坏了。
 *
 * @param {object} opts
 * @param {(spec:object)=>void} opts.register  把工具收进 tools 表
 * @param {(level:string,msg:string)=>void} [opts.logSink]
 */
export function mcpHost({ register, logSink } = {}) {
  const latest = {};
  const events = [];
  const Log = (level, msg) => {
    const line = `[companion] ${msg}`;
    if (logSink) { try { logSink(level, line); return; } catch { /* 落回 stderr */ } }
    process.stderr.write(line + '\n');
  };

  return {
    kind: 'mcp',
    /** 客户端要读就得能拿到，所以挂在自己身上 */
    state: { latest, events },
    register(spec) { register?.(spec); },
    emit(ev, data) {
      // session/event 的 kind 就是状态名（usage / character / state）
      latest[data?.kind || ev] = data;
      latest.at = Date.now();
      events.push({ ev, data, at: Date.now() });
      if (events.length > 200) events.splice(0, events.length - 200);
    },
    log: (m) => Log('info', m),
    warn: (m) => Log('warn', m),
    /** 没有钩子。老实返回 false，让核心知道要走降级路径。 */
    on() { return false; },
  };
}

/* ------------------------------------------------------------------ */
/* 无头（测试 / 脚本）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 给测试用：什么都不输出，但把注册过的工具和发过的事件都留着，
 * 好让断言能看见。这也顺便证明了「核心真的不依赖 DSH」——
 * 一个假的 host 就够它跑完全部工具。
 */
export function headlessHost() {
  const tools = new Map();
  const events = [];
  const logs = [];
  const hooks = [];
  return {
    kind: 'headless',
    tools,
    events,
    logs,
    hooks,
    state: { latest: {}, events },
    register(spec) { if (spec?.name) tools.set(spec.name, spec); },
    emit(ev, data) {
      events.push({ ev, data });
      this.state.latest[data?.kind || ev] = data;
    },
    log(m) { logs.push(['info', m]); },
    warn(m) { logs.push(['warn', m]); },
    on(name, fn) { hooks.push({ name, fn }); return true; },
  };
}
