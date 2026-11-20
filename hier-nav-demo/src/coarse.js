// 粗层（高层）区域连接图：只依赖门户登记信息构建，
// 不读取任何精细分块网格。门户被拆成两个"侧节点"，
// 两侧节点之间的边代表穿越门户，代价取门户的粗层估计值。
// 粗层结论只是候选通道；精细层可能判定其对当前角色不可通行。

import { graphAstar, manhattan } from './astar.js';
import { chunkId, CHUNK_SIZE } from './world.js';

export const SIDE = {
  start: 'START',
  goal: 'GOAL',
};

export function sideNodeId(portalId, cx, cy) {
  return `${portalId}@${chunkId(cx, cy)}`;
}

export class CoarseGraph {
  constructor(world) {
    this.world = world;
    this.adj = new Map(); // nodeId -> [{node, cost, meta}]
    this.pos = new Map(); // nodeId -> {x, y} 全局网格坐标
    this.portalOf = new Map(); // sideNodeId -> portalId
    this._build();
  }

  _addEdge(a, b, cost, meta = {}) {
    if (!this.adj.has(a)) this.adj.set(a, []);
    if (!this.adj.has(b)) this.adj.set(b, []);
    this.adj.get(a).push({ node: b, cost, ...meta });
    this.adj.get(b).push({ node: a, cost, ...meta });
  }

  _global(side) {
    return { x: side.cx * CHUNK_SIZE + side.lx, y: side.cy * CHUNK_SIZE + side.ly };
  }

  _build() {
    const w = this.world;
    // 门户侧节点 + 穿越边
    for (const portal of w.portals.values()) {
      const idA = sideNodeId(portal.id, portal.a.cx, portal.a.cy);
      const idB = sideNodeId(portal.id, portal.b.cx, portal.b.cy);
      this.pos.set(idA, this._global(portal.a));
      this.pos.set(idB, this._global(portal.b));
      this.portalOf.set(idA, portal.id);
      this.portalOf.set(idB, portal.id);
      this._addEdge(idA, idB, portal.estCost, { kind: 'portal', portalId: portal.id });
    }
    // 每个块内：门户侧节点两两相连，代价为锚点曼哈顿距离（粗估计）
    for (let cx = 0; cx < w.cols; cx++) {
      for (let cy = 0; cy < w.rows; cy++) {
        const sides = w.chunkPortals(cx, cy).map((p) => {
          const anchor = w.portalAnchor(p, cx, cy);
          return {
            id: sideNodeId(p.id, cx, cy),
            x: cx * CHUNK_SIZE + anchor.lx,
            y: cy * CHUNK_SIZE + anchor.ly,
          };
        });
        for (let i = 0; i < sides.length; i++) {
          for (let j = i + 1; j < sides.length; j++) {
            const cost = manhattan(sides[i].x, sides[i].y, sides[j].x, sides[j].y);
            this._addEdge(sides[i].id, sides[j].id, cost, { kind: 'intra-chunk' });
          }
        }
      }
    }
  }

  // start/goal: {wx, wy, cx, cy}
  findRoute(start, goal) {
    const w = this.world;
    if (!w.inBounds(start.cx, start.cy) || !w.inBounds(goal.cx, goal.cy)) {
      return { portals: [], nodes: null, cost: Infinity, reason: 'out-of-world' };
    }
    const startId = SIDE.start;
    const goalId = SIDE.goal;
    this.adj.set(startId, []);
    this.adj.set(goalId, []);
    this.pos.set(startId, { x: start.wx, y: start.wy });
    this.pos.set(goalId, { x: goal.wx, y: goal.wy });

    const linkVirtual = (vId, loc) => {
      for (const p of w.chunkPortals(loc.cx, loc.cy)) {
        const anchor = w.portalAnchor(p, loc.cx, loc.cy);
        const sid = sideNodeId(p.id, loc.cx, loc.cy);
        const gx = loc.cx * CHUNK_SIZE + anchor.lx;
        const gy = loc.cy * CHUNK_SIZE + anchor.ly;
        this._addEdge(vId, sid, manhattan(loc.wx, loc.wy, gx, gy), { kind: 'virtual' });
      }
    };
    linkVirtual(startId, start);
    linkVirtual(goalId, goal);

    const result = graphAstar(
      startId,
      goalId,
      (node) => this.adj.get(node) ?? [],
      (a, b) => manhattan(this.pos.get(a).x, this.pos.get(a).y, this.pos.get(b).x, this.pos.get(b).y),
    );

    // 解析出门户穿越序列：只有 portal 类型的边才算穿越
    const portals = [];
    if (result.nodes) {
      for (let i = 0; i < result.nodes.length - 1; i++) {
        const edge = (this.adj.get(result.nodes[i]) ?? []).find(
          (e) => e.node === result.nodes[i + 1],
        );
        if (edge && edge.kind === 'portal') portals.push(edge.portalId);
      }
    }
    // 清理虚拟节点，保证图可复用
    for (const n of [startId, goalId]) {
      for (const [, edges] of this.adj) {
        for (let k = edges.length - 1; k >= 0; k--) {
          if (edges[k].node === n) edges.splice(k, 1);
        }
      }
      this.adj.delete(n);
      this.pos.delete(n);
    }
    return {
      portals,
      nodes: result.nodes,
      cost: result.cost,
      reason: result.nodes ? null : 'coarse-unreachable',
      expanded: result.expanded,
    };
  }

  // 排除一组已被精细层证伪的门户后重新搜索（回溯修正）。
  findRouteAvoiding(start, goal, blockedPortalIds) {
    const blocked = new Set(blockedPortalIds);
    const original = this.adj;
    const filtered = new Map();
    for (const [node, edges] of original) {
      filtered.set(
        node,
        edges.filter((e) => !(e.kind === 'portal' && blocked.has(e.portalId))),
      );
    }
    const saved = this.adj;
    this.adj = filtered;
    try {
      return this.findRoute(start, goal);
    } finally {
      this.adj = saved;
    }
  }
}
