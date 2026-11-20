// 精细层：在单个已驻留块内做网格级局部寻路与门户净空核验。
// 所有函数都要求块数据已经驻留内存；未驻留时直接报错，
// 由上层规划器先发起真实加载，而不是假设地形可通行。

import { gridAstar, fits } from './astar.js';

export class FinePlanner {
  constructor(world, store) {
    this.world = world;
    this.store = store;
  }

  _requireResident(cx, cy) {
    const data = this.store.get(cx, cy);
    if (!data) {
      const err = new Error(`chunk ${cx},${cy} not resident`);
      err.code = 'NOT_RESIDENT';
      throw err;
    }
    return data;
  }

  // 门户在精细层是否真正开放且容纳得下指定尺寸的角色。
  // 使用向内退一格的精细锚点，让有体积的角色完整落在块内空地上。
  portalPassable(portal, cx, cy, radius) {
    const data = this._requireResident(cx, cy);
    const anchor = this.world.fineAnchor(portal, cx, cy);
    if (!anchor) return false;
    return fits(data.grid, this.world.size, anchor.lx, anchor.ly, radius);
  }

  // 块内局部寻路。from/to 为块内局部坐标。
  planWithin(cx, cy, from, to, radius) {
    const data = this._requireResident(cx, cy);
    const n = this.world.size;
    const result = gridAstar(
      data.grid,
      n,
      { x: from.lx, y: from.ly },
      { x: to.lx, y: to.ly },
      radius,
    );
    if (!result.path) {
      return { ok: false, reason: result.reason, expanded: result.expanded };
    }
    return {
      ok: true,
      localPath: result.path.map((p) => ({ lx: p.x, ly: p.y })),
      cost: result.cost,
      expanded: result.expanded,
    };
  }
}
