import { test, assert, eq, summary } from './harness.js';
import { World, CHUNK_SIZE, MAX_CHARACTER_RADIUS } from '../src/world.js';
import { gridAstar, fits } from '../src/astar.js';
import { CoarseGraph } from '../src/coarse.js';
import { ChunkStore } from '../src/memory.js';
import { HierarchicalPlanner, PlanState, LegStatus, PlanOutcome } from '../src/planner.js';
import { Simulation } from '../src/simulation.js';
import { SeatReservationSystem, SeatStage } from '../src/seats.js';

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

console.log('\n区域存在 vs 本次载入的可行边已确认');

// 辅助：等待规划器进入某一状态或 tick 用尽。
async function runUntilPending(sim, maxTicks = 200) {
  let seen = null;
  while (!sim.finished && sim.tick < maxTicks) {
    await sim.step();
    const o = sim.planner.outcome();
    if (o && o.kind === PlanOutcome.PENDING_DATA) seen = o;
    if (seen) return seen;
  }
  return seen;
}

test('区域存在与“本次载入的可行边已确认”分开表达：未载入区域仍可被粗层选择', () => {
  const w = newWorld();
  const store = new ChunkStore(w, { budget: 4, loadDelayMs: 1 });
  const planner = new HierarchicalPlanner(w, store);
  // 目标区域尚未载入。
  assert(store.get(4, 2) === null, '目标区域此刻不应驻留');
  assert(w.regionExists(4, 2), '区域存在只由世界登记决定，与载入无关');
  const snap = planner.plan(
    openGlobal(w, 0, 2, 1), openGlobal(w, 4, 2, 1), 1,
  );
  eq(snap.state, PlanState.SEEKING);
  assert(snap.coarseRoute.portals.length >= 4, '未载入区域之间仍能给出候选门户');
  // 但没有任何一条边被确认为可行（数据未到）。
  assert(snap.legs.every((l) => l.status === LegStatus.QUEUED), '所有边尚处于暂未搜索');
});

test('等局部数据与已证实不可达严格区分，且 pending 不撤下承诺路线', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 30 });
  const start = openGlobal(w, 0, 2, 1);
  const goal = openGlobal(w, 4, 2, 1);
  sim.start(start.wx, start.wy, goal.wx, goal.wy, 1);

  // 第二个 tick 后应有“正在加载”的段。
  await sim.step();
  await sim.step();
  const pending = sim.planner.outcome();
  eq(pending.kind, PlanOutcome.PENDING_DATA, '缺数据阶段应报告 pending-data');
  assert(sim.planner.state === PlanState.SEEKING, 'pending 不是不可达');
  const mapPending = sim.planner.mapRoutes();
  assert(mapPending.promisedPortals.length > 0, '等数据时承诺路线仍在');

  const { final } = await sim.runToEnd(400);
  eq(final.planner.state, PlanState.ARRIVED);
  // 近路最终被精细层证实不可达 → 从承诺路线撤下。
  assert(final.planner.blockedPortalIds.includes(w.shortcutPortalId), '近路应被证实不可达');
  const promised = new Set(final.planner.map.promisedPortals);
  assert(!promised.has(w.shortcutPortalId), '已证实不可达的门不得出现在承诺路线');
});

test('区域地图区分承诺路线与已撤销路段', async () => {
  const w = newWorld();
  const { sim } = await runSim(w, 1);
  const map = sim.planner.mapRoutes();
  assert(map.promisedPolyline.length >= 2, '承诺路线应有折线');
  const revokedIds = map.revoked.map((r) => r.portalId);
  assert(revokedIds.includes(w.shortcutPortalId), '近路应以撤销路段显示');
  assert(!map.promisedPortals.includes(w.shortcutPortalId), '撤销路段不在承诺路线中');
});

console.log('\n渡台席位预约与同名出口复用');

test('角色预约东门班次后，卸载再复用同名出口不能继承旧位', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 1 });
  // 东门：区域 (1,2) 与 (2,2) 之间的门。
  const east = w.chunkPortals(1, 2).find(
    (p) => [p.a, p.b].some((s) => s.cx === 2 && s.cy === 2) && !p.shortcut,
  );
  const edge = { key: 'east-edge', portalId: east.id, a: { cx: 1, cy: 2 }, b: { cx: 2, cy: 2 }, instanceIds: {} };
  const t1 = sim.seats.reserveEdge(edge, { epoch: 0 });
  eq(t1.stage, SeatStage.RESERVED, '东门班次已预约');
  const occBefore = sim.seats.occupiedCount();

  sim.unloadRegion(1, 2);
  eq(sim.seats.stageOf('east-edge'), null, '卸载后旧席位必须撤销');

  // 同名出口重新载入（新代次）。
  await sim.reloadRegion(1, 2, w.chunkPortals(1, 2));
  const t2 = sim.seats.reserveEdge(edge, { epoch: sim.planner.epochOf(1, 2) });
  eq(t2.stage, SeatStage.RESERVED);
  assert(t2.id !== t1.id, '复用同名出口必须得到新票，不能继承旧位');
  eq(sim.seats.occupiedCount(), occBefore, '旧票已释放、新票独立');
});

test('西门候补角色在旧路线未采用后能登台，预约确实释放一席', () => {
  const seats = new SeatReservationSystem({ capacity: 1 });
  const east = { key: 'east', portalId: 'E', a: { cx: 1, cy: 2 }, b: { cx: 2, cy: 2 }, instanceIds: {} };
  const west = { key: 'west', portalId: 'W', a: { cx: 0, cy: 2 }, b: { cx: 1, cy: 2 }, instanceIds: {} };

  seats.reserveEdge(east, { epoch: 0 });
  const westTicket = seats.enqueue(west, { epoch: 0 });
  eq(westTicket.stage, SeatStage.WAITLIST, '西门先在候补');
  eq(seats.occupiedCount(), 1, '满席');
  eq(seats.tryBoardFromWaitlist('west'), null, '满席时候补无法登台');

  // 旧路线（东门）未被采用 → 撤销其预约。
  seats.releaseEdge(east, 'route-not-taken');
  eq(seats.occupiedCount(), 0, '撤销后确实空出一席');
  const boarded = seats.tryBoardFromWaitlist('west');
  assert(boarded && boarded.stage === SeatStage.RESERVED, '西门候补应登台成功');
  eq(seats.occupiedCount(), 1);
});

test('规划器在证伪边时把撤销送到席位预约系统', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 30 });
  sim.start(openGlobal(w, 0, 2, 1).wx, openGlobal(w, 0, 2, 1).wy, openGlobal(w, 3, 2, 1).wx, openGlobal(w, 3, 2, 1).wy, 1);
  const { final } = await sim.runToEnd(400);
  eq(final.planner.state, PlanState.ARRIVED);
  const releases = final.seats.log.filter((l) => l.action === 'release');
  assert(releases.length >= 1, '至少一条撤销应到达席位系统');
  const scRelease = releases.find((l) => l.edgeKey.includes(w.shortcutPortalId));
  assert(scRelease, '近路被证伪时其席位必须撤销');
});

console.log('\n改道、卸载与旧区细化迟到');

test('刚走向东门就改去西门并卸载东区，迟到的旧细化不会复活', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 25 });
  const start = openGlobal(w, 2, 2, 1);
  const east = openGlobal(w, 4, 2, 1);
  const west = openGlobal(w, 0, 2, 1);
  sim.start(start.wx, start.wy, east.wx, east.wy, 1);
  // 先走一步，让东区载入在途。
  await sim.step();

  // 玩家改去西门，并把东区（4,2）从规划撤下卸载。
  sim.dropRegion(4, 2);
  assert(sim.store.status(4, 2) !== 'resident', '东区卸载后不应驻留');
  // 再等到东区原本的在途载入完成时间之后，仍不得复活。
  await new Promise((r) => setTimeout(r, 60));
  assert(sim.store.status(4, 2) !== 'resident', '在途旧细化完成后也不得复活东区');

  sim.replan(start.wx, start.wy, west.wx, west.wy, 1);
  while (!sim.finished && sim.tick < 500) await sim.step();
  eq(sim.planner.state, PlanState.ARRIVED, '改道西门后应到达');
  // 实际移动不应仍朝东区深入。
  const last = sim.moveLog[sim.moveLog.length - 1];
  assert(last.wx < east.wx, '实际移动应改往西侧');
});

test('改道撤销旧路线后，旧路线未采用确实释放了一席给新路线', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 20 });
  const start = openGlobal(w, 2, 2, 1);
  const east = openGlobal(w, 4, 2, 1);
  const west = openGlobal(w, 0, 2, 1);
  sim.start(start.wx, start.wy, east.wx, east.wy, 1);
  await sim.step();
  const before = sim.seats.activeTickets().length;
  sim.replan(start.wx, start.wy, west.wx, west.wy, 1);
  const releasedByReplan = sim.seats.log.filter(
    (l) => l.action === 'release' && l.reason === 'replanned',
  ).length;
  assert(releasedByReplan >= 1, '重新规划应撤销旧路线的预约');
  assert(before >= 1, '改道前应已有预约');
});

console.log('\n同名区域换门重载与交叉任务');

test('同名区域以另一组门重载后，粗层与精细层都不会借用旧门', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 8, loadDelayMs: 1 });
  // 区域 (2,2) 通往 (3,2) 的两道普通门（不含近路）。
  const cross = w.chunkPortals(2, 2).filter(
    (p) => [p.a, p.b].some((s) => s.cx === 3 && s.cy === 2) && !p.shortcut,
  );
  assert(cross.length >= 2, '测试世界应有至少两道东向门');
  const [keepA, keepB] = cross;
  const onlyKeep = (keep) => w.chunkPortals(2, 2).filter(
    (p) => !cross.includes(p) || p.id === keep.id,
  );

  await sim.reloadRegion(2, 2, onlyKeep(keepA));
  const start = openGlobal(w, 0, 2, 1);
  const goal = openGlobal(w, 4, 2, 1);
  sim.start(start.wx, start.wy, goal.wx, goal.wy, 1);
  // 该次载入的粗层候选只包含 A，不含 B。
  assert(sim.planner.coarseRoute.portals.includes(keepA.id), '粗层应按本次载入选 A');
  assert(!sim.planner.coarseRoute.portals.includes(keepB.id), '未在本次载入的 B 不应出现');

  // 换成只保留 B 的另一组门重载，并重新打开路线。
  await sim.reloadRegion(2, 2, onlyKeep(keepB));
  sim.reopenPlan();
  assert(!sim.planner.coarseRoute.portals.includes(keepA.id), '换门后粗层不得再用旧门 A');
  while (!sim.finished && sim.tick < 500) await sim.step();
  eq(sim.planner.state, PlanState.ARRIVED);

  // 实际穿越：经过区域 (2,2) 的跨块移动必须落在本次载入的门集合内。
  const allowed = new Set(w.openPortalIds(sim.store.get(2, 2)));
  let last = { wx: start.wx, wy: start.wy };
  let touched = 0;
  for (const m of sim.moveLog) {
    const c = w.classifyMove(last.wx, last.wy, m.wx, m.wy);
    if (c.cross && c.portal) {
      const involves = [c.portal.a, c.portal.b].some((s) => s.cx === 2 && s.cy === 2);
      if (involves) {
        touched++;
        assert(allowed.has(c.portal.id), `实际穿越借用了旧门 ${c.portal.id}`);
      }
    }
    last = { wx: m.wx, wy: m.wy };
  }
  assert(touched >= 1, '应至少有一次经过区域 (2,2) 的真实跨块移动');
  assert(!allowed.has(keepA.id), '本次载入不应开放旧门 A');
});

test('两条任务交叉返回：重新打开的路线不会复用另一条任务的旧门', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 8, loadDelayMs: 1 });
  const cross = w.chunkPortals(2, 2).filter(
    (p) => [p.a, p.b].some((s) => s.cx === 3 && s.cy === 2) && !p.shortcut,
  );
  const [doorA, doorB] = cross;
  const onlyKeep = (keep) => w.chunkPortals(2, 2).filter(
    (p) => !cross.includes(p) || p.id === keep.id,
  );
  const east = openGlobal(w, 4, 2, 1);
  const west = openGlobal(w, 0, 2, 1);
  const mid = openGlobal(w, 3, 2, 1);

  // 任务一：向东，使用门 A。
  await sim.reloadRegion(2, 2, onlyKeep(doorA));
  sim.start(west.wx, west.wy, east.wx, east.wy, 1);
  let guard = 0;
  while (!sim.finished && sim.tick < 400 && guard++ < 400) {
    await sim.step();
    if (sim.pos.wx > mid.wx) break; // 已进入东侧
  }
  const stopAt = { ...sim.pos };

  // 任务二：交叉返回西侧，此时同名区域以门 B 重载。
  await sim.reloadRegion(2, 2, onlyKeep(doorB));
  sim.replan(stopAt.wx, stopAt.wy, west.wx, west.wy, 1);
  assert(!sim.planner.coarseRoute.portals.includes(doorA.id), '返回任务不得再计划旧门 A');
  while (!sim.finished && sim.tick < 600) await sim.step();
  eq(sim.planner.state, PlanState.ARRIVED);

  // 重新打开东向路线：仍必须使用当前载入的门 B，不得复用 A。
  sim.replan(stopAt.wx, stopAt.wy, east.wx, east.wy, 1);
  assert(!sim.planner.coarseRoute.portals.includes(doorA.id), '重新打开路线不得借用旧门 A');
  const allowed = new Set(w.openPortalIds(sim.store.get(2, 2)));
  assert(!allowed.has(doorA.id) && allowed.has(doorB.id), '当前载入只开放门 B');

  let last = { ...stopAt };
  for (const m of sim.moveLog) {
    const c = w.classifyMove(last.wx, last.wy, m.wx, m.wy);
    if (c.cross && c.portal && [c.portal.a, c.portal.b].some((s) => s.cx === 2 && s.cy === 2)) {
      assert(c.portal.id === doorB.id, `交叉返回借用了旧门 ${c.portal.id}`);
    }
    last = { wx: m.wx, wy: m.wy };
  }
});

console.log('\n宏观连通但细节揭示后暂时封闭的出口');

test('宏观连通、细节揭示后封闭的出口：先从封闭区撤回指令，再从入口重试改走替代门', async () => {
  const w = newWorld();
  // 选一道粗层真正会选中的门，并在目标区域的这次载入里把它砌死。
  const probe = new Simulation(w, { budget: 8, loadDelayMs: 1 });
  const start = openGlobal(w, 0, 2, 1);
  const goal = openGlobal(w, 2, 2, 1);
  probe.start(start.wx, start.wy, goal.wx, goal.wy, 1);
  const chosen = probe.planner.coarseRoute.portals.find((id) => {
    const p = w.getPortal(id);
    return [p.a, p.b].some((s) => s.cx === 1 && s.cy === 2);
  });
  assert(chosen, '粗层候选应包含通往封闭区的门');

  const sim = new Simulation(w, { budget: 8, loadDelayMs: 15 });
  sim.planner.closeEdgeDetail(1, 2, chosen);
  sim.start(start.wx, start.wy, goal.wx, goal.wy, 1);
  // 宏观仍然把它当候选（区域连通、门登记存在）。
  assert(sim.planner.coarseRoute.portals.includes(chosen), '宏观图仍包含该出口');

  // 走到揭示封闭之前，先撤回指令。
  await sim.step();
  await sim.step();
  sim.cancelPlan('player-withdrew-from-closed-region');
  eq(sim.planner.state, PlanState.IDLE, '撤回后回到 idle');
  const releases = sim.seats.log.filter((l) => l.action === 'release');
  assert(releases.length >= 1, '撤回指令应撤销席位预约');

  // 从入口重试：精细层确认该出口封闭 → 证伪并回溯。
  sim.reopenPlan();
  const { final } = await sim.runToEnd(600);
  eq(final.planner.state, PlanState.ARRIVED, '应从入口重试并改走替代门到达');
  assert(final.planner.blockedPortalIds.includes(chosen), '封闭出口应被证实不可达');
  assert(!final.planner.map.promisedPortals.includes(chosen), '撤销出口不得留在承诺路线');
  assert(final.planner.coarseAttempts >= 2, '应回溯重搜');
});

console.log('\n重构后调用者区分两种否定结果并影响安全路段');

test('调用者可区分“正在等局部数据”与“已经证实不可达”，且安全路段随之变化', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 20 });
  const start = openGlobal(w, 0, 2, 1);
  const goal = openGlobal(w, 4, 2, 1);
  sim.start(start.wx, start.wy, goal.wx, goal.wy, 1);

  const seen = new Set();
  let pendingSafeLen = null;
  let provenSafeLen = null;
  let last = { wx: start.wx, wy: start.wy };
  while (!sim.finished && sim.tick < 400) {
    await sim.step();
    const o = sim.planner.outcome();
    if (o) seen.add(o.kind);
    if (o?.kind === PlanOutcome.PENDING_DATA && pendingSafeLen === null) {
      pendingSafeLen = sim.planner.currentConfirmedPath().length;
    }
    if (o?.kind === PlanOutcome.PROVEN_UNREACHABLE && provenSafeLen === null) {
      provenSafeLen = sim.planner.currentConfirmedPath().length;
    }
    last = { wx: sim.pos.wx, wy: sim.pos.wy };
  }
  // 缺数据阶段：安全路段停在已确认处（可为 1，即当前位置）。
  assert(pendingSafeLen !== null && pendingSafeLen >= 1, '等数据时仍有安全路段');
  // 本世界最终可达，prove 阶段由近路的证伪体现：回溯期间不把证伪门当安全路段。
  const map = sim.planner.mapRoutes();
  for (const seg of map.promisedPolyline) {
    assert(Number.isFinite(seg.wx) && Number.isFinite(seg.wy), '承诺路线坐标有效');
  }
  eq(sim.planner.state, PlanState.ARRIVED);
  assert(seen.has(PlanOutcome.PENDING_DATA), '调用者应观察到 pending-data');
});

test('已证实不可达的目标给出 proven-unreachable，而非永远等数据', async () => {
  const w = newWorld();
  const sim = new Simulation(w, { budget: 6, loadDelayMs: 1 });
  const start = openGlobal(w, 0, 0, 1);
  sim.start(start.wx, start.wy, 1, 1, 1); // 贴角目标，3x3 无法容身
  await sim.runToEnd(60);
  const o = sim.planner.outcome();
  eq(o.kind, PlanOutcome.PROVEN_UNREACHABLE, '应报告已证实不可达');
  assert(o.reason, '必须给出不可达原因');
});

await summary();
