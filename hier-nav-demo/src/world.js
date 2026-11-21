// 世界模型：由多个地形块（chunk）组成的连续世界。
// 关键约束：
//  - 每个块的外边界默认是墙，只有登记在册的门户（portal）开口可穿越，
//    因此跨块移动必须经过可核验身份的门户，不能从任意位置穿过边界。
//  - 门户在高层（粗层）只保存身份、位置、宽度与代价估计；
//    真正能否通过取决于精细层载入后的网格与角色尺寸。
//  - 程序化生成一条"近路"门户：粗层看起来最短，精细层被墙封死，
//    用于验证规划器必须回溯改走有效替代通道。

import { chunkRng } from './rng.js';

export const CHUNK_SIZE = 24;
export const MAX_CHARACTER_RADIUS = 1; // 演示角色最大占地半径（3x3）
const WALL = 1;
const OPEN = 0;

export function chunkId(cx, cy) {
  return `${cx},${cy}`;
}

// 门户开口沿边界的局部坐标区间，保证同一行/列上的开口互不重叠。
function pickIntervals(rng, count, forced) {
  const intervals = forced ? [forced] : [];
  let guard = 0;
  while (intervals.length < count + (forced ? 1 : 0) && guard < 200) {
    guard++;
    const width = 2 + Math.floor(rng() * 2); // 2 或 3 格宽
    const lo = 3 + Math.floor(rng() * (CHUNK_SIZE - 6 - width));
    const hi = lo + width - 1;
    const overlap = intervals.some((it) => !(hi + 2 < it.lo || lo > it.hi + 2));
    if (!overlap) intervals.push({ lo, hi, forced: false });
  }
  return intervals;
}

export class World {
  constructor({ cols = 5, rows = 5, seed = 'demo-world' } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.size = CHUNK_SIZE;
    this.seed = seed;
    this.portals = new Map(); // portalId -> portal
    this.portalsByChunk = new Map(); // chunkId -> portal[]
    this.shortcutPortalId = null;
    this._buildPortalRegistry();
  }

  get chunkCount() {
    return this.cols * this.rows;
  }

  worldWidth() {
    return this.cols * CHUNK_SIZE;
  }

  worldHeight() {
    return this.rows * CHUNK_SIZE;
  }

  inBounds(cx, cy) {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  // 全局网格坐标 -> 块坐标 + 块内局部坐标
  locate(wx, wy) {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    return { cx, cy, lx: wx - cx * CHUNK_SIZE, ly: wy - cy * CHUNK_SIZE };
  }

  _register(portal) {
    this.portals.set(portal.id, portal);
    for (const side of [portal.a, portal.b]) {
      const id = chunkId(side.cx, side.cy);
      if (!this.portalsByChunk.has(id)) this.portalsByChunk.set(id, []);
      this.portalsByChunk.get(id).push(portal);
    }
  }

  _buildPortalRegistry() {
    const rng = chunkRng(this.seed, -1, -1);
    // 近路：世界中部两列块之间的竖直边界、行向中点处的开口。
    const scLeft = Math.floor(this.cols / 2) - 1;
    const scRow = Math.floor(this.rows / 2);
    const shortcutBorder = { kind: 'V', fixed: scLeft, across: scRow };
    const scMid = Math.floor(CHUNK_SIZE / 2);
    const forcedInterval = { lo: scMid - 1, hi: scMid };

    // 竖直边界：左块 (cx,cy) 的东墙 <-> 右块 (cx+1,cy) 的西墙
    for (let cx = 0; cx < this.cols - 1; cx++) {
      for (let cy = 0; cy < this.rows; cy++) {
        const isShortcut = cx === shortcutBorder.fixed && cy === shortcutBorder.across;
        const intervals = pickIntervals(rng, 2, isShortcut ? forcedInterval : null);
        intervals.forEach((it, k) => {
          const mid = Math.floor((it.lo + it.hi) / 2);
          const width = it.hi - it.lo + 1;
          const isSc = isShortcut && it === forcedInterval;
          const id = `P-V${cx}-${cy}#${k}${isSc ? '-SC' : ''}`;
          this._register({
            id,
            kind: 'V',
            lo: it.lo,
            hi: it.hi,
            width,
            // 粗层代价估计只看几何，不含精细障碍信息。
            // 近路被人为标成“最省”的捷径，诱导粗层优先选择；
            // 它在精细层实际封死，规划器必须回溯——这正是演示的核心。
            estCost: isSc ? 2 : CHUNK_SIZE + 4 - width,
            claimedClearance: width,
            shortcut: isSc,
            a: { cx, cy, side: 'E', lx: CHUNK_SIZE - 1, ly: mid },
            b: { cx: cx + 1, cy, side: 'W', lx: 0, ly: mid },
          });
          if (isSc) this.shortcutPortalId = id;
        });
      }
    }

    // 水平边界：上块 (cx,cy) 的南墙 <-> 下块 (cx,cy+1) 的北墙
    for (let cy = 0; cy < this.rows - 1; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const intervals = pickIntervals(rng, 2, null);
        intervals.forEach((it, k) => {
          const mid = Math.floor((it.lo + it.hi) / 2);
          const width = it.hi - it.lo + 1;
          const id = `P-H${cx}-${cy}#${k}`;
          this._register({
            id,
            kind: 'H',
            lo: it.lo,
            hi: it.hi,
            width,
            estCost: CHUNK_SIZE + 4 - width,
            claimedClearance: width,
            shortcut: false,
            a: { cx, cy, side: 'S', lx: mid, ly: CHUNK_SIZE - 1 },
            b: { cx, cy: cy + 1, side: 'N', lx: mid, ly: 0 },
          });
        });
      }
    }
  }

  getPortal(id) {
    return this.portals.get(id);
  }

  chunkPortals(cx, cy) {
    return this.portalsByChunk.get(chunkId(cx, cy)) ?? [];
  }

  // 返回门户在指定块一侧的登记锚点（位于边界开口上，用于身份与绘制）。
  portalAnchor(portal, cx, cy) {
    for (const s of [portal.a, portal.b]) {
      if (s.cx === cx && s.cy === cy) return { lx: s.lx, ly: s.ly, side: s.side };
    }
    return null;
  }

  // 一次“实际移动”是否穿过了登记在册的边界门（用于检查不会借用旧门）。
  // 同块内移动不算跨边界；跨边界只能走登记门户，且必须落在该门开口区间内。
  classifyMove(fromWx, fromWy, toWx, toWy) {
    const a = this.locate(fromWx, fromWy);
    const b = this.locate(toWx, toWy);
    if (a.cx === b.cx && a.cy === b.cy) return { cross: false };
    if (Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy) !== 1) {
      return { cross: true, portal: null, valid: false };
    }
    const vertical = a.cx !== b.cx;
    const coord = vertical ? Math.min(a.ly, b.ly) : Math.min(a.lx, b.lx);
    // 相邻两块之间可能有多道门，必须找出开口真正覆盖这次穿越的门。
    const portal = this.chunkPortals(a.cx, a.cy).find((p) =>
      [p.a, p.b].some((s) => s.cx === b.cx && s.cy === b.cy)
      && coord >= p.lo && coord <= p.hi
      && (p.kind === 'V') === vertical);
    return { cross: true, portal: portal ?? null, valid: Boolean(portal) };
  }

  // 某次载入实际开放的门集合（区域数据只描述这一次载入）。
  openPortalIds(regionData) {
    if (!regionData) return null;
    const closed = new Set(regionData.closedPortalIds ?? []);
    return regionData.portalIds.filter((id) => !closed.has(id));
  }

  // 精细层锚点：从边界开口向块内退两格，使有体积的角色完整落在块内空地上。
  fineAnchor(portal, cx, cy) {
    const a = this.portalAnchor(portal, cx, cy);
    if (!a) return null;
    let { lx, ly } = a;
    if (a.side === 'E') lx -= 2;
    else if (a.side === 'W') lx += 2;
    else if (a.side === 'S') ly -= 2;
    else if (a.side === 'N') ly += 2;
    return { lx, ly, side: a.side };
  }

  // 区域是否存在：只由世界登记决定，与是否载入、载入后边是否可行无关。
  regionExists(cx, cy) {
    return this.inBounds(cx, cy);
  }

  // 按需生成某个块的精细网格（模拟磁盘上的分块数据）。
  // 返回纯数据，可被序列化，载入与卸载都不影响世界定义。
  generateChunkData(cx, cy) {
    return this.generateRegionData(cx, cy);
  }

  // 生成一次“区域载入”的数据。portals 允许同一区域以另一组门连接重载；
  // closedPortalIds 表示这次载入里被砌死的门（近路、或细节揭示后暂时封闭的出口）。
  // 返回的数据只描述这一次载入，不写回世界登记，因此同名区域重新载入
  // 可以拥有不同的门集合，旧载入的确认不能被新载入继承。
  generateRegionData(
    cx,
    cy,
    { portals = this.chunkPortals(cx, cy), closedPortalIds = null } = {},
  ) {
    if (!this.inBounds(cx, cy)) throw new Error(`chunk out of bounds: ${cx},${cy}`);
    const closed = closedPortalIds
      ? new Set(closedPortalIds)
      : new Set(portals.filter((p) => p.shortcut).map((p) => p.id));
    const rng = chunkRng(this.seed, cx, cy);
    const n = CHUNK_SIZE;
    const grid = new Uint8Array(n * n).fill(OPEN);
    const set = (x, y, v) => {
      grid[y * n + x] = v;
    };

    // 1) 外边界全部封墙
    for (let i = 0; i < n; i++) {
      set(i, 0, WALL);
      set(i, n - 1, WALL);
      set(0, i, WALL);
      set(n - 1, i, WALL);
    }

    // 2) 只按本次载入开放的门打开边界开口；封闭门保持墙。
    const openPortals = portals.filter((p) => !closed.has(p.id));
    const anchors = [];
    for (const p of openPortals) {
      const boundary = this.portalAnchor(p, cx, cy);
      const fine = this.fineAnchor(p, cx, cy);
      anchors.push(fine);
      if (p.kind === 'V') {
        for (let ly = p.lo; ly <= p.hi; ly++) set(boundary.lx, ly, OPEN);
      } else {
        for (let lx = p.lo; lx <= p.hi; lx++) set(lx, boundary.ly, OPEN);
      }
    }

    // 3) 内部随机墙块（不覆盖开放的精细锚点）
    const blobCount = 9 + Math.floor(rng() * 5);
    for (let b = 0; b < blobCount; b++) {
      const w = 2 + Math.floor(rng() * 4);
      const h = 2 + Math.floor(rng() * 4);
      const x0 = 2 + Math.floor(rng() * (n - 4 - w));
      const y0 = 2 + Math.floor(rng() * (n - 4 - h));
      let touchesPortal = false;
      for (let x = x0; x < x0 + w && !touchesPortal; x++) {
        for (let y = y0; y < y0 + h; y++) {
          if (anchors.some((a) => Math.abs(a.lx - x) + Math.abs(a.ly - y) <= 1)) {
            touchesPortal = true;
            break;
          }
        }
      }
      if (!touchesPortal) {
        for (let x = x0; x < x0 + w; x++)
          for (let y = y0; y < y0 + h; y++) set(x, y, WALL);
      }
    }

    // 4) 连通性修复：保证本次开放的所有门锚点互通（按角色尺寸雕刻通道）
    this._repairConnectivity(grid, anchors.map((a) => ({ x: a.lx, y: a.ly })));

    // 4b) 开放门户按最大角色尺寸雕刻净空。
    for (const p of openPortals) {
      const anchor = this.fineAnchor(p, cx, cy);
      for (let dy = -MAX_CHARACTER_RADIUS; dy <= MAX_CHARACTER_RADIUS; dy++) {
        for (let dx = -MAX_CHARACTER_RADIUS; dx <= MAX_CHARACTER_RADIUS; dx++) {
          const x = anchor.lx + dx;
          const y = anchor.ly + dy;
          if (x <= 0 || y <= 0 || x >= n - 1 || y >= n - 1) continue;
          set(x, y, OPEN);
        }
      }
    }

    // 5) 本次载入被封闭的门：边界开口、内衬与内侧精细锚点全部砌成墙。
    //    宏观图上它仍然连通，但这一次载入的局部数据证明它此刻不能通过。
    for (const p of portals) {
      if (!closed.has(p.id)) continue;
      const anchor = this.portalAnchor(p, cx, cy);
      if (!anchor) continue;
      const fine = this.fineAnchor(p, cx, cy);
      if (p.kind === 'V') {
        for (let ly = p.lo; ly <= p.hi; ly++) {
          set(anchor.lx, ly, WALL);
          set(anchor.lx === 0 ? 1 : n - 2, ly, WALL);
        }
        for (let dy = -MAX_CHARACTER_RADIUS; dy <= MAX_CHARACTER_RADIUS; dy++) {
          set(fine.lx, fine.ly + dy, WALL);
        }
      } else {
        for (let lx = p.lo; lx <= p.hi; lx++) {
          set(lx, anchor.ly, WALL);
          set(lx, anchor.ly === 0 ? 1 : n - 2, WALL);
        }
        for (let dx = -MAX_CHARACTER_RADIUS; dx <= MAX_CHARACTER_RADIUS; dx++) {
          set(fine.lx + dx, fine.ly, WALL);
        }
      }
    }
    if (closed.size) {
      // 封墙后重新修复其余开放门之间的连通性（封闭门锚点不参与）
      this._repairConnectivity(grid, anchors.map((a) => ({ x: a.lx, y: a.ly })));
    }

    return {
      cx,
      cy,
      grid, // Uint8Array，1=墙 0=空地
      portalIds: portals.map((p) => p.id),
      closedPortalIds: [...closed],
      shortcutBlocked: portals.some((p) => p.shortcut && closed.has(p.id)),
      byteSize: grid.byteLength + 64,
    };
  }

  _repairConnectivity(grid, anchors) {
    const n = CHUNK_SIZE;
    const at = (x, y) => grid[y * n + x];
    const set = (x, y, v) => {
      grid[y * n + x] = v;
    };
    if (anchors.length === 0) return;
    const r = MAX_CHARACTER_RADIUS;
    const fitsAt = (cx, cy) => {
      if (cx - r < 1 || cy - r < 1 || cx + r > n - 2 || cy + r > n - 2) return false;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) if (at(cx + dx, cy + dy) === WALL) return false;
      return true;
    };
    // 按角色占地尺寸做洪泛：只有放得下角色的中心格才算可通行
    const reachable = (sx, sy) => {
      const seen = new Uint8Array(n * n);
      const q = [[sx, sy]];
      seen[sy * n + sx] = 1;
      while (q.length) {
        const [x, y] = q.pop();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const idx = ny * n + nx;
          if (seen[idx] || !fitsAt(nx, ny)) continue;
          seen[idx] = 1;
          q.push([nx, ny]);
        }
      }
      return seen;
    };
    const carveL = (a, b) => {
      let x = a.x;
      let y = a.y;
      const clear = (cx, cy) => {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const px = cx + dx;
            const py = cy + dy;
            if (px <= 0 || py <= 0 || px >= n - 1 || py >= n - 1) continue;
            set(px, py, OPEN);
          }
        }
      };
      while (x !== b.x) {
        clear(x, y);
        x += Math.sign(b.x - x);
      }
      while (y !== b.y) {
        clear(x, y);
        y += Math.sign(b.y - y);
      }
      clear(b.x, b.y);
    };
    let seen = reachable(anchors[0].x, anchors[0].y);
    for (let i = 1; i < anchors.length; i++) {
      const a = anchors[i];
      if (!seen[a.y * n + a.x]) {
        carveL(anchors[i - 1], a);
        seen = reachable(anchors[0].x, anchors[0].y);
      }
    }
  }

  // 在块内找一个能容纳指定占地半径角色的开放格（用于起点/目标点），
  // 尽量靠近块中心。
  findOpenCell(cx, cy, grid, radius = 0) {
    const n = CHUNK_SIZE;
    const c = Math.floor(n / 2);
    const fitsAt = (x, y) => {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px <= 0 || py <= 0 || px >= n - 1 || py >= n - 1) return false;
          if (grid[py * n + px] === WALL) return false;
        }
      }
      return true;
    };
    for (let r = 0; r < n; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          const x = c + dx;
          const y = c + dy;
          if (x > 0 && y > 0 && x < n - 1 && y < n - 1 && fitsAt(x, y)) {
            return { lx: x, ly: y };
          }
        }
      }
    }
    throw new Error(`no open cell in chunk ${chunkId(cx, cy)}`);
  }
}
