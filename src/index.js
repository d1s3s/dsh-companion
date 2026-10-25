/**
 * index.js —— DSH 插件入口
 *
 * 契约（依据 DSH 公开文档）：导出 name + apply(ctx, config)，可选 inject。
 * 所有能力都通过 ctx 注册，插件卸载时自动回收，不需要手写 dispose。
 *
 * 这个文件**故意很薄**。真正的东西在 companion.js，它不知道 DSH 的存在。
 * 换宿主（MCP / 别的 Agent）时，写一个 host 适配器就行，核心一行不用改——
 * 因为「记住你、知道分寸、说人话」不该绑在某一个客户端上。
 */

import { buildCompanion } from './companion.js';
import { dshHost } from './host.js';

export const name = 'dsh-companion';

/** 声明依赖：不声明就访问不到 ctx.tools —— DSH 是「先声明再用」 */
export const inject = ['tools'];

export function apply(ctx, config = {}) {
  return buildCompanion(dshHost(ctx), config);
}

/** 让测试和外部脚本能直接跑核心，不必伪造一个 DSH ctx */
export { buildCompanion } from './companion.js';
export { dshHost, mcpHost, headlessHost } from './host.js';
