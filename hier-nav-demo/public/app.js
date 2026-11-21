// 前端只做两件事：调用连续导航 REST API、按真实快照渲染。
// 路径、门户状态、分块驻留信息全部来自后端 Simulation，无任何固定假数据。

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');

let session = null;
let world = null;
let snapshot = null;
let startPick = null; // {wx, wy}
let goalPick = null;
let autoTimer = null;
let cellPx = 6;
let originX = 0;
let originY = 0;

const STATUS_LABEL = {
  queued: '暂未搜索',
  'awaiting-data': '缺少数据·加载中',
  confirmed: '精细已确认',
  done: '已走过',
  blocked: '明确不可达',
};
const EDGE_LABEL = {
  queued: '边：未确认',
  'awaiting-data': '边：等局部数据（不是不可达）',
  confirmed: '边：本次载入已确认',
};
const STATE_LABEL = {
  idle: '未开始',
  seeking: '规划/行进中',
  arrived: '已到达目标',
  unreachable: '明确不可达',
};

async function api(path, method = 'GET', body) {
  const res = await fetch(`/api/session/${session}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

async function newSession() {
  stopAuto();
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cols: 5,
      rows: 5,
      seed: 'demo-world',
      budget: Number($('budget').value),
      loadDelayMs: Number($('delay').value),
    }),
  });
  const data = await res.json();
  session = data.sessionId;
  world = data.world;
  snapshot = null;
  startPick = null;
  goalPick = null;
  layoutCanvas();
  await refresh();
}

function layoutCanvas() {
  const w = world.worldWidth;
  const h = world.worldHeight;
  const maxW = canvas.parentElement.clientWidth - 4;
  cellPx = Math.max(3, Math.floor(Math.min(maxW / w, 640 / h)));
  canvas.width = w * cellPx + 2;
  canvas.height = h * cellPx + 2;
  originX = 1;
  originY = 1;
}
const px = (wx) => originX + wx * cellPx;
const py = (wy) => originY + wy * cellPx;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!world) return;
  const rect = canvas.getBoundingClientRect();
  const wx = Math.floor(((e.clientX - rect.left) / rect.width) * canvas.width / cellPx);
  const wy = Math.floor(((e.clientY - rect.top) / rect.height) * canvas.height / cellPx);
  if (wx < 0 || wy < 0 || wx >= world.worldWidth || wy >= world.worldHeight) return;
  if (e.button === 2) goalPick = { wx, wy };
  else startPick = { wx, wy };
  draw();
});

async function startPlan() {
  if (!session || !startPick || !goalPick) {
    alert('请先在地图上左键设置起点、右键设置远程目标');
    return;
  }
  stopAuto();
  snapshot = await api('/plan', 'POST', {
    start: startPick,
    goal: goalPick,
    radius: Number($('radius').value),
  });
  renderPanels();
  draw();
}

async function tick(steps = 1) {
  if (!session) return;
  snapshot = await api('/tick', 'POST', { steps });
  renderPanels();
  draw();
}

function startAuto() {
  if (autoTimer) return;
  $('runBtn').disabled = true;
  $('pauseBtn').disabled = false;
  autoTimer = setInterval(async () => {
    if (!snapshot || snapshot.finished) return stopAuto();
    await tick(1);
  }, 220);
}
function stopAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  $('runBtn').disabled = false;
  $('pauseBtn').disabled = true;
}

async function refresh() {
  if (!session) return;
  snapshot = await api('/snapshot');
  renderPanels();
  draw();
}

function draw() {
  if (!world) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawChunks();
  drawPortals();
  drawCoarseRoute();
  drawFineRoutes();
  drawRevokedRoutes();
  drawPoints();
}

function chunkStatus(cx, cy) {
  if (!snapshot) return 'unloaded';
  const c = snapshot.chunks.find((x) => x.cx === cx && x.cy === cy);
  if (c) return c.status;
  const loading = snapshot.memory.loading.some((x) => x.cx === cx && x.cy === cy);
  return loading ? 'loading' : 'unloaded';
}

function drawChunks() {
  const n = world.chunkSize;
  for (let cx = 0; cx < world.cols; cx++) {
    for (let cy = 0; cy < world.rows; cy++) {
      const ox = cx * n * cellPx;
      const oy = cy * n * cellPx;
      const status = chunkStatus(cx, cy);
      if (status === 'unloaded') {
        ctx.fillStyle = '#121a24';
        ctx.fillRect(ox, oy, n * cellPx, n * cellPx);
        ctx.strokeStyle = '#263548';
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(ox + 1, oy + 1, n * cellPx - 2, n * cellPx - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = '#3a4d63';
        ctx.font = `${Math.max(9, cellPx * 2)}px sans-serif`;
        ctx.fillText(`${cx},${cy} 未载入`, ox + 6, oy + 16);
        continue;
      }
      if (status === 'loading') {
        ctx.fillStyle = '#2a2415';
        ctx.fillRect(ox, oy, n * cellPx, n * cellPx);
        ctx.fillStyle = '#8a7438';
        ctx.font = `${Math.max(9, cellPx * 2)}px sans-serif`;
        ctx.fillText(`${cx},${cy} 加载中…`, ox + 6, oy + 16);
        continue;
      }
      const chunk = snapshot.chunks.find((x) => x.cx === cx && x.cy === cy);
      // 精细网格：只画已驻留块，未驻留区域绝不渲染成“已知可通行”
      for (let ly = 0; ly < n; ly++) {
        for (let lx = 0; lx < n; lx++) {
          const wall = chunk.grid[ly * n + lx] === 1;
          ctx.fillStyle = wall ? '#33455c' : '#16352a';
          ctx.fillRect(ox + lx * cellPx, oy + ly * cellPx, cellPx, cellPx);
        }
      }
      ctx.strokeStyle = '#2f6b4f';
      ctx.strokeRect(ox + 0.5, oy + 0.5, n * cellPx - 1, n * cellPx - 1);
      ctx.fillStyle = '#46d18c';
      ctx.font = `${Math.max(9, cellPx * 2)}px sans-serif`;
      ctx.fillText(`${cx},${cy}`, ox + 4, oy + 13);
    }
  }
}

function drawPortals() {
  for (const p of world.portals) {
    for (const side of [p.a, p.b]) {
      const gx = side.cx * world.chunkSize + side.lx;
      const gy = side.cy * world.chunkSize + side.ly;
      ctx.fillStyle = p.shortcut ? '#ff7ac6' : '#4da3ff';
      if (p.kind === 'V') {
        for (let d = -1; d <= 1; d++) ctx.fillRect(px(gx) - cellPx / 2, py(gy + d) - cellPx / 2, cellPx, cellPx);
      } else {
        for (let d = -1; d <= 1; d++) ctx.fillRect(px(gx + d) - cellPx / 2, py(gy) - cellPx / 2, cellPx, cellPx);
      }
    }
  }
}

function drawPolyline(points, color, width, dash = []) {
  if (!points || points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  points.forEach((pt, i) => {
    const x = px(pt.wx);
    const y = py(pt.wy);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawCoarseRoute() {
  if (!snapshot || !snapshot.planner.coarseRoute) return;
  drawPolyline(snapshot.planner.coarseRoute.polyline, 'rgba(181,140,255,0.85)', 2, [6, 5]);
}

// 已撤销路段：本次已证实不可达、已从承诺路线撤下的门用红色斜线标出。
function drawRevokedRoutes() {
  if (!snapshot || !snapshot.planner.map) return;
  for (const rev of snapshot.planner.map.revoked) {
    drawPolyline(rev.polyline, 'rgba(239,107,107,0.95)', 3, [3, 3]);
  }
}

function drawFineRoutes() {
  if (!snapshot) return;
  for (const leg of snapshot.planner.legs) {
    if (leg.type !== 'move' || !leg.path) continue;
    let color = '#6b7c91';
    if (leg.status === 'confirmed' || leg.status === 'done') color = '#46d18c';
    else if (leg.status === 'blocked') color = '#ef6b6b';
    else if (leg.status === 'awaiting-data') color = '#f0b94b';
    drawPolyline(leg.path, color, cellPx >= 5 ? 3 : 2);
  }
  // 已确认可立即行走的连续路径高亮
  drawPolyline(snapshot.planner.confirmedPath, 'rgba(70,209,140,0.95)', 2);
}

function drawPoints() {
  if (startPick) marker(startPick.wx, startPick.wy, '#4da3ff', 'S');
  if (goalPick) marker(goalPick.wx, goalPick.wy, '#f0b94b', 'G');
  if (snapshot && snapshot.pos) marker(snapshot.pos.wx, snapshot.pos.wy, '#ffffff', '●');
}
function marker(wx, wy, color, label) {
  const r = Math.max(5, cellPx * 1.6);
  ctx.beginPath();
  ctx.arc(px(wx), py(wy), r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = '#0b1017';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px(wx), py(wy) + 0.5);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function renderPanels() {
  if (!snapshot) return;
  const p = snapshot.planner;
  const stateEl = $('planState');
  stateEl.className = `state ${p.state}`;
  stateEl.textContent = STATE_LABEL[p.state] + (p.unreachableReason ? `（${p.unreachableReason}）` : '');
  $('coarseAttempts').textContent = p.coarseAttempts;
  $('tickCount').textContent = snapshot.tick;
  $('posText').textContent = snapshot.pos ? `${snapshot.pos.wx}, ${snapshot.pos.wy}` : '-';
  $('goalText').textContent = snapshot.target ? `${snapshot.target.wx}, ${snapshot.target.wy}` : '-';
  $('unreachText').textContent = p.unreachableReason ?? '-';
  const OUTCOME_LABEL = {
    'pending-data': '正在等局部数据（不是不可达）',
    'proven-unreachable': '已证实不可达',
  };
  $('outcomeText').textContent = p.outcome ? OUTCOME_LABEL[p.outcome.kind] ?? p.outcome.kind : '无（已规划/已到达）';
  const seats = snapshot.seats;
  $('seatText').textContent = seats
    ? `${seats.occupancy} 席（候补 ${seats.tickets.filter((t) => t.stage === 'waitlist').length}）`
    : '-';

  const m = snapshot.memory;
  $('memBudget').textContent = `${m.budget} / ${m.resident.length} 块`;
  $('memBytes').textContent = `${m.residentBytes} B`;
  $('memStats').textContent = `${m.stats.loads} / ${m.stats.cacheHits} / ${m.stats.evictions}`;

  $('chunkList').innerHTML = m.resident.length
    ? m.resident.map((c) => `<div class="chunk-item"><span>${c.key} ${c.pinned ? '（角色驻留·pin）' : ''}</span><span>${c.byteSize}B</span></div>`).join('')
    : '<p class="muted">无驻留块</p>';

  const blocked = new Set(p.blockedPortalIds);
  const routeItems = p.coarseRoute && p.coarseRoute.portals.length
    ? p.coarseRoute.portals.map((id) => {
        const cls = blocked.has(id) ? 'blocked' : world.portals.find((x) => x.id === id)?.shortcut ? 'sc' : '';
        const tag = blocked.has(id) ? '（精细证伪，已回溯）' : world.portals.find((x) => x.id === id)?.shortcut ? '（近路）' : '';
        return `<li class="${cls}">${id} ${tag}</li>`;
      }).join('')
    : '<li class="muted">无候选（粗层不可达）</li>';
  // 已被精细层证伪、因此不在当前成功路由中的门户（如被封死的近路）
  const rejectedItems = [...blocked]
    .filter((id) => !(p.coarseRoute?.portals ?? []).includes(id))
    .map((id) => `<li class="blocked">${id}（精细证伪，已回溯改道）</li>`)
    .join('');
  $('coarseList').innerHTML = routeItems + rejectedItems;

  $('legList').innerHTML = p.legs.length
    ? p.legs.map((l) => `
      <div class="leg-item ${l.status}">
        <div class="leg-head">
          <span>${l.id} <span class="tag ${l.type}">${l.type === 'move' ? '块内移动' : '跨门户'}</span>
            ${l.portalId ? l.portalId : ''}</span>
          <span>${STATUS_LABEL[l.status] ?? l.status}</span>
        </div>
        <div class="leg-detail">(${l.from.wx},${l.from.wy}) → (${l.to.wx},${l.to.wy})
          ${l.chunk ? '· 块 ' + l.chunk : ''} ${l.fineCost != null ? '· 精细代价 ' + l.fineCost : ''}
          ${l.edgeStatus ? '· ' + (EDGE_LABEL[l.edgeStatus] ?? l.edgeStatus) : ''}
          ${l.detail ? '· ' + l.detail : ''}</div>
      </div>`).join('')
    : '<p class="muted">暂无分段</p>';

  $('eventLog').innerHTML = m.events.length
    ? m.events.map((e) => `<div>${e.type === 'load' ? '📥 加载' : '📤 淘汰'} 块 ${e.chunk}（${e.bytes}B）</div>`).join('')
    : '<div>无</div>';
}

$('newSession').addEventListener('click', newSession);
$('planBtn').addEventListener('click', startPlan);
$('stepBtn').addEventListener('click', () => tick(1));
$('runBtn').addEventListener('click', startAuto);
$('pauseBtn').addEventListener('click', stopAuto);
$('cancelBtn').addEventListener('click', async () => {
  stopAuto();
  snapshot = await api('/cancel', 'POST', { reason: 'player-cancelled' });
  renderPanels();
  draw();
});
$('unloadBtn').addEventListener('click', async () => {
  stopAuto();
  snapshot = await api('/unload', 'POST', {
    cx: Number($('regionX').value),
    cy: Number($('regionY').value),
  });
  renderPanels();
  draw();
});
$('reloadBtn').addEventListener('click', async () => {
  stopAuto();
  const cx = Number($('regionX').value);
  const cy = Number($('regionY').value);
  // 该区域当前登记的门里，保留除最东向那一道之外的全部，形成“另一组门”。
  const here = world.portals.filter(
    (p) => (p.a.cx === cx && p.a.cy === cy) || (p.b.cx === cx && p.b.cy === cy),
  );
  const drop = here.find((p) => !p.shortcut) ?? here[0];
  const portalIds = here.filter((p) => p !== drop).map((p) => p.id);
  snapshot = await api('/reload', 'POST', { cx, cy, portalIds });
  renderPanels();
  draw();
});
$('resetBtn').addEventListener('click', async () => { stopAuto(); await api('/reset', 'POST'); await refresh(); });
window.addEventListener('resize', () => { layoutCanvas(); draw(); });

newSession();
