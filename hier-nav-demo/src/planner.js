// 分层规划器：粗层区域连通只给出候选门户通道，
// 真正的局部路线在精细块按需载入后才逐段求出。
// 精细层一旦证伪某条通道（角色尺寸过不去），门户被标记为明确不可达，
// 粗层在排除该门户后重新搜索，实现回溯修正，绝不沿一条跨地图直线穿越未知地形。
//
// 三类状态严格分开：
//   queued        暂未搜索（块还没轮到加载）
//   awaiting-data 缺少数据（加载请求已发出，精细网格尚未驻留）
//   blocked       明确不可达（精细层已验证该门户/目标对当前角色不成立）
//   confirmed     精细层已验证并求出局部路线

import { CoarseGraph } from './coarse.js';
import { FinePlanner } from './fine.js';
import { chunkId, CHUNK_SIZE } from './world.js';

export const PlanState = Object.freeze({
  IDLE: 'idle',
  SEEKING: 'seeking',
  UNREACHABLE: 'unreachable',
  ARRIVED: 'arrived',
});

export const LegStatus = Object.freeze({
  QUEUED: 'queued',
  AWAITING_DATA: 'awaiting-data',
  CONFIRMED: 'confirmed',
  DONE: 'done',
  BLOCKED: 'blocked',
});

const toGlobal = (cx, cy, lx, ly) => ({
  wx: cx * CHUNK_SIZE + lx,
  wy: cy * CHUNK_SIZE + ly,
  cx,
  cy,
  lx,
  ly,
});

export class HierarchicalPlanner {
  constructor(world, store) {
    this.world = world;
    this.store = store;
    this.coarse = new CoarseGraph(world);
    this.fine = new FinePlanner(world, store);
    this.reset();
  }

  reset() {
    this.state = PlanState.IDLE;
    this.radius = 0;
    this.start = null;
    this.startRef = null;
    this.goal = null;
    this.legs = [];
    this.doneLegs = [];
    this.blockedPortalIds = new Set(); // 当前规划已证伪（持久保留到本次求路结束）
    this.coarseRoute = null;
    this.coarseAttempts = 0;
    this.unreachableReason = null;
    this.lastFineResult = null;
  }
  plan(start, goal, radius = 0) {
    this.reset();
    this.radius = radius;
    this.start = this._locate(start);
    this.startRef = { wx: this.start.wx, wy: this.start.wy };
    this.goal = this._locate(goal);
    this._runCoarse();
    return this.snapshot();
  }

  _locate(p) {
    const loc = this.world.locate(p.wx, p.wy);
    return toGlobal(loc.cx, loc.cy, loc.lx, loc.ly);
  }

  _runCoarse() {
    this.coarseAttempts++;
    const route = this.coarse.findRouteAvoiding(this.start, this.goal, this.blockedPortalIds);
    if (!route.nodes) {
      this.state = PlanState.UNREACHABLE;
      this.unreachableReason = this.blockedPortalIds.size
        ? 'all-coarse-candidates-failed-fine-check'
        : route.reason || 'coarse-unreachable';
      this.coarseRoute = { portals: route.portals, estCost: route.cost, rejected: true };
      this.legs = [];
      return;
    }
    this.coarseRoute = {
      portals: route.portals,
      estCost: route.cost,
      expanded: route.expanded,
      rejected: false,
      polyline: this._coarsePolyline(route.portals),
    };
    this.legs = this._buildLegs(route.portals);
    this.state = PlanState.SEEKING;
  }

  _coarsePolyline(portalIds) {
    const pts = [{ wx: this.start.wx, wy: this.start.wy }];
    for (const id of portalIds) {
      const p = this.world.getPortal(id);
      pts.push(this._sideGlobal(p.a));
      pts.push(this._sideGlobal(p.b));
    }
    pts.push({ wx: this.goal.wx, wy: this.goal.wy });
    return pts;
  }

  _sideGlobal(side) {
    return toGlobal(side.cx, side.cy, side.lx, side.ly);
  }

  // 精细层锚点（向块内退一格），供块内寻路与跨门检查使用。
  _fineSideGlobal(portal, side) {
    const fine = this.world.fineAnchor(portal, side.cx, side.cy);
    return toGlobal(side.cx, side.cy, fine.lx, fine.ly);
  }

  _buildLegs(portalIds) {
    // 按门户序列构造“块内移动 -> 跨门户 -> 块内移动 …”的交替段。
    // 每个门户在序列中取其“进入侧”和“离开侧”两个锚点。
    const legs = [];
    let cur = this.start;

    for (const id of portalIds) {
      const portal = this.world.getPortal(id);
      // 进入侧 = 与当前点同块的那一侧；锚点取精细内侧位置
      const entry = [portal.a, portal.b].find(
        (s) => s.cx === cur.cx && s.cy === cur.cy,
      );
      const exit = entry === portal.a ? portal.b : portal.a;
      const entryPt = this._fineSideGlobal(portal, entry);
      const exitPt = this._fineSideGlobal(portal, exit);

      legs.push({
        id: `L${legs.length}`,
        type: 'move',
        status: LegStatus.QUEUED,
        chunk: { cx: cur.cx, cy: cur.cy },
        from: cur,
        to: entryPt,
        portalId: id,
        localPath: null,
        fineCost: null,
        detail: null,
      });
      legs.push({
        id: `L${legs.length}`,
        type: 'cross',
        status: LegStatus.QUEUED,
        portalId: id,
        from: entryPt,
        to: exitPt,
        detail: null,
      });
      cur = exitPt;
    }

    // 最后一个块内移动到目标
    legs.push({
      id: `L${legs.length}`,
      type: 'move',
      status: LegStatus.QUEUED,
      chunk: { cx: cur.cx, cy: cur.cy },
      from: cur,
      to: this.goal,
      portalId: null,
      localPath: null,
      fineCost: null,
      detail: null,
    });
    return legs;
  }

  _firstPending() {
    return this.legs.find((l) =>
      [LegStatus.QUEUED, LegStatus.AWAITING_DATA].includes(l.status));
  }

  // 每个模拟 tick 调用一次：加载所需块并精细确认下一段。
  async processTick(tick) {
    if (this.state !== PlanState.SEEKING) return;
    const leg = this._firstPending();
    if (!leg) return;

    const needed = leg.type === 'move'
      ? [leg.chunk]
      : [{ cx: leg.from.cx, cy: leg.from.cy }, { cx: leg.to.cx, cy: leg.to.cy }];

    const before = needed.map((c) => this.store.status(c.cx, c.cy));
    await Promise.all(needed.map((c) => this.store.ensureLoaded(c.cx, c.cy, tick)));
    const residentNow = needed.map((c) => this.store.status(c.cx, c.cy));
    if (residentNow.some((s) => s !== 'resident')) {
      leg.status = LegStatus.AWAITING_DATA;
      return;
    }
    // 首次发起加载：本 tick 只标记“缺少数据”，精细确认留到数据就绪后的下一 tick
    if (before.some((s) => s !== 'resident')) {
      leg.status = LegStatus.AWAITING_DATA;
      this._preloadNext(leg, tick);
      return;
    }

    if (leg.type === 'cross') {
      const portal = this.world.getPortal(leg.portalId);
      const okFrom = this.fine.portalPassable(portal, leg.from.cx, leg.from.cy, this.radius);
      const okTo = this.fine.portalPassable(portal, leg.to.cx, leg.to.cy, this.radius);
      if (okFrom && okTo) {
        leg.status = LegStatus.CONFIRMED;
        leg.detail = 'fine-clearance-verified';
      } else {
        this._rejectPortal(leg.portalId, 'portal-blocked-for-character-size');
        return;
      }
    } else {
      const result = this.fine.planWithin(
        leg.chunk.cx, leg.chunk.cy,
        { lx: leg.from.lx, ly: leg.from.ly },
        { lx: leg.to.lx, ly: leg.to.ly },
        this.radius,
      );
      this.lastFineResult = { leg: leg.id, ...result };
      if (result.ok) {
        leg.status = LegStatus.CONFIRMED;
        leg.localPath = result.localPath.map((p) =>
          toGlobal(leg.chunk.cx, leg.chunk.cy, p.lx, p.ly));
        leg.fineCost = result.cost;
        leg.detail = `fine-astar-expanded-${result.expanded}`;
      } else {
        // 精细层证伪：判断是门户问题还是起终点本身不可达
        if (leg.portalId) {
          this._rejectPortal(leg.portalId, result.reason);
        } else {
          this.state = PlanState.UNREACHABLE;
          this.unreachableReason = result.reason.includes('goal')
            ? 'goal-cell-fits-not-character'
            : 'start-cell-fits-not-character';
          leg.status = LegStatus.BLOCKED;
          leg.detail = result.reason;
        }
        return;
      }
    }
    this._preloadNext(leg, tick);
  }

  _preloadNext(leg, tick) {
    const idx = this.legs.indexOf(leg);
    const next = this.legs[idx + 1];
    if (!next) return;
    const chunks = next.type === 'move'
      ? [next.chunk]
      : [{ cx: next.from.cx, cy: next.from.cy }, { cx: next.to.cx, cy: next.to.cy }];
    for (const c of chunks) {
      if (this.store.status(c.cx, c.cy) === 'unloaded') {
        this.store.ensureLoaded(c.cx, c.cy, tick).catch(() => {});
      }
    }
  }

  _rejectPortal(portalId, reason) {
    this.blockedPortalIds.add(portalId);
    for (const leg of this.legs) {
      if (leg.portalId === portalId) {
        leg.status = LegStatus.BLOCKED;
        leg.detail = reason;
      }
    }
    // 已确认走过的段保留为历史；从角色当前位置重新粗规划剩余路径
    const kept = this.legs.filter((l) => l.status === LegStatus.DONE);
    this.doneLegs.push(...kept);
    this.legs = [];
    this.start = this._locate(this.startRef);
    this._runCoarse();
  }

  // 模拟移动后回报位置：推进段的完成状态。
  updatePosition(wx, wy) {
    this.startRef = { wx, wy };
    const leg = this.legs.find((l) => l.status !== LegStatus.DONE && l.status !== LegStatus.BLOCKED);
    if (!leg) {
      if (this.state === PlanState.SEEKING) this.state = PlanState.ARRIVED;
      return;
    }
    const atEnd = (w) => w.wx === wx && w.wy === wy;
    if (leg.status === LegStatus.CONFIRMED && atEnd(leg.to)) {
      leg.status = LegStatus.DONE;
      if (this.legs.every((l) => l.status === LegStatus.DONE)) {
        this.state = PlanState.ARRIVED;
      }
    }
  }

  // pin 住角色当前块以及所有已确认但尚未走完的段涉及的块，
  // 保证角色不会踏入已被 LRU 淘汰、精细数据缺失的块。
  syncPins(store) {
    const pinned = new Set();
    if (this.startRef) {
      const loc = this.world.locate(this.startRef.wx, this.startRef.wy);
      pinned.add(chunkId(loc.cx, loc.cy));
    }
    for (const leg of this.legs) {
      if (leg.status !== LegStatus.CONFIRMED) continue;
      if (leg.type === 'move') pinned.add(chunkId(leg.chunk.cx, leg.chunk.cy));
      else {
        pinned.add(chunkId(leg.from.cx, leg.from.cy));
        pinned.add(chunkId(leg.to.cx, leg.to.cy));
      }
    }
    for (const key of pinned) {
      const [cx, cy] = key.split(',').map(Number);
      store.pin(cx, cy);
    }
    for (const key of [...store.pinned]) {
      if (!pinned.has(key)) {
        const [cx, cy] = key.split(',').map(Number);
        store.unpin(cx, cy);
      }
    }
  }

  // 角色当前应沿其行走的段（第一个已确认且未走完的段）。
  activeConfirmedLeg() {
    return this.legs.find((l) => l.status === LegStatus.CONFIRMED) ?? null;
  }

  // 已确认可立即行走的连续路径（界面整体预览用），以角色当前位置为首点。
  currentConfirmedPath() {
    const cur = this.startRef;
    if (!cur) return [];
    const out = [{ wx: cur.wx, wy: cur.wy }];
    for (const leg of this.legs) {
      if (leg.status === LegStatus.DONE) continue;
      if (leg.status !== LegStatus.CONFIRMED) break;
      if (leg.type === 'move' && leg.localPath) {
        for (const p of leg.localPath) {
          const last = out[out.length - 1];
          if (last.wx !== p.wx || last.wy !== p.wy) out.push({ wx: p.wx, wy: p.wy });
        }
      } else if (leg.type === 'cross') {
        const last = out[out.length - 1];
        if (last.wx !== leg.to.wx || last.wy !== leg.to.wy) out.push({ wx: leg.to.wx, wy: leg.to.wy });
      }
    }
    return out;
  }

  snapshot() {
    return {
      state: this.state,
      radius: this.radius,
      start: this.start,
      goal: this.goal,
      coarseRoute: this.coarseRoute,
      coarseAttempts: this.coarseAttempts,
      blockedPortalIds: [...this.blockedPortalIds],
      unreachableReason: this.unreachableReason,
      legs: this.legs.map((l) => ({
        id: l.id,
        type: l.type,
        status: l.status,
        chunk: l.chunk ? chunkId(l.chunk.cx, l.chunk.cy) : null,
        from: { wx: l.from.wx, wy: l.from.wy },
        to: { wx: l.to.wx, wy: l.to.wy },
        portalId: l.portalId,
        fineCost: l.fineCost ?? null,
        detail: l.detail,
        path: l.localPath ? l.localPath.map((p) => ({ wx: p.wx, wy: p.wy })) : null,
      })),
      doneLegs: this.doneLegs.map((l) => l.id),
      confirmedPath: this.currentConfirmedPath(),
    };
  }
}
