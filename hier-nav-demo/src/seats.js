// 渡台席位预约系统：把“某次区域载入的可行边”表达成一次登台预约。
//
// 一条预约绑定 (区域, 门, 载入代次, 载入实例)。关键约束：
//   - 已预约东门班次后，同名区域卸载再以同名出口重载，会得到新的代次/实例，
//     旧席位绝不能被继承——复用同名出口必须重新预约。
//   - 撤销（精细证伪、卸载、取消）必须真正把席位放回，候补才能登台。
//   - 正在等局部数据的边持有“候补/已预约”席位，但它不是不可达；
//     只有被证实不可达并被撤销时席位才释放。
//
// 该类不涉及寻路，只是可观察的预约台账，供规划器调用与测试核对。

export const SeatStage = Object.freeze({
  WAITLIST: 'waitlist', // 候补：已排队，尚未占位
  RESERVED: 'reserved', // 已预约，等局部数据确认
  CONFIRMED: 'confirmed', // 精细确认通过，占定席位
  RELEASED: 'released', // 已释放（撤销/卸载/取消）
});

let seq = 0;

export class SeatReservationSystem {
  constructor({ capacity = 4 } = {}) {
    this.tickets = new Map(); // ticketId -> ticket
    this.order = []; // 预约/候补/释放事件
    this.capacity = capacity;
  }

  _ticket(edge, { epoch = 0, instanceIds = null, legId = null } = {}) {
    return {
      id: `T${++seq}`,
      edgeKey: edge.key,
      portalId: edge.portalId,
      a: { ...edge.a },
      b: { ...edge.b },
      epoch,
      instanceIds: instanceIds ? { ...instanceIds } : { ...edge.instanceIds },
      legId,
      stage: SeatStage.WAITLIST,
      reason: null,
    };
  }

  _log(ticket, action) {
    this.order.push({ action, ticketId: ticket.id, edgeKey: ticket.edgeKey, stage: ticket.stage, reason: ticket.reason });
  }

  // 预约台账的事件流水（候补/预约/登台/确认/撤销）。
  get log() {
    return this.order;
  }

  // 候补：角色尝试登台，先排在候补席位上。
  enqueue(edge, opts = {}) {
    const t = this._ticket(edge, opts);
    t.stage = SeatStage.WAITLIST;
    this.tickets.set(t.id, t);
    this._log(t, 'enqueue');
    return t;
  }

  findActive(edgeKey, epoch = null) {
    for (const t of this.tickets.values()) {
      if (t.edgeKey !== edgeKey) continue;
      if (epoch !== null && t.epoch !== epoch) continue;
      if (t.stage === SeatStage.RELEASED) continue;
      return t;
    }
    return null;
  }

  // 为这次载入预约一个席位。若同名边此前在别的代次预约过，
  // 旧预约保持原样（不会被继承），这里建立的是新代次的独立席位。
  reserveEdge(edge, { epoch = 0, legId = null } = {}) {
    const existing = this.findActive(edge.key, epoch);
    if (existing && existing.stage !== SeatStage.WAITLIST) return existing;
    const t = existing ?? this._ticket(edge, { epoch, legId });
    if (!existing) this.tickets.set(t.id, t);
    t.stage = SeatStage.RESERVED;
    t.epoch = epoch;
    t.instanceIds = { ...edge.instanceIds };
    t.legId = legId ?? t.legId;
    t.reason = null;
    this._log(t, 'reserve');
    return t;
  }

  // 候补晋升为已预约（角色抢到本次载入的席位）。
  board(ticket) {
    if (ticket.stage === SeatStage.RELEASED) return ticket;
    ticket.stage = SeatStage.RESERVED;
    this._log(ticket, 'board');
    return ticket;
  }

  commitEdge(edge) {
    const t = this.findActive(edge.key);
    if (!t) return this.reserveEdge(edge, { epoch: 0 });
    t.stage = SeatStage.CONFIRMED;
    t.instanceIds = { ...edge.instanceIds };
    t.reason = null;
    this._log(t, 'commit');
    return t;
  }

  // 撤销一条边在这次载入上的预约。返回被释放的票（可能为 null）。
  releaseEdge(edge, reason = 'released') {
    const t = this.findActive(edge.key);
    if (!t) {
      const t2 = this._ticket(edge);
      t2.reason = reason;
      t2.stage = SeatStage.RELEASED;
      this.tickets.set(t2.id, t2);
      this._log(t2, 'release');
      return t2;
    }
    t.stage = SeatStage.RELEASED;
    t.reason = reason;
    this._log(t, 'release');
    return t;
  }

  // 卸载/重载整个区域：撤销该区域相关的所有活跃席位。
  releaseRegion(regionKey, reason = 'region-unloaded') {
    const released = [];
    for (const t of this.tickets.values()) {
      if (t.stage === SeatStage.RELEASED) continue;
      if (this._touches(t, regionKey)) {
        t.stage = SeatStage.RELEASED;
        t.reason = reason;
        this._log(t, 'release');
        released.push(t);
      }
    }
    return released;
  }

  _touches(ticket, regionKey) {
    const keyOf = (side) => `${side.cx},${side.cy}`;
    return keyOf(ticket.a) === regionKey || keyOf(ticket.b) === regionKey;
  }

  // 仍在占位的席位（已预约/已确认）。候补尚未占位，不计入占用，
  // 因此撤销一个预约后占用数确实下降，候补才有位置登台。
  activeTickets() {
    return [...this.tickets.values()].filter(
      (t) => t.stage === SeatStage.RESERVED || t.stage === SeatStage.CONFIRMED,
    );
  }

  occupiedCount() {
    return this.activeTickets().length;
  }

  waitlistCount() {
    return [...this.tickets.values()].filter((t) => t.stage === SeatStage.WAITLIST).length;
  }

  // 候补角色尝试登台：仅在仍有空位时晋升为已预约。
  tryBoardFromWaitlist(edgeKey, epoch = null) {
    const t = this.findActive(edgeKey, epoch);
    if (!t || t.stage !== SeatStage.WAITLIST) return null;
    if (this.occupiedCount() >= this.capacity) return null;
    return this.board(t);
  }

  stageOf(edgeKey, epoch = null) {
    const t = this.findActive(edgeKey, epoch);
    return t ? t.stage : null;
  }

  snapshot() {
    return {
      occupancy: this.occupiedCount(),      tickets: [...this.tickets.values()].map((t) => ({
        id: t.id,
        edgeKey: t.edgeKey,
        portalId: t.portalId,
        epoch: t.epoch,
        stage: t.stage,
        reason: t.reason,
        legId: t.legId,
      })),
      log: [...this.order],
    };
  }
}

// 每张票的序号在进程内单调，便于测试核对票不重复。
export function resetSeatSequence() {
  seq = 0;
}
