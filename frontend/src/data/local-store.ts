import { SEED_ROWS } from './seed'
import type { EntryRow, LockRecord, PendingOp, StoredState } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'underground-pipeline-inspection:entries'
const SCHEMA_VERSION = 2

// 链路三件套升级到 v2 时需要重建：旧结构里它们之间没有关联，留着只会继续制造状态丢失。
const CHAIN_BUCKET_KEYS = ['out_repair', 'repair_accept', 'repair_rework']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedState(): StoredState {
  return {
    version: SCHEMA_VERSION,
    buckets: clone(SEED_ROWS),
    pending: [],
    locks: {},
  }
}

function normalize(raw: unknown): StoredState {
  if (raw && typeof raw === 'object') {
    const candidate = raw as Partial<StoredState>
    if (candidate.version === SCHEMA_VERSION && candidate.buckets) {
      return {
        version: SCHEMA_VERSION,
        buckets: { ...clone(SEED_ROWS), ...(clone(candidate.buckets) as Record<string, EntryRow[]>) },
        pending: Array.isArray(candidate.pending) ? (clone(candidate.pending) as PendingOp[]) : [],
        locks: candidate.locks ? (clone(candidate.locks) as Record<string, LockRecord>) : {},
      }
    }
    // v1：只有分桶数据。链路三件套直接换成新种子，其余模块保留用户的现场数据。
    if (candidate.version === undefined && !Array.isArray(candidate) && candidate) {
      const oldBuckets = clone(raw as Record<string, EntryRow[]>)
      for (const key of CHAIN_BUCKET_KEYS) {
        delete oldBuckets[key]
      }
      return {
        version: SCHEMA_VERSION,
        buckets: { ...clone(SEED_ROWS), ...oldBuckets },
        pending: [],
        locks: {},
      }
    }
  }
  return seedState()
}

function readStorage(): StoredState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = seedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
  try {
    return normalize(JSON.parse(raw))
  } catch {
    const seeded = seedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded))
    return seeded
  }
}

let cache: StoredState | null = null

export function getState(): StoredState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

/** 从浏览器存储重新拉取：别的标签页刚写入时，本机缓存可能还是旧的。 */
export function reloadState(): StoredState {
  cache = readStorage()
  return cache
}

export function commitState(next: StoredState): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

/**
 * 唯一的写入入口：进入时先读一次磁盘上的最新状态（防多标签页覆盖），
 * 在 updater 内基于同一份快照完成「检查 + 改写」，整体一次性落盘。
 * 返回 updater 的返回值，失败时由 updater 抛错，存储保持原样。
 */
export function mutate<T>(updater: (state: StoredState) => T): T {
  const fresh = typeof window !== 'undefined' && window.localStorage ? reloadState() : getState()
  const draft: StoredState = {
    version: SCHEMA_VERSION,
    buckets: clone(fresh.buckets),
    pending: clone(fresh.pending),
    locks: clone(fresh.locks),
  }
  const result = updater(draft)
  commitState(draft)
  return result
}

export function bucket(key: string): EntryRow[] {
  return getState().buckets[key] ?? []
}

export function allRows(): Record<string, EntryRow[]> {
  return getState().buckets
}

export function listRows(key: string): EntryRow[] {
  return bucket(key)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  mutate((state) => {
    state.buckets[key] = rows
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/** 测试与「重置演示链路」用：清空业务分桶、中断事务与锁，回到种子数据。 */
export function resetAll(): StoredState {
  const seeded = seedState()
  commitState(seeded)
  return seeded
}

export function storageKey(): string {
  return STORAGE_KEY
}

// 多标签页协作：别的页面写入后，本页缓存作废，下一次读取自然拿到最新状态。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}
