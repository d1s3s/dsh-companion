/**
 * import-pack.mjs —— 把本机已装的角色包导进陪伴助手
 *
 * 为什么要有这一步，而不是直接把图放进插件里：
 * 那些形象的代码是 MIT，但角色美术是单独授权的。你在自己机器上用它完全没问题，
 * 但一旦被打进插件分发包，性质就变了。所以做成「你本机导入」——插件显示的就是那个形象，
 * 而分发出去的那个空壳里不含任何别人的素材。
 *
 * 用法：
 *   node tools/import-pack.mjs <装了桌宠插件的目录> [--name 名字] [--out 输出目录]
 *   node tools/import-pack.mjs --list <目录>      只看看找到什么，不写文件
 *
 * 它会扫图片、按文件名猜状态、生成 pack.json。猜错了就手改那个 json，不用重导。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = new Set(['.png', '.webp', '.gif', '.jpg', '.jpeg', '.avif']);

/** 文件名关键词 → 状态。中英都认，顺序从具体到宽泛。 */
const RULES = [
  ['sleep', ['sleep', 'doze', 'zzz', '睡']],
  ['error', ['error', 'fail', 'sad', 'cry', '报错', '错', '难过']],
  ['done', ['done', 'finish', 'complete', 'success', '完成', '搞定']],
  ['wait', ['wait', 'confirm', 'ask', 'approval', '等待', '确认']],
  ['type', ['type', 'typing', 'write', 'read', '打字', '写']],
  ['tool', ['tool', 'work', 'working', 'busy', 'exec', '工具', '干活']],
  ['think', ['think', 'thinking', 'ponder', '思考', '想']],
  ['happy', ['happy', 'cheer', 'joy', 'laugh', 'wave', '开心', '笑', '欢呼']],
  ['idle', ['idle', 'stand', 'default', 'rest', '待机', '休息', '默认']],
];

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'src'].includes(it.name)) continue;
      walk(full, out, depth + 1);
    } else if (EXT.has(path.extname(it.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function classify(file) {
  const base = path.basename(file, path.extname(file)).toLowerCase();
  for (const [state, keys] of RULES) {
    if (keys.some((k) => base.includes(k))) return state;
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    console.log('用法: node tools/import-pack.mjs <目录> [--name 名字] [--out 输出目录] [--list]');
    return 1;
  }
  // 老实解析：flag 吃掉后面一个值，其余算位置参数。
  // 之前那套 indexOf('--')+1 的花招会把 --out 的值当成目录名。
  const flags = { name: null, out: null, list: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') { flags.list = true; continue; }
    if (a === '--name') { flags.name = argv[++i]; continue; }
    if (a === '--out') { flags.out = argv[++i]; continue; }
    if (!a.startsWith('--')) positional.push(a);
  }
  const src = positional[0];
  const listOnly = flags.list;
  const get = (k) => flags[k];
  if (!src || !fs.existsSync(src)) {
    console.error('目录不存在：' + (src || '(没给)'));
    return 1;
  }

  const files = walk(src);
  if (!files.length) {
    console.error('这个目录里没找到图片。桌宠插件的图可能在 assets/、public/ 或 dist/ 下，换目录再试。');
    return 1;
  }

  const byState = new Map();
  for (const f of files) {
    const s = classify(f);
    if (!s) continue;
    // 同一状态取名字最短的那个，通常是最干净的一张
    const prev = byState.get(s);
    if (!prev || path.basename(f).length < path.basename(prev).length) byState.set(s, f);
  }

  const name = get('name') || path.basename(path.resolve(src));
  console.log(`扫描 ${src}`);
  console.log(`  图片 ${files.length} 张，认出状态 ${byState.size} 个`);
  for (const [s, f] of byState) console.log(`    ${s.padEnd(6)} ← ${path.relative(src, f)}`);
  const unknown = files.filter((f) => !classify(f));
  if (unknown.length) {
    console.log(`  没能分类 ${unknown.length} 张（多半是图标/背景，不影响）`);
  }

  const base = byState.get('idle') || files[0];
  const outDir = get('out') || path.join(os.homedir(), '.dsh-companion', 'packs', name);
  const pack = {
    name,
    author: '',
    license: '',
    note: '本机导入，仅自己用。对外分发前请换掉或在 license 里写清授权。',
    art: {
      mode: 'image',
      base: 'base' + path.extname(base).toLowerCase(),
      states: {},
    },
  };

  if (listOnly) {
    console.log('\n（--list 模式，没写文件）');
    return 0;
  }

  fs.mkdirSync(path.join(outDir, 'art'), { recursive: true });
  fs.copyFileSync(base, path.join(outDir, 'art', pack.art.base));
  for (const [s, f] of byState) {
    const dst = s + path.extname(f).toLowerCase();
    fs.copyFileSync(f, path.join(outDir, 'art', dst));
    pack.art.states[s] = dst;
  }
  fs.writeFileSync(path.join(outDir, 'pack.json'), JSON.stringify(pack, null, 2), 'utf8');

  console.log(`\n已生成 ${path.join(outDir, 'pack.json')}`);
  console.log('底图 ' + pack.art.base + '，' + Object.keys(pack.art.states).length + ' 个状态图');
  console.log('\n在插件配置里指向它：');
  console.log(`  characterPack: ${outDir}`);
  console.log('猜错了状态就手改 pack.json 里的 states，不用重导。');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}

export { classify, walk };
