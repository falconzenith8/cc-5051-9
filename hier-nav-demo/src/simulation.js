// 连续导航模拟：角色按已确认的精细路径逐格推进，
// 每个 tick 先让规划器按需加载/确认下一段，再沿确认路径移动。
// 没有确认路径时角色原地等待加载，绝不在未知地形上滑行。

import { HierarchicalPlanner, PlanState } from './planner.js';
import { ChunkStore } from './memory.js';
import { SeatReservationSystem } from './seats.js';
import { chunkId } from './world.js';

export class Simulation {
  constructor(world, { budget = 4, loadDelayMs = 120, speed = 1 } = {}) {
    this.world = world;
    this.store = new ChunkStore(world, { budget, loadDelayMs });
    this.seats = new SeatReservationSystem();
    this.store.seats = this.seats;
    this.planner = new HierarchicalPlanner(world, this.store);
    this.speed = speed; // 每 tick 移动格数
    this.tick = 0;
    this.pos = null; // {wx, wy}
    this.target = null;
    this.radius = 0;
    this.moveLog = [];
    this.finished = false;
    this._planOptions = null;
  }

  start(wx, wy, goalWx, goalWy, radius) {
    this.tick = 0;
    this.finished = false;
    this.moveLog = [];
    this.radius = radius;
    this.pos = { wx, wy };
    this.origin = { wx, wy };
    this.target = { wx: goalWx, wy: goalWy };
    const startLoc = this.world.locate(wx, wy);
    this.store.pin(startLoc.cx, startLoc.cy);
    this.planner.plan(this.pos, this.target, radius, this._planOptions ?? {});
    return this.snapshot();
  }

  // 重新规划时先撤销进行中的预约/细化，避免旧区结果晚到后仍然生效。
  replan(wx, wy, goalWx, goalWy, radius, opts = {}) {
    this.planner.cancel('replanned');
    const prev = this._planOptions;
    this._planOptions = opts;
    const snap = this.start(wx, wy, goalWx, goalWy, radius);
    this._planOptions = prev;
    return snap;
  }

  cancelPlan(reason = 'player-cancelled') {
    this.finished = true;
    return this.planner.cancel(reason);
  }

  // 取消后重新打开同一条路线：保留当前区域载入代次，
  // 已驻留的换门区域不会被旧门登记顶替。
  reopenPlan(radius = this.radius) {
    this.finished = false;
    return this.replan(this.pos.wx, this.pos.wy, this.target.wx, this.target.wy, radius);
  }
  unloadRegion(cx, cy) {
    this.store.unload(cx, cy);
    return this.snapshot();
  }

  // 玩家改道并放弃东侧区域：从规划中撤下该区域并卸载它。
  dropRegion(cx, cy) {
    this.planner.dropRegionFromPlan(cx, cy);
    return this.snapshot();
  }
  // 以另一组门重新载入同名区域：开启新代次并立即载入，
  // 旧代次确认与预约不会沿用；下一次 tick 精细层按新门重新求路。
  async reloadRegion(cx, cy, portals, tick = this.tick) {
    this.store.seats?.releaseRegion?.(chunkId(cx, cy), 'region-reloaded');
    this.planner.beginRegionReload(cx, cy, portals);
    return this.store.loadRegion(cx, cy, {
      portals,
      dataVersion: this.planner.epochOf(cx, cy),
      tick,
      force: true,
    });
  }

  // 推进一个 tick。返回快照；idle 时返回 false。
  async step() {
    if (this.finished || this.planner.state === PlanState.IDLE) return false;
    this.tick++;

    // 先处理规划（真实异步加载发生在这里）
    await this.planner.processTick(this.tick);
    // 同步驻留保护：当前块与已确认段涉及的块不会被 LRU 淘汰
    this.planner.syncPins(this.store);

    // 当前块保持最新 LRU 时间
    const loc = this.world.locate(this.pos.wx, this.pos.wy);
    this.store.touch(loc.cx, loc.cy, this.tick);

    // 沿当前已确认段逐格推进 speed 格；没有确认段时原地等待加载
    for (let s = 0; s < this.speed; s++) {
      const leg = this.planner.activeConfirmedLeg();
      if (!leg) break;
      let next = null;
      if (leg.type === 'move' && leg.localPath) {
        const idx = leg.localPath.findIndex(
          (p) => p.wx === this.pos.wx && p.wy === this.pos.wy,
        );
        next = idx >= 0 && idx + 1 < leg.localPath.length ? leg.localPath[idx + 1] : null;
        if (!next) next = leg.localPath[leg.localPath.length - 1];
      } else if (leg.type === 'cross') {
        if (this.pos.wx !== leg.to.wx || this.pos.wy !== leg.to.wy) next = { wx: leg.to.wx, wy: leg.to.wy };
      }
      if (!next) break;
      this.pos = { wx: next.wx, wy: next.wy };
      this.moveLog.push({ tick: this.tick, wx: next.wx, wy: next.wy });
      this.planner.updatePosition(next.wx, next.wy);
      if (this.planner.state === PlanState.ARRIVED) break;
    }
    // 移动后再次同步，确保新进入的块立即受驻留保护
    this.planner.syncPins(this.store);

    if (this.planner.state === PlanState.ARRIVED || this.planner.state === PlanState.UNREACHABLE) {
      this.finished = true;
    }
    return this.snapshot();
  }

  // 一次性跑到结束（headless/CLI 与测试用），带最大 tick 保护。
  async runToEnd(maxTicks = 400) {
    const frames = [this.snapshot()];
    while (!this.finished && this.tick < maxTicks) {
      const snap = await this.step();
      if (!snap) break;
      frames.push(snap);
    }
    return { frames, exhausted: !this.finished, final: this.snapshot() };
  }

  snapshot() {
    return {
      tick: this.tick,
      finished: this.finished,
      origin: this.origin ? { ...this.origin } : null,
      pos: this.pos ? { ...this.pos } : null,
      target: this.target ? { ...this.target } : null,
      radius: this.radius,
      planner: this.planner.snapshot(),
      seats: this.seats.snapshot(),
      memory: {
        budget: this.store.budget,
        residentBytes: this.store.residentBytes(),
        resident: this.store.residentChunks(),
        loading: this.store.loadingChunks(),
        stats: { ...this.store.stats },
        events: [...this.store.events],
      },
    };
  }
}
