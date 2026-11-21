// 分块存储：精细网格数据按需生成/加载，模拟从磁盘流式读取。
// 同一时刻世界上只有少量块驻留内存，超出预算按 LRU 淘汰；
// 角色当前所在块可被 pin 住，禁止淘汰。
// 所有加载都是真实异步过程，未加载的块没有任何网格数据，
// 规划器绝不能把未知区域当成无障碍自由空间。

import { chunkId } from './world.js';

export const ChunkStatus = Object.freeze({
  UNLOADED: 'unloaded', // 磁盘上存在，尚未载入
  LOADING: 'loading', // 已发起异步读取，数据还没到
  RESIDENT: 'resident', // 精细网格驻留内存
});

export function regionInstanceId(key, dataVersion, generation) {
  return `${key}@${dataVersion}@${generation}`;
}

export class ChunkStore {
  constructor(world, { budget = 4, loadDelayMs = 120 } = {}) {
    this.world = world;
    this.budget = budget;
    this.loadDelayMs = loadDelayMs;
    this.resident = new Map(); // key -> {data, lastUsed, dataVersion, instanceId, generation}
    this.inflight = new Map(); // key -> Promise（旧式整区载入）
    this.regionInflight = new Map(); // key -> {dataVersion, promise}
    this.pinned = new Set();
    this._generation = 0;
    this._loadToken = new Map(); // key -> 卸载代次，防止在途载入复活已卸载的数据
    this.stats = { loads: 0, cacheHits: 0, evictions: 0, loadFailures: 0 };
    this.events = []; // 最近的加载/淘汰事件，供界面展示
  }

  key(cx, cy) {
    return chunkId(cx, cy);
  }

  status(cx, cy) {
    const k = this.key(cx, cy);
    if (this.resident.has(k)) return ChunkStatus.RESIDENT;
    if (this.inflight.has(k) || this.regionInflight.has(k)) return ChunkStatus.LOADING;
    return ChunkStatus.UNLOADED;
  }

  get(cx, cy) {
    const entry = this.resident.get(this.key(cx, cy));
    return entry ? entry.data : null;
  }

  // 当前驻留实例的身份（供确认结果绑定到某一次载入）。
  regionMeta(cx, cy) {
    const entry = this.resident.get(this.key(cx, cy));
    if (!entry) return null;
    return {
      cx,
      cy,
      dataVersion: entry.dataVersion,
      generation: entry.generation,
      instanceId: entry.instanceId,
    };
  }

  // 按“某一次载入”生成/替换区域数据。
  // 同名区域以不同 dataVersion 载入即视为另一份局部数据：
  // 旧代次上确认过的边与路线一律不能沿用。
  // closedPortalIds 表示这一次载入里被砌死的门（宏观仍连通，细节揭示后封闭）。
  async loadRegion(cx, cy, { portals, dataVersion = 0, tick = 0, force = false, closedPortalIds = null } = {}) {
    const k = this.key(cx, cy);
    const hit = this.resident.get(k);
    if (hit && hit.dataVersion === dataVersion && !force) {
      hit.lastUsed = tick;
      this.stats.cacheHits++;
      return this.regionMeta(cx, cy);
    }
    const pending = this.regionInflight.get(k);
    if (pending) {
      if (pending.dataVersion === dataVersion && !force) return pending.promise;
      // 已有另一份数据在途：等它结束后再按当前版本重载，避免串代。
      await pending.promise.catch(() => {});
      return this.loadRegion(cx, cy, { portals, dataVersion, tick, force, closedPortalIds });
    }

    const promise = new Promise((resolve) => {
      const token = this._loadToken.get(k) ?? 0;
      setTimeout(() => {
        if ((this._loadToken.get(k) ?? 0) !== token) {
          // 载入在途期间该区域被卸载：丢弃这份数据，绝不复活。
          this.regionInflight.delete(k);
          this.stats.loadFailures++;
          this._record({ type: 'discard', chunk: k, dataVersion });
          resolve(null);
          return;
        }
        const data = this.world.generateRegionData(cx, cy, {
          portals: portals ?? this.world.chunkPortals(cx, cy),
          closedPortalIds,
        });
        const generation = ++this._generation;
        const instanceId = regionInstanceId(k, dataVersion, generation);
        this.resident.set(k, { data, lastUsed: tick, dataVersion, generation, instanceId });
        this.regionInflight.delete(k);
        this.stats.loads++;
        this._record({
          type: hit ? 'reload' : 'load',
          chunk: k,
          dataVersion,
          instanceId,
          bytes: data.byteSize,
        });
        this._evictIfNeeded();
        resolve({ cx, cy, dataVersion, generation, instanceId });
      }, this.loadDelayMs);
    });
    this.regionInflight.set(k, { dataVersion, promise });
    return promise;
  }

  pin(cx, cy) {
    this.pinned.add(this.key(cx, cy));
  }

  unpin(cx, cy) {
    this.pinned.delete(this.key(cx, cy));
  }

  residentBytes() {
    let bytes = 0;
    for (const { data } of this.resident.values()) bytes += data.byteSize;
    return bytes;
  }

  residentChunks() {
    return [...this.resident.keys()].map((k) => {
      const [cx, cy] = k.split(',').map(Number);
      const entry = this.resident.get(k);
      return {
        cx,
        cy,
        key: k,
        pinned: this.pinned.has(k),
        byteSize: entry.data.byteSize,
        dataVersion: entry.dataVersion,
        instanceId: entry.instanceId,
      };
    });
  }

  loadingChunks() {
    const out = new Map();
    for (const k of this.inflight.keys()) out.set(k, { key: k, dataVersion: 0 });
    for (const [k, v] of this.regionInflight) out.set(k, { key: k, dataVersion: v.dataVersion });
    return [...out.values()].map((e) => {
      const [cx, cy] = e.key.split(',').map(Number);
      return { cx, cy, key: e.key, dataVersion: e.dataVersion };
    });
  }

  _record(ev) {
    this.events.push({ at: Date.now(), ...ev });
    if (this.events.length > 30) this.events.shift();
  }

  touch(cx, cy, tick) {
    const entry = this.resident.get(this.key(cx, cy));
    if (entry) entry.lastUsed = tick;
  }

  // 确保块已驻留；并发请求合并为同一个加载 Promise。
  async ensureLoaded(cx, cy, tick = 0) {
    const k = this.key(cx, cy);
    const hit = this.resident.get(k);
    if (hit) {
      hit.lastUsed = tick;
      this.stats.cacheHits++;
      return hit.data;
    }
    if (this.inflight.has(k)) return this.inflight.get(k);

    const promise = new Promise((resolve) => {
      const token = this._loadToken.get(k) ?? 0;
      setTimeout(() => {
        if ((this._loadToken.get(k) ?? 0) !== token) {
          this.inflight.delete(k);
          this.stats.loadFailures++;
          this._record({ type: 'discard', chunk: k, dataVersion: 0 });
          // 已被卸载：不写入任何网格，调用方会看到非驻留状态。
          resolve(null);
          return;
        }
        // 模拟流式读取：数据在此时才真正生成并进入内存
        const data = this.world.generateChunkData(cx, cy);
        const generation = ++this._generation;
        this.resident.set(k, {
          data,
          lastUsed: tick,
          dataVersion: 0,
          generation,
          instanceId: regionInstanceId(k, 0, generation),
        });
        this.inflight.delete(k);
        this.stats.loads++;
        this._record({ type: 'load', chunk: k, bytes: data.byteSize });
        this._evictIfNeeded();
        resolve(data);
      }, this.loadDelayMs);
    });
    this.inflight.set(k, promise);
    return promise;
  }

  _evictIfNeeded() {
    while (this.resident.size > this.budget) {
      let victim = null;
      let oldest = Infinity;
      for (const [k, entry] of this.resident) {
        if (this.pinned.has(k)) continue;
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          victim = k;
        }
      }
      if (!victim) break; // 全部被 pin，无法淘汰
      const entry = this.resident.get(victim);
      this.resident.delete(victim);
      this.stats.evictions++;
      this._record({ type: 'evict', chunk: victim, bytes: entry.data.byteSize });
    }
  }

  // 主动卸载一块区域：驻留数据、在途载入与 pin 一并清除。
  // 之后同名区域再载入会得到新的代次，旧载入确认的边不能继承。
  unload(cx, cy) {
    const k = this.key(cx, cy);
    this._loadToken.set(k, (this._loadToken.get(k) ?? 0) + 1);
    const entry = this.resident.get(k);
    this.resident.delete(k);
    this.inflight.delete(k);
    this.regionInflight.delete(k);
    this.pinned.delete(k);
    // 卸载即撤销该区域相关席位：复用同名出口必须重新预约。
    if (this.seats && typeof this.seats.releaseRegion === 'function') {
      this.seats.releaseRegion(k, 'region-unloaded');
    }
    if (entry) {
      this.stats.evictions++;
      this._record({
        type: 'unload',
        chunk: k,
        dataVersion: entry.dataVersion,
        instanceId: entry.instanceId,
        bytes: entry.data.byteSize,
      });
    }
  }

  // 测试/重置用
  reset() {
    this.resident.clear();
    this.inflight.clear();
    this.regionInflight.clear();
    this.pinned.clear();
    this._generation = 0;
    this.stats = { loads: 0, cacheHits: 0, evictions: 0, loadFailures: 0 };
    this.events = [];
  }
}
