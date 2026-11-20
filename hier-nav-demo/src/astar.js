// 通用四方向网格 A*，支持角色占地尺寸（footprintRadius）。
// footprintRadius = r 表示角色占据 (2r+1)x(2r+1) 的方格，
// 中心格可通行当且仅当其周围切比雪夫距离 <= r 的格子全部为空地。

export class MinHeap {
  constructor() {
    this.a = [];
  }
  get size() {
    return this.a.length;
  }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function manhattan(ax, ay, bx, by) {
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

// 判定以 (cx,cy) 为中心放置尺寸 r 的角色是否完全落在空地上。
export function fits(grid, n, cx, cy, r) {
  if (cx - r < 0 || cy - r < 0 || cx + r >= n || cy + r >= n) return false;
  for (let dy = -r; dy <= r; dy++) {
    const row = (cy + dy) * n;
    for (let dx = -r; dx <= r; dx++) {
      if (grid[row + (cx + dx)] === 1) return false;
    }
  }
  return true;
}

// 网格 A*。start/goal 为 {x,y}，要求两格本身可容纳角色。
// 返回 { path:[{x,y}...], cost, expanded } 或 { path:null, reason, expanded }。
export function gridAstar(grid, n, start, goal, r = 0, { maxExpansions = 20000 } = {}) {
  if (!fits(grid, n, start.x, start.y, r)) {
    return { path: null, reason: 'start-blocked', expanded: 0 };
  }
  if (!fits(grid, n, goal.x, goal.y, r)) {
    return { path: null, reason: 'goal-blocked', expanded: 0 };
  }
  const key = (x, y) => y * n + x;
  const gScore = new Map();
  const came = new Map();
  const closed = new Set();
  const heap = new MinHeap();
  const sk = key(start.x, start.y);
  gScore.set(sk, 0);
  heap.push({ x: start.x, y: start.y, f: manhattan(start.x, start.y, goal.x, goal.y) });
  let expanded = 0;

  while (heap.size) {
    const cur = heap.pop();
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);
    expanded++;
    if (expanded > maxExpansions) return { path: null, reason: 'search-limit', expanded };
    if (cur.x === goal.x && cur.y === goal.y) {
      const path = [];
      let k = ck;
      let x = cur.x;
      let y = cur.y;
      while (k !== sk) {
        path.push({ x, y });
        const p = came.get(k);
        k = p[0];
        x = p[1];
        y = p[2];
      }
      path.push({ x: start.x, y: start.y });
      path.reverse();
      return { path, cost: gScore.get(ck), expanded };
    }
    const g = gScore.get(ck);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!fits(grid, n, nx, ny, r)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const ng = g + 1;
      if (ng < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, ng);
        came.set(nk, [ck, nx, ny]);
        heap.push({ x: nx, y: ny, f: ng + manhattan(nx, ny, goal.x, goal.y) });
      }
    }
  }
  return { path: null, reason: 'no-route-in-chunk', expanded };
}

// 任意节点图上的 A*（用于粗层区域-门户图）。
// neighbors(node) -> [{node, cost}]；heuristic(a,b) -> number。
export function graphAstar(startNode, goalNode, neighbors, heuristic) {
  const gScore = new Map([[startNode, 0]]);
  const came = new Map();
  const closed = new Set();
  const heap = new MinHeap();
  heap.push({ node: startNode, f: heuristic(startNode, goalNode) });
  let expanded = 0;

  while (heap.size) {
    const { node } = heap.pop();
    if (closed.has(node)) continue;
    closed.add(node);
    expanded++;
    if (node === goalNode) {
      const nodes = [];
      let cur = node;
      while (cur !== undefined) {
        nodes.push(cur);
        cur = came.get(cur);
      }
      nodes.reverse();
      return { nodes, cost: gScore.get(goalNode), expanded };
    }
    const g = gScore.get(node);
    for (const edge of neighbors(node)) {
      if (closed.has(edge.node)) continue;
      const ng = g + edge.cost;
      if (ng < (gScore.get(edge.node) ?? Infinity)) {
        gScore.set(edge.node, ng);
        came.set(edge.node, node);
        heap.push({ node: edge.node, f: ng + heuristic(edge.node, goalNode) });
      }
    }
  }
  return { nodes: null, cost: Infinity, expanded };
}
