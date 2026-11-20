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

export class ChunkStore {
  constructor(world, { budget = 4, loadDelayMs = 120 } = {}) {
    this.world = world;
    this.budget = budget;
    this.loadDelayMs = loadDelayMs;
    this.resident = new Map(); // key -> {data, lastUsed, pinned}
    this.inflight = new Map(); // key -> Promise
    this.pinned = new Set();
    this.stats = { loads: 0, cacheHits: 0, evictions: 0, loadFailures: 0 };
    this.events = []; // 最近的加载/淘汰事件，供界面展示
  }

  key(cx, cy) {
    return chunkId(cx, cy);
  }

  status(cx, cy) {
    const k = this.key(cx, cy);
    if (this.resident.has(k)) return ChunkStatus.RESIDENT;
    if (this.inflight.has(k)) return ChunkStatus.LOADING;
    return ChunkStatus.UNLOADED;
  }

  get(cx, cy) {
    const entry = this.resident.get(this.key(cx, cy));
    return entry ? entry.data : null;
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
      return { cx, cy, key: k, pinned: this.pinned.has(k), byteSize: this.resident.get(k).data.byteSize };
    });
  }

  loadingChunks() {
    return [...this.inflight.keys()].map((k) => {
      const [cx, cy] = k.split(',').map(Number);
      return { cx, cy, key: k };
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
      setTimeout(() => {
        // 模拟流式读取：数据在此时才真正生成并进入内存
        const data = this.world.generateChunkData(cx, cy);
        this.resident.set(k, { data, lastUsed: tick, pinned: this.pinned.has(k) });
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

  // 测试/重置用
  reset() {
    this.resident.clear();
    this.inflight.clear();
    this.pinned.clear();
    this.stats = { loads: 0, cacheHits: 0, evictions: 0, loadFailures: 0 };
    this.events = [];
  }
}
