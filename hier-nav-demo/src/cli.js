#!/usr/bin/env node
// 命令行仅用于辅助连续导航：headless 跑通分层规划、输出分块与路径状态。
// 图形入口见 docs/USAGE.md（浏览器界面的“开始远程求路”按钮）。

import { World, CHUNK_SIZE } from './world.js';
import { Simulation } from './simulation.js';

function parseArgs(argv) {
  const opts = { radius: 1, budget: 4, delay: 2, maxTicks: 500, json: false, seed: 'demo-world', cols: 5, rows: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--radius') opts.radius = Number(argv[++i]);
    else if (a === '--budget') opts.budget = Number(argv[++i]);
    else if (a === '--delay') opts.delay = Number(argv[++i]);
    else if (a === '--max-ticks') opts.maxTicks = Number(argv[++i]);
    else if (a === '--seed') opts.seed = argv[++i];
    else if (a === '--cols') opts.cols = Number(argv[++i]);
    else if (a === '--rows') opts.rows = Number(argv[++i]);
    else if (a === '--start') {
      const [x, y] = argv[++i].split(',').map(Number);
      opts.start = { x, y };
    } else if (a === '--goal') {
      const [x, y] = argv[++i].split(',').map(Number);
      opts.goal = { x, y };
    }
  }
  return opts;
}

async function runDemo(opts) {
  const world = new World({ cols: opts.cols, rows: opts.rows, seed: opts.seed });
  const sim = new Simulation(world, {
    budget: opts.budget,
    loadDelayMs: opts.delay,
    speed: 1,
  });

  // 默认：从最西侧块到最东侧块（近路位于两区域之间，会先被选中再被精细层证伪）
  let start = opts.start;
  let goal = opts.goal;
  if (!start || !goal) {
    const row = Math.floor(world.rows / 2);
    const westData = world.generateChunkData(0, row);
    const eastData = world.generateChunkData(world.cols - 1, row);
    const w = world.findOpenCell(0, row, westData.grid, opts.radius);
    const e = world.findOpenCell(world.cols - 1, row, eastData.grid, opts.radius);
    start = { x: w.lx, y: row * CHUNK_SIZE + w.ly };
    goal = { x: (world.cols - 1) * CHUNK_SIZE + e.lx, y: row * CHUNK_SIZE + e.ly };
  }

  sim.start(start.x, start.y, goal.x, goal.y, opts.radius);
  const { frames, exhausted, final } = await sim.runToEnd(opts.maxTicks);

  return { world, sim, frames, exhausted, final, shortcutPortalId: world.shortcutPortalId };
}

function printHuman(r, opts) {
  const { final } = r;
  const p = final.planner;
  console.log('=== 分层连续导航（headless 辅助验证）===');
  console.log(`世界: ${opts.cols}x${opts.rows} 块, 每块 ${CHUNK_SIZE}x${CHUNK_SIZE}, seed=${opts.seed}`);
  console.log(`角色占地半径: ${opts.radius}（占地 ${opts.radius * 2 + 1}x${opts.radius * 2 + 1}）`);
  console.log(`近路门户: ${r.shortcutPortalId}`);
  console.log(`结果: ${p.state}（粗层尝试 ${p.coarseAttempts} 次）${p.unreachableReason ? ' 原因=' + p.unreachableReason : ''}`);
  console.log(`起点 (${final.origin.wx},${final.origin.wy}) -> 目标 (${final.target.wx},${final.target.wy})，当前位置 (${final.pos.wx},${final.pos.wy})`);
  console.log('');
  console.log('粗层候选门户序列（最近一次）:');
  for (const id of p.coarseRoute.portals) {
    const mark = p.blockedPortalIds.includes(id) ? '  [精细层证伪/回溯]' : '';
    console.log(`  - ${id}${id === r.shortcutPortalId ? '  (近路)' : ''}${mark}`);
  }
  console.log('');
  console.log('分段状态:');
  const label = {
    queued: '暂未搜索',
    'awaiting-data': '缺少数据/加载中',
    confirmed: '精细已确认',
    done: '已走过',
    blocked: '明确不可达',
  };
  for (const leg of p.legs) {
    console.log(
      `  ${leg.id} [${leg.type}] ${leg.status.padEnd(13)} ${label[leg.status] ?? leg.status} ` +
      `chunk=${leg.chunk ?? '-'} portal=${leg.portalId ?? '-'} cost=${leg.fineCost ?? '-'}`,
    );
  }
  console.log('');
  console.log('分块驻留内存:');
  console.log(`  预算=${r.final.memory.budget} 块, 当前驻留=${r.final.memory.resident.length} 块, ${r.final.memory.residentBytes} 字节`);
  for (const c of r.final.memory.resident) {
    console.log(`  - ${c.key} ${c.pinned ? '(pin 角色所在)' : ''} ${c.byteSize}B`);
  }
  console.log(`  累计: 加载 ${r.final.memory.stats.loads} 次, 缓存命中 ${r.final.memory.stats.cacheHits}, 淘汰 ${r.final.memory.stats.evictions}`);
  console.log(`总 tick: ${final.tick}${r.exhausted ? '  (达到 tick 上限)' : ''}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (command && command !== 'demo') {
    console.error(`未知命令: ${command}。可用: demo, serve`);
    process.exit(1);
  }
  if (command === 'demo' || !command) {
    const r = await runDemo(opts);
    if (opts.json) {
      console.log(JSON.stringify(r.final, null, 2));
    } else {
      printHuman(r, opts);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
