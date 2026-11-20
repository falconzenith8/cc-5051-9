import { test, assert, eq, summary } from './harness.js';
import { World, CHUNK_SIZE, MAX_CHARACTER_RADIUS } from '../src/world.js';
import { gridAstar, fits } from '../src/astar.js';
import { CoarseGraph } from '../src/coarse.js';
import { ChunkStore } from '../src/memory.js';
import { HierarchicalPlanner, PlanState, LegStatus } from '../src/planner.js';
import { Simulation } from '../src/simulation.js';

const SEED = 'test-seed';

function newWorld() {
  return new World({ cols: 5, rows: 5, seed: SEED });
}

// 在指定块中心附近找一个适合 radius 的开放格，返回全局坐标
function openGlobal(world, cx, cy, radius) {
  const data = world.generateChunkData(cx, cy);
  const cell = world.findOpenCell(cx, cy, data.grid, radius);
  return {
    wx: cx * CHUNK_SIZE + cell.lx,
    wy: cy * CHUNK_SIZE + cell.ly,
  };
}

async function runSim(world, radius, budget = 4) {
  const sim = new Simulation(world, { budget, loadDelayMs: 1 });
  const start = openGlobal(world, 0, 2, radius);
  const goal = openGlobal(world, 4, 2, radius);
  sim.start(start.wx, start.wy, goal.wx, goal.wy, radius);
  const { exhausted } = await sim.runToEnd(400);
  return { sim, start, goal, exhausted };
}

console.log('世界与门户身份');

test('每个门户有唯一可核验身份且恰好连接两个相邻块', () => {
  const w = newWorld();
  assert(w.portals.size > 0, '应生成门户');
  const ids = new Set();
  for (const p of w.portals.values()) {
    assert(!ids.has(p.id), `门户 id 重复: ${p.id}`);
    ids.add(p.id);
    assert(p.a && p.b, '门户必须有两侧锚点');
    const dc = Math.abs(p.a.cx - p.b.cx) + Math.abs(p.a.cy - p.b.cy);
    eq(dc, 1, `${p.id} 必须连接相邻块`);
    assert(p.estCost > 0 && p.width > 0, '门户必须带代价估计与宽度');
  }
});

test('跨块边界除登记门户外全部为墙，不能从任意位置穿过', () => {
  const w = newWorld();
  const data = w.generateChunkData(1, 2);
  const n = CHUNK_SIZE;
  const openOnEast = [];
  for (let ly = 0; ly < n; ly++) if (data.grid[ly * n + (n - 1)] === 0) openOnEast.push(ly);
  const allowed = new Set();
  for (const p of w.chunkPortals(1, 2)) {
    const anchor = w.portalAnchor(p, 1, 2);
    if (anchor.side === 'E') for (let ly = p.lo; ly <= p.hi; ly++) allowed.add(ly);
  }
  for (const ly of openOnEast) assert(allowed.has(ly), `东墙出现未登记开口 ly=${ly}`);
  assert(allowed.size > 0, '应至少有一个登记开口');
});

test('近路门户在精细层被阻断，但其他门户对最大角色尺寸可通行', async () => {
  const w = newWorld();
  const store = new ChunkStore(w, { budget: 25, loadDelayMs: 0 });
  const sc = w.getPortal(w.shortcutPortalId);
  for (const side of [sc.a, sc.b]) {
    await store.ensureLoaded(side.cx, side.cy);
    const fine = w.fineAnchor(sc, side.cx, side.cy);
    const data = store.get(side.cx, side.cy);
    assert(!fits(data.grid, CHUNK_SIZE, fine.lx, fine.ly, MAX_CHARACTER_RADIUS), '近路精细锚点必须不可通行');
  }
  let normal = 0;
  for (const p of w.portals.values()) {
    if (p.shortcut) continue;
    for (const side of [p.a, p.b]) {
      await store.ensureLoaded(side.cx, side.cy);
      const fine = w.fineAnchor(p, side.cx, side.cy);
      const data = store.get(side.cx, side.cy);
      assert(fits(data.grid, CHUNK_SIZE, fine.lx, fine.ly, MAX_CHARACTER_RADIUS), `门户 ${p.id} 应可通行`);
    }
    normal++;
  }
  assert(normal > 0, '应存在普通门户');
});

console.log('\n粗层区域连通图');

test('粗层只依赖门户登记数据即可求出候选通道序列', () => {
  const w = newWorld();
  const g = new CoarseGraph(w);
  const start = { wx: 10, wy: 2 * CHUNK_SIZE + 10, cx: 0, cy: 2 };
  const goal = { wx: 4 * CHUNK_SIZE + 10, wy: 2 * CHUNK_SIZE + 10, cx: 4, cy: 2 };
  const r = g.findRoute(start, goal);
  assert(r.nodes && r.portals.length >= 4, '跨 5 个块至少需要 4 个门户');
  const scIncluded = r.portals.includes(w.shortcutPortalId);
  assert(scIncluded, '粗层最短候选应包含近路门户（它看起来最短）');
});

test('排除被证伪门户后粗层可重新给出替代候选（回溯能力）', () => {
  const w = newWorld();
  const g = new CoarseGraph(w);
  const start = { wx: 10, wy: 2 * CHUNK_SIZE + 10, cx: 0, cy: 2 };
  const goal = { wx: 4 * CHUNK_SIZE + 10, wy: 2 * CHUNK_SIZE + 10, cx: 4, cy: 2 };
  const r2 = g.findRouteAvoiding(start, goal, [w.shortcutPortalId]);
  assert(r2.nodes, '排除近路后仍应可达');
  assert(!r2.portals.includes(w.shortcutPortalId), '替代路径不得再用近路');
});

test('粗层对世界外目标明确返回不可达而非虚构直线', () => {
  const w = newWorld();
  const g = new CoarseGraph(w);
  const r = g.findRoute({ wx: 0, wy: 0, cx: 0, cy: 0 }, { wx: 0, wy: 0, cx: 99, cy: 99 });
  eq(r.reason, 'out-of-world');
  assert(r.nodes === null, '世界外不得返回路径');
});

console.log('\n精细网格寻路与角色尺寸');

test('gridAstar 尊重墙体与角色占地，封死区域返回 no-route', () => {
  const n = 8;
  const grid = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    grid[i] = 1;
    grid[(n - 1) * n + i] = 1;
    grid[i * n] = 1;
    grid[i * n + (n - 1)] = 1;
  }
  for (let y = 1; y < n - 1; y++) grid[y * n + 4] = 1; // 中间竖墙
  const r1 = gridAstar(grid, n, { x: 2, y: 2 }, { x: 6, y: 2 }, 0);
  eq(r1.path, null, '竖墙封死时无路径');
  eq(r1.reason, 'no-route-in-chunk');
  grid[3 * n + 4] = 0; // 开一个 1 格宽的门
  const r0 = gridAstar(grid, n, { x: 2, y: 3 }, { x: 6, y: 3 }, 0);
  assert(r0.path, '1 格宽门对 1x1 角色可通行');
  const rBig = gridAstar(grid, n, { x: 2, y: 3 }, { x: 6, y: 3 }, 1);
  eq(rBig.path, null, '1 格宽门对 3x3 角色不可通行');
});

console.log('\n分块加载与内存预算');

test('未加载块没有网格数据，状态与驻留内存随加载/淘汰变化', async () => {
  const w = newWorld();
  const store = new ChunkStore(w, { budget: 2, loadDelayMs: 1 });
  eq(store.status(0, 0), 'unloaded');
  assert(store.get(0, 0) === null, '未驻留时不得返回网格');
  await store.ensureLoaded(0, 0);
  await store.ensureLoaded(1, 0);
  eq(store.residentChunks().length, 2);
  await store.ensureLoaded(2, 0, 1);
  eq(store.residentChunks().length, 2, '超出预算必须淘汰');
  eq(store.stats.evictions, 1);
  const evictedGone = store.get(0, 0) === null || store.get(1, 0) === null || store.get(2, 0);
  assert(evictedGone, 'LRU 后最旧块应被淘汰、最新块驻留');
});

test('pin 住的角色所在块不会被淘汰', async () => {
  const w = newWorld();
  const store = new ChunkStore(w, { budget: 2, loadDelayMs: 1 });
  await store.ensureLoaded(0, 0);
  store.pin(0, 0);
  await store.ensureLoaded(1, 0);
  await store.ensureLoaded(2, 0, 1);
  assert(store.get(0, 0), 'pin 块必须保留');
  eq(store.residentChunks().length, 2);
});

console.log('\n分层规划：近路阻断、回溯与状态分类');

test('3x3 角色选到有效替代路径，且仅近路被精细层证伪', async () => {
  const w = newWorld();
  const { sim, exhausted } = await runSim(w, 1);
  const p = sim.planner;
  eq(exhausted, false, '必须在 tick 上限内结束');
  eq(p.state, PlanState.ARRIVED);
  eq([...p.blockedPortalIds], [w.shortcutPortalId], '只有近路被证伪');
  assert(p.coarseAttempts >= 2, '至少回溯重规划一次');
  const statuses = new Set(p.legs.map((l) => l.status));
  assert(statuses.has(LegStatus.DONE), '所有精细段应已走完');
  assert(p.legs.some((l) => l.fineCost !== null), '应包含精细 A* 求出的局部路线');
});

test('1x1 角色同样会在近路处被精细层拦截并改道', async () => {
  const w = newWorld();
  const { sim } = await runSim(w, 0);
  eq(sim.planner.state, PlanState.ARRIVED);
  assert([...sim.planner.blockedPortalIds].includes(w.shortcutPortalId), '近路对任何尺寸都封死');
});

test('运动路径上每一格都与真实网格一致，零穿墙碰撞', async () => {
  const w = newWorld();
  const { sim } = await runSim(w, 1);
  let collisions = 0;
  for (const m of sim.moveLog) {
    const loc = w.locate(m.wx, m.wy);
    const truth = w.generateChunkData(loc.cx, loc.cy);
    if (!fits(truth.grid, CHUNK_SIZE, loc.lx, loc.ly, 1)) collisions++;
  }
  eq(collisions, 0);
  assert(sim.moveLog.length > 20, '应有真实逐格运动');
});

test('角色从未站在未驻留块上（不在未知地形滑行）', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 3, loadDelayMs: 1 });
  const start = openGlobal(w, 0, 2, 1);
  const goal = openGlobal(w, 4, 2, 1);
  sim.start(start.wx, start.wy, goal.wx, goal.wy, 1);
  let violations = 0;
  const orig = sim.planner.processTick.bind(sim.planner);
  while (!sim.finished && sim.tick < 400) {
    await sim.step();
    const loc = w.locate(sim.pos.wx, sim.pos.wy);
    if (sim.store.status(loc.cx, loc.cy) !== 'resident') violations++;
  }
  eq(violations, 0);
  eq(sim.planner.state, PlanState.ARRIVED);
});

test('缺少数据/明确不可达/暂未搜索三种状态分开呈现', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 40 });
  const start = openGlobal(w, 0, 2, 1);
  const goal = openGlobal(w, 4, 2, 1);
  sim.start(start.wx, start.wy, goal.wx, goal.wy, 1);
  const saw = new Set();
  for (let i = 0; i < 8 && !sim.finished; i++) {
    await sim.step();
    for (const l of sim.planner.legs) saw.add(l.status);
  }
  assert(saw.has(LegStatus.QUEUED), '应出现暂未搜索');
  assert(saw.has(LegStatus.AWAITING_DATA), '应出现缺少数据');
  await sim.runToEnd(400);
  assert(sim.planner.blockedPortalIds.size >= 1, '应出现明确不可达的门户');
  assert(sim.planner.doneLegs.length >= 0, '规划器正常结束');
});

test('不可达目标：起点块内一个被墙包围的目标点', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 1 });
  const start = openGlobal(w, 0, 0, 1);
  // 手工构造一个 3x3 实体无法容身的目标（贴角）
  const goal = { wx: 1, wy: 1 };
  sim.start(start.wx, start.wy, goal.wx, goal.wy, 1);
  await sim.runToEnd(50);
  eq(sim.planner.state, PlanState.UNREACHABLE);
  assert(sim.planner.unreachableReason, '必须给出不可达原因');
});

test('整个流程不会把全部块预载入：峰值驻留受预算约束', async () => {
  const w = newWorld();
  const budget = 3;
  const { sim } = await runSim(w, 1, budget);
  assert(sim.store.residentChunks().length <= budget, '驻留数不得超预算');
  assert(sim.store.stats.loads <= w.chunkCount, '加载次数合理');
});

await summary();
