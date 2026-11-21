// 零依赖 HTTP 服务：向浏览器提供静态界面与连续导航 REST API。
// 所有规划、按需加载、LRU 淘汰都在真实的 Simulation 中运行，
// 前端只负责发起命令与渲染，绝不用固定数据冒充路径或分块状态。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { World, CHUNK_SIZE } from './world.js';
import { Simulation } from './simulation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// 会话表：每个 sessionId 持有一个真实模拟实例。
const sessions = new Map();

function createSession(config) {
  const world = new World({
    cols: config.cols ?? 5,
    rows: config.rows ?? 5,
    seed: config.seed ?? 'demo-world',
  });
  const sim = new Simulation(world, {
    budget: config.budget ?? 4,
    loadDelayMs: config.loadDelayMs ?? 150,
    speed: config.speed ?? 1,
  });
  const sessionId = `s-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  sessions.set(sessionId, { world, sim });
  return sessionId;
}

function worldDescriptor(world) {
  return {
    cols: world.cols,
    rows: world.rows,
    chunkSize: CHUNK_SIZE,
    worldWidth: world.worldWidth(),
    worldHeight: world.worldHeight(),
    seed: world.seed,
    shortcutPortalId: world.shortcutPortalId,
    portals: [...world.portals.values()].map((p) => ({
      id: p.id,
      kind: p.kind,
      lo: p.lo,
      hi: p.hi,
      width: p.width,
      estCost: p.estCost,
      claimedClearance: p.claimedClearance,
      shortcut: p.shortcut,
      a: p.a,
      b: p.b,
    })),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(buf);
}

// 返回某个块的精细网格（仅当已驻留；未驻留不返回网格，前端显示为未知）。
function chunkView(session, cx, cy) {
  const { world, sim } = session;
  const status = sim.store.status(cx, cy);
  const base = { cx, cy, status };
  if (status !== 'resident') return base;
  const data = sim.store.get(cx, cy);
  return {
    ...base,
    shortcutBlocked: data.shortcutBlocked,
    // 转成普通数组便于 JSON 传输
    grid: Array.from(data.grid),
    byteSize: data.byteSize,
  };
}

function sessionSnapshot(session) {
  const { sim } = session;
  return {
    ...sim.snapshot(),
    chunks: [...sim.store.resident.keys()].map((k) => {
      const [cx, cy] = k.split(',').map(Number);
      return chunkView(session, cx, cy);
    }),
  };
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(path.join(PUBLIC_DIR, 'index.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(html);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/public/')) {
        const name = path.basename(url.pathname);
        const file = await readFile(path.join(PUBLIC_DIR, name));
        res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] ?? 'application/octet-stream' });
        return res.end(file);
      }

      if (route === 'POST /api/session') {
        const body = await readBody(req);
        const id = createSession(body);
        const session = sessions.get(id);
        return sendJson(res, 200, { sessionId: id, world: worldDescriptor(session.world) });
      }

      const apiMatch = url.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
      if (apiMatch) {
        const session = sessions.get(apiMatch[1]);
        if (!session) return sendJson(res, 404, { error: 'unknown session' });
        const sub = apiMatch[2] ?? '';

        if (req.method === 'GET' && sub === '/snapshot') {
          return sendJson(res, 200, sessionSnapshot(session));
        }
        if (req.method === 'GET' && sub === '/world') {
          return sendJson(res, 200, worldDescriptor(session.world));
        }
        if (req.method === 'GET' && sub.startsWith('/chunk/')) {
          const [cx, cy] = sub.slice('/chunk/'.length).split(',').map(Number);
          if (!session.world.inBounds(cx, cy)) return sendJson(res, 400, { error: 'bad chunk' });
          return sendJson(res, 200, chunkView(session, cx, cy));
        }
        if (req.method === 'POST' && sub === '/plan') {
          const body = await readBody(req);
          session.sim.start(body.start.wx, body.start.wy, body.goal.wx, body.goal.wy, body.radius ?? 1);
          return sendJson(res, 200, sessionSnapshot(session));
        }
        if (req.method === 'POST' && sub === '/tick') {
          const body = await readBody(req);
          const steps = Math.max(1, Math.min(50, body.steps ?? 1));
          let last = null;
          for (let i = 0; i < steps; i++) {
            last = await session.sim.step();
            if (last === false) break;
          }
          return sendJson(res, 200, sessionSnapshot(session));
        }
        // 撤回玩家指令：撤销进行中的规划与席位预约。
        if (req.method === 'POST' && sub === '/cancel') {
          const body = await readBody(req);
          session.sim.cancelPlan(body.reason ?? 'player-cancelled');
          return sendJson(res, 200, sessionSnapshot(session));
        }
        // 卸载某区域（并从规划中撤下），让在途旧细化不再生效。
        if (req.method === 'POST' && sub === '/unload') {
          const body = await readBody(req);
          session.sim.dropRegion(body.cx, body.cy);
          return sendJson(res, 200, sessionSnapshot(session));
        }
        // 同名区域以另一组门重载：body.excludePortalIds 里均为排除的东向门。
        if (req.method === 'POST' && sub === '/reload') {
          const body = await readBody(req);
          const { cx, cy, portalIds } = body;
          if (!session.world.inBounds(cx, cy)) return sendJson(res, 400, { error: 'bad region' });
          const portals = portalIds
            ? portalIds.map((id) => session.world.getPortal(id)).filter(Boolean)
            : session.world.chunkPortals(cx, cy);
          await session.sim.reloadRegion(cx, cy, portals);
          return sendJson(res, 200, sessionSnapshot(session));
        }
        if (req.method === 'POST' && sub === '/reset') {
          session.sim.store.reset();
          session.sim.planner.reset();
          session.sim.pos = null;
          session.sim.finished = false;
          return sendJson(res, 200, session.sim.snapshot());
        }
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8080);
  createServer().listen(port, () => {
    console.log(`分层导航演示已启动: http://localhost:${port}`);
  });
}
