/**
 * TONE3000 模型元数据(归属展示)的本地缓存(ADR-0007)。
 * 归属展示是 API 条款的强制项:用户登出后恢复含 tone3000: 模型的 rig 时,
 * 仍需能显示作者/许可——缓存"用户自己装载过"的模型元数据(非目录缓存,
 * 条款禁止的是抓取/镜像目录)。
 * 存储为插入序数组(JSON 对象的整数键会被重排,无法表达 LRU 顺序)。
 */

import type { ToneInfo } from './client';

const CACHE_KEY = 't3k_tone_info';
const MAX_ENTRIES = 50;

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function readEntries(storage: KeyValueStorage): [string, ToneInfo][] {
  const raw = storage.getItem(CACHE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as [string, ToneInfo][]) : [];
  } catch {
    return [];
  }
}

/** 读取缓存的模型元数据(无则 null) */
export function getCachedToneInfo(toneId: string, storage: KeyValueStorage): ToneInfo | null {
  return readEntries(storage).find(([key]) => key === toneId)?.[1] ?? null;
}

/** 写入模型元数据(同 id 刷新为最新并置末尾;超出上限淘汰最旧) */
export function putCachedToneInfo(info: ToneInfo, storage: KeyValueStorage): void {
  const id = String(info.id);
  let entries = readEntries(storage).filter(([key]) => key !== id);
  entries.push([id, info]);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  storage.setItem(CACHE_KEY, JSON.stringify(entries));
}
