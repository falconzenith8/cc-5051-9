// 分层规划器：粗层区域连通只给出候选门户通道，
// 真正的局部路线在精细块按需载入后才逐段求出。
//
// 两个概念严格分开：
//   - 区域存在（regionExists）：只由世界登记决定。粗层因此仍能在
//     “宏观连通、细节暂未揭示”的区域之间给出候选通道。
//   - 该次载入的可行边已确认（edgeConfirmed）：只有在当时驻留的那一次
//     载入上做过精细净空/块内寻路，才算确认。确认结果带 instanceId，
//     区域被卸载或被以另一代次重载后，旧确认立即失效，不能继承。
//
// 边状态严格分开：
//   queued        暂未搜索（块还没轮到加载）
//   awaiting-data 正在等局部数据（加载已发出，尚未驻留）——不是不可达
//   blocked       已经证实不可达（精细层在该次载入上验证不成立）
//   confirmed     该次载入已验证并求出局部路线
//
// “等局部数据”与“已证实不可达”绝不混为一谈：前者只是 pending，
// 地图上仍应显示为承诺路线；后者才把粗层边撤下。

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

// 调用者需要区分的两种否定信号：还在等数据，还是已经证实不可达。
export const PlanOutcome = Object.freeze({
  PENDING_DATA: 'pending-data',
  PROVEN_UNREACHABLE: 'proven-unreachable',
});

const toGlobal = (cx, cy, lx, ly) => ({
  wx: cx * CHUNK_SIZE + lx,
  wy: cy * CHUNK_SIZE + ly,
  cx,
  cy,
  lx,
  ly,
});

const edgeKey = (portalId, sideA, sideB) =>
  `${portalId}@${chunkId(sideA.cx, sideA.cy)}:${chunkId(sideB.cx, sideB.cy)}`;

// 某一次区域载入上的边（两侧锚点 + 净空），作为确认/撤销的最小单位。
function makeEdge(portal, sideA, sideB, radius) {
  return {
    key: edgeKey(portal.id, sideA, sideB),
    portalId: portal.id,
    portal,
    a: { cx: sideA.cx, cy: sideA.cy },
    b: { cx: sideB.cx, cy: sideB.cy },
    radius,
    instanceIds: {},
    status: 'queued',
    reason: null,
  };
}

// 这个侧节点在当前区域注册表（含换门载入）里还是不是本次载入该侧的门。
function isLiveEdge(edge, registryFor, world) {
  const regA = registryFor(edge.a.cx, edge.a.cy);
  const regB = registryFor(edge.b.cx, edge.b.cy);
  if (!regA.includes(edge.portalId) || !regB.includes(edge.portalId)) return false;
  const portal = world.getPortal(edge.portalId);
  return Boolean(portal);
}

export class HierarchicalPlanner {
  constructor(world, store) {
    this.world = world;
    this.store = store;
    this.fine = new FinePlanner(world, store);
    this.reset();
  }

  reset() {
    // 全新会话/世界重建：连区域载入代次与换门注册表一并清空。
    this.resetPlanState();
    this.resetRegionTracking();
  }

  // 只清空这一次求路的规划状态，保留区域载入代次与换门注册表：
  // 玩家取消后再重新打开路线时，必须沿用当前驻留的那一次载入，
  // 不能退回旧门登记（否则同名区域换门后会借到旧门）。
  resetPlanState() {
    this.state = PlanState.IDLE;
    this.radius = 0;
    this.start = null;
    this.startRef = null;
    this.goal = null;
    this.legs = [];
    this.doneLegs = [];
    // 已被精细层“证实不可达”的门（会从粗层边撤下并重搜）。
    this.blockedEdgeKeys = new Set();
    // 各区域在当前代次上“正在等数据”的门（pending，不是不可达）。
    this.pendingEdgesByRegion = new Map();
    // 各区域上一次驻留实例里已经确认的边，用于区分“仍有效”与“已撤销”。
    this.confirmedEdgesByRegion = new Map();
    this.coarseRoute = null;
    this.coarseAttempts = 0;
    this.unreachableReason = null;
    this.lastFineResult = null;
    this.cancelled = false;
    this._registryOverride = null;
  }

  resetRegionTracking() {
    // 区域载入代次：同名区域换门重载时递增，旧代次上的确认全部作废。
    this.regionEpoch = new Map();
    // 每一代的换门注册表：`${epoch}:${chunkKey}` -> portal[]。
    this.regionRegistries = new Map();
    // 粗层宏观连通、但精细细节揭示后暂时封闭的门：
    // regionKey -> Set(portalId)。只影响该区域的这次载入，不删粗层登记。
    this.closedEdges = new Map();
    // 已从当前规划撤下的区域（不再重新载入，旧细化结果不得生效）。
    this.droppedRegions = new Set();
  }

  // ---------- 载入代次与换门注册表 ----------

  epochOf(cx, cy) {
    return this.regionEpoch.get(chunkId(cx, cy)) ?? 0;
  }

  // 为同名区域开启新一次载入（换一组门或换一份局部数据）。
  // 旧代次的确认与等待随即作废；该区域在途的旧细化在提交时被丢弃。
  beginRegionReload(cx, cy, portals = null) {
    const key = chunkId(cx, cy);
    const next = this.epochOf(cx, cy) + 1;
    this.regionEpoch.set(key, next);
    if (portals) this.regionRegistries.set(`${next}:${key}`, portals);
    this.pendingEdgesByRegion.delete(key);
    this.confirmedEdgesByRegion.delete(key);
    this.droppedRegions.delete(key);
    return next;
  }

  // 当前代次下该区域实际登记（本次载入）的门。
  regionPortals(cx, cy) {
    const epoch = this.epochOf(cx, cy);
    const override = this.regionRegistries.get(`${epoch}:${chunkId(cx, cy)}`);
    if (override) return override;
    return this.world.chunkPortals(cx, cy);
  }

  // 让模拟的“环节预约系统”收到撤销：区域边被证伪/卸载/取消时，
  // 撤销这次载入在渡台席位上已经预占的位置，避免复用到旧位。
  releaseEdges(store, edges, reason) {
    const sink = store?.seats?.releaseEdge;
    for (const edge of edges) {
      if (typeof sink === 'function') sink.call(store.seats, edge, reason);
    }
  }

  // ---------- 规划 ----------

  plan(start, goal, radius = 0, { regionPortals } = {}) {
    this.resetPlanState();
    this.radius = radius;
    this.start = this._locate(start);
    this.startRef = { wx: this.start.wx, wy: this.start.wy };
    this.goal = this._locate(goal);
    // 玩家重新开始求路：之前撤下的区域重新可选。
    this.droppedRegions.clear();
    if (typeof regionPortals === 'function') {
      this._registryOverride = regionPortals;
    }
    this._runCoarse();
    return this.snapshot();
  }

  // 取消进行中的规划：撤销所有未走完的边预约，让旧区细化结果即使完成也不生效。
  cancel(reason = 'cancelled') {
    if (this.state === PlanState.IDLE) return this.snapshot();
    const pending = [...(this.pendingEdgesByRegion.values())].flat();
    this.releaseEdges(this.store, pending, reason);
    this.pendingEdgesByRegion.clear();
    this.confirmedEdgesByRegion.clear();
    this.legs = [];
    this.blockedEdgeKeys.clear();
    this.droppedRegions.clear();
    this.cancelled = true;
    this.state = PlanState.IDLE;
    this.unreachableReason = null;
    return this.snapshot();
  }

  _locate(p) {
    const loc = this.world.locate(p.wx, p.wy);
    return toGlobal(loc.cx, loc.cy, loc.lx, loc.ly);
  }

  _coarseGraph() {
    // 注册表按当前代次解析，保证换门重载后的粗层不再连接旧门。
    return new CoarseGraph(this.world, {
      regionPortals: (cx, cy) =>
        this._registryOverride
          ? this._registryOverride(cx, cy)
          : this.regionPortals(cx, cy),
    });
  }

  _runCoarse() {
    this.coarseAttempts++;
    const route = this._coarseGraph().findRouteAvoiding(
      this.start,
      this.goal,
      this._blockedPortalIds(),
    );
    if (!route.nodes) {
      this.state = PlanState.UNREACHABLE;
      this.unreachableReason = this.blockedEdgeKeys.size
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

  _blockedPortalIds() {
    return [...new Set([...this.blockedEdgeKeys].map((k) => k.split('@')[0]))];
  }

  // 兼容旧调用：以门户粒度汇总当前已证实不可达的边。
  get blockedPortalIds() {
    return new Set(this._blockedPortalIds());
  }

  // 当前代次下该区域有效登记的门（含换门重载）。
  _livePortals(cx, cy) {
    if (this._registryOverride) return this._registryOverride(cx, cy);
    return this.regionPortals(cx, cy);
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

  // 精细层锚点（向块内退两格），供块内寻路与跨门检查使用。
  _fineSideGlobal(portal, side) {
    const fine = this.world.fineAnchor(portal, side.cx, side.cy);
    return toGlobal(side.cx, side.cy, fine.lx, fine.ly);
  }

  _buildLegs(portalIds) {
    const legs = [];
    let cur = this.start;

    for (const id of portalIds) {
      const portal = this.world.getPortal(id);
      const entry = [portal.a, portal.b].find(
        (s) => s.cx === cur.cx && s.cy === cur.cy,
      );
      const exit = entry === portal.a ? portal.b : portal.a;
      const entryPt = this._fineSideGlobal(portal, entry);
      const exitPt = this._fineSideGlobal(portal, exit);
      const edge = makeEdge(portal, portal.a, portal.b, this.radius);
      edge.key = edgeKey(portal.id, entry, exit);

      legs.push({
        id: `L${legs.length}`,
        type: 'move',
        status: LegStatus.QUEUED,
        chunk: { cx: cur.cx, cy: cur.cy },
        from: cur,
        to: entryPt,
        portalId: id,
        edgeKey: edge.key,
        edge,
        localPath: null,
        fineCost: null,
        detail: null,
      });
      legs.push({
        id: `L${legs.length}`,
        type: 'cross',
        status: LegStatus.QUEUED,
        portalId: id,
        edgeKey: edge.key,
        edge,
        from: entryPt,
        to: exitPt,
        detail: null,
      });
      cur = exitPt;
    }

    legs.push({
      id: `L${legs.length}`,
      type: 'move',
      status: LegStatus.QUEUED,
      chunk: { cx: cur.cx, cy: cur.cy },
      from: cur,
      to: this.goal,
      portalId: null,
      edgeKey: null,
      edge: null,
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

  _regionEpochFor(cx, cy) {
    return this.epochOf(cx, cy);
  }

  _neededRegions(leg) {
    if (leg.type === 'move') return [{ cx: leg.chunk.cx, cy: leg.chunk.cy }];
    return [
      { cx: leg.from.cx, cy: leg.from.cy },
      { cx: leg.to.cx, cy: leg.to.cy },
    ];
  }

  _loadRegion(c, tick) {
    const key = chunkId(c.cx, c.cy);
    const closed = this.closedEdges.get(key);
    return this.store.loadRegion(c.cx, c.cy, {
      portals: this._livePortals(c.cx, c.cy),
      dataVersion: this._regionEpochFor(c.cx, c.cy),
      tick,
      closedPortalIds: closed ? [...closed] : undefined,
    });
  }

  // 宏观连通、细节揭示后暂时封闭某区域的一个出口。
  // 粗层仍把它当候选；精细载入时该门被砌死，规划器据实证伪并回溯。
  closeEdgeDetail(cx, cy, portalId) {
    const key = chunkId(cx, cy);
    if (!this.closedEdges.has(key)) this.closedEdges.set(key, new Set());
    this.closedEdges.get(key).add(portalId);
  }

  // 每个模拟 tick 调用一次：加载所需块并精细确认下一段。
  async processTick(tick) {
    if (this.state !== PlanState.SEEKING) return;
    const leg = this._firstPending();
    if (!leg) return;

    const needed = this._neededRegions(leg);
    // 玩家已从规划里撤下的区域不再载入：该段保持“等数据”，旧细化不会生效。
    if (needed.some((c) => this.droppedRegions.has(chunkId(c.cx, c.cy)))) {
      leg.status = LegStatus.AWAITING_DATA;
      leg.detail = 'region-dropped-from-plan';
      return;
    }
    const before = needed.map((c) => this.store.regionMeta(c.cx, c.cy));
    await Promise.all(needed.map((c) => this._loadRegion(c, tick)));

    // 载入完成期间规划可能已被取消或换门；旧结果不得生效。
    if (this.cancelled || this.state !== PlanState.SEEKING) return;
    if (!this.legs.includes(leg)) return;

    const metas = needed.map((c) => this.store.regionMeta(c.cx, c.cy));
    const allResident = metas.every((m) => m !== null);
    const anyFresh = metas.some((m) => m === null) || before.some((m) => m === null);
    if (!allResident) {
      leg.status = LegStatus.AWAITING_DATA;
      return;
    }
    // 与前一次驻留实例比对：同一次载入才允许沿用此前的确认。
    const changed = metas.some(
      (m) => m.instanceId !== (leg.seenInstances?.[chunkId(m.cx, m.cy)] ?? null),
    );
    leg.seenInstances = Object.fromEntries(
      metas.map((m) => [chunkId(m.cx, m.cy), m.instanceId]),
    );

    // 第一次拿到数据：本 tick 只标“缺少数据”，下一 tick 再做精细确认。
    if (anyFresh || changed) {
      leg.status = LegStatus.AWAITING_DATA;
      this._markPending(leg, metas);
      this._preloadNext(leg, tick);
      return;
    }

    if (leg.type === 'cross') {
      const portal = this.world.getPortal(leg.portalId);
      const live = (cx, cy) => this.regionPortals(cx, cy).map((p) => p.id);
      // 必须同时满足：该门仍在当前代次注册表内，且本次驻留数据的实际开放集合包含它。
      const openLive = (cx, cy) => this.store.get(cx, cy)?.portalIds ?? [];
      if (
        !isLiveEdge(leg.edge, live, this.world)
        || !openLive(leg.from.cx, leg.from.cy).includes(portal.id)
        || !openLive(leg.to.cx, leg.to.cy).includes(portal.id)
      ) {
        // 这次载入里根本没有这道门（换门重载或细节封闭）：旧边不能穿过。
        this._rejectEdge(leg.edge, 'edge-not-in-this-region-load');
        return;
      }
      const okFrom = this.fine.portalPassable(portal, leg.from.cx, leg.from.cy, this.radius, {
        instanceId: metas.find((m) => m.cx === leg.from.cx && m.cy === leg.from.cy).instanceId,
      });
      const okTo = this.fine.portalPassable(portal, leg.to.cx, leg.to.cy, this.radius, {
        instanceId: metas.find((m) => m.cx === leg.to.cx && m.cy === leg.to.cy).instanceId,
      });
      if (okFrom && okTo) {
        this._confirmEdge(leg, metas, 'fine-clearance-verified');
      } else {
        this._rejectEdge(leg.edge, 'portal-blocked-for-character-size');
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
        if (leg.portalId) {
          this._rejectEdge(leg.edge, result.reason);
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

  _markPending(leg, metas) {
    if (!leg.edgeKey) return;
    const key = leg.edgeKey;
    const entry = leg.edge;
    entry.instanceIds = Object.fromEntries(metas.map((m) => [chunkId(m.cx, m.cy), m.instanceId]));
    entry.status = 'awaiting-data';
    for (const m of metas) {
      const rk = chunkId(m.cx, m.cy);
      if (!this.pendingEdgesByRegion.has(rk)) this.pendingEdgesByRegion.set(rk, []);
      if (!this.pendingEdgesByRegion.get(rk).some((e) => e.key === key)) {
        this.pendingEdgesByRegion.get(rk).push(entry);
      }
    }
    // 等待数据不是不可达：向渡台席位系统发出新预约，占用本次载入的席位。
    const regionKey = chunkId(leg.from.cx, leg.from.cy);
    const seatEpoch = this.regionEpoch.get(regionKey) ?? 0;
    const sink = this.store?.seats?.reserveEdge;
    if (typeof sink === 'function') {
      sink.call(this.store.seats, entry, { epoch: seatEpoch, legId: leg.id });
    }
  }

  _confirmEdge(leg, metas, detail) {
    const entry = leg.edge;
    entry.status = 'confirmed';
    entry.instanceIds = Object.fromEntries(
      metas.map((m) => [chunkId(m.cx, m.cy), m.instanceId]),
    );
    leg.status = LegStatus.CONFIRMED;
    leg.detail = detail;
    for (const arr of this.pendingEdgesByRegion.values()) {
      const i = arr.findIndex((e) => e.key === entry.key);
      if (i >= 0) arr.splice(i, 1);
    }
    const sink = this.store?.seats?.commitEdge;
    if (typeof sink === 'function') sink.call(this.store.seats, entry);
    for (const m of metas) {
      const rk = chunkId(m.cx, m.cy);
      if (!this.confirmedEdgesByRegion.has(rk)) this.confirmedEdgesByRegion.set(rk, []);
      const list = this.confirmedEdgesByRegion.get(rk);
      if (!list.some((e) => e.key === entry.key)) list.push(entry);
    }
  }

  _preloadNext(leg, tick) {
    const idx = this.legs.indexOf(leg);
    const next = this.legs[idx + 1];
    if (!next) return;
    for (const c of this._neededRegions(next)) {
      if (this.store.regionMeta(c.cx, c.cy) === null) {
        this._loadRegion(c, tick).catch(() => {});
      }
    }
  }

  // 玩家改变主意（例如改去西侧区域）：从当前规划里卸载某区域，
  // 该区域的席位于此前一次撤销，且后续 tick 不再重新载入它，
  // 让它还在途的旧细化即使完成也不会被采用。
  dropRegionFromPlan(cx, cy) {
    const key = chunkId(cx, cy);
    const pending = this.pendingEdgesByRegion.get(key) ?? [];
    this.releaseEdges(this.store, pending, 'region-dropped-from-plan');
    this.pendingEdgesByRegion.delete(key);
    this.confirmedEdgesByRegion.delete(key);
    for (const leg of this.legs) {
      if (leg.status === LegStatus.CONFIRMED || leg.status === LegStatus.AWAITING_DATA) {
        const touches = leg.type === 'move'
          ? chunkId(leg.chunk.cx, leg.chunk.cy) === key
          : chunkId(leg.from.cx, leg.from.cy) === key || chunkId(leg.to.cx, leg.to.cy) === key;
        if (touches) {
          leg.status = LegStatus.QUEUED;
          leg.localPath = null;
          leg.fineCost = null;
          leg.detail = 'dropped-region-will-be-replanned';
        }
      }
    }
    this.droppedRegions.add(key);
    this.store.unload(cx, cy);
  }

  // 已被精细层“证实不可达”的边：从粗层撤下并回溯重搜。
  _rejectEdge(edge, reason) {
    if (!edge) return;
    this.blockedEdgeKeys.add(edge.key);
    this.releaseEdges(this.store, [edge], reason);
    for (const arr of this.pendingEdgesByRegion.values()) {
      const i = arr.findIndex((e) => e.key === edge.key);
      if (i >= 0) arr.splice(i, 1);
    }
    for (const leg of this.legs) {
      if (leg.edgeKey === edge.key) {
        leg.status = LegStatus.BLOCKED;
        leg.detail = reason;
      }
    }
    const kept = this.legs.filter((l) => l.status === LegStatus.DONE);
    this.doneLegs.push(...kept);
    this.legs = [];
    this.start = this._locate(this.startRef);
    this._runCoarse();
  }

  // 模拟移动后回报位置：推进段的完成状态。
  updatePosition(wx, wy) {
    this.startRef = { wx, wy };
    const leg = this.legs.find(
      (l) => l.status !== LegStatus.DONE && l.status !== LegStatus.BLOCKED,
    );
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
        if (last.wx !== leg.to.wx || last.wy !== leg.to.wy) {
          out.push({ wx: leg.to.wx, wy: leg.to.wy });
        }
      }
    }
    return out;
  }

  // 调用者用来区分“正在等局部数据”与“已证实不可达”。
  // seeking + 有待处理段：pending-data；unreachable：proven-unreachable；其余 null。
  outcome() {
    if (this.state === PlanState.UNREACHABLE) {
      return { kind: PlanOutcome.PROVEN_UNREACHABLE, reason: this.unreachableReason };
    }
    if (this.state === PlanState.SEEKING) {
      const pending = this._firstPending();
      const blocked = this.legs.some((l) => l.status === LegStatus.BLOCKED);
      if (pending || blocked) {
        return {
          kind: PlanOutcome.PENDING_DATA,
          reason: pending ? pending.status : 'leg-blocked-but-replanning',
        };
      }
    }
    return null;
  }

  // 地图用：承诺路线（当前粗层候选，含尚在等数据的边）与
  // 已撤销路线（本次已证实不可达、已从粗层撤下的边）分开呈现。
  mapRoutes() {
    const promisedPortals = this.coarseRoute?.rejected ? [] : this.coarseRoute?.portals ?? [];
    const promised = new Set(promisedPortals);
    const revoked = [];
    const seen = new Set();
    for (const key of this.blockedEdgeKeys) {
      const portalId = key.split('@')[0];
      if (promised.has(portalId) || seen.has(portalId)) continue;
      seen.add(portalId);
      const portal = this.world.getPortal(portalId);
      if (portal) revoked.push({ portalId, polyline: [this._sideGlobal(portal.a), this._sideGlobal(portal.b)] });
    }
    return { promisedPortals, promisedPolyline: this.coarseRoute?.polyline ?? [], revoked };
  }

  // 界面用：驻留区某次载入上，确认结果哪些仍有效、哪些已撤销。
  confirmedEdgeReport() {
    const out = [];
    for (const [rk, edges] of this.confirmedEdgesByRegion) {
      const [cx, cy] = rk.split(',').map(Number);
      const meta = this.store.regionMeta(cx, cy);
      for (const edge of edges) {
        const valid = meta && meta.instanceId === edge.instanceIds[rk];
        out.push({ region: rk, portalId: edge.portalId, valid, reason: valid ? 'current-load' : 'revoked-by-unload-or-reload' });
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
      blockedEdgeKeys: [...this.blockedEdgeKeys],
      blockedPortalIds: this._blockedPortalIds(),      unreachableReason: this.unreachableReason,
      outcome: this.outcome(),
      legs: this.legs.map((l) => ({
        id: l.id,
        type: l.type,
        status: l.status,
        chunk: l.chunk ? chunkId(l.chunk.cx, l.chunk.cy) : null,
        from: { wx: l.from.wx, wy: l.from.wy },
        to: { wx: l.to.wx, wy: l.to.wy },
        portalId: l.portalId,
        edgeKey: l.edgeKey,
        edgeStatus: l.edge ? l.edge.status : null,
        fineCost: l.fineCost ?? null,
        detail: l.detail,
        path: l.localPath ? l.localPath.map((p) => ({ wx: p.wx, wy: p.wy })) : null,
      })),
      doneLegs: this.doneLegs.map((l) => l.id),
      confirmedPath: this.currentConfirmedPath(),
      map: this.mapRoutes(),
    };
  }
}
