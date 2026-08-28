import type {
  CabIrLibraryPort,
  CabIrPersistReceipt,
  StoredCabIr,
} from './cabIrCoordinator';

export const CAB_IR_LIBRARY_MAX_COUNT = 16;
export const CAB_IR_LIBRARY_MAX_BYTES = 64 * 1024 * 1024;

export interface CabIrLibraryLimits {
  maxCount: number;
  maxBytes: number;
}

/** 返回为了容纳一个新条目应删除的 hash；引用中的条目永不参与 LRU。 */
export function planCabIrEviction(
  records: readonly StoredCabIr[],
  pinned: ReadonlySet<string>,
  incomingBytes: number,
  limits: CabIrLibraryLimits = {
    maxCount: CAB_IR_LIBRARY_MAX_COUNT,
    maxBytes: CAB_IR_LIBRARY_MAX_BYTES,
  },
): string[] {
  if (incomingBytes > limits.maxBytes) throw new Error('IR 超出本地库容量上限');
  let count = records.length + 1;
  let bytes = records.reduce((sum, record) => sum + record.bytes, 0) + incomingBytes;
  const candidates = records
    .filter((record) => !pinned.has(record.hash))
    .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt);
  const evictions: string[] = [];
  for (const record of candidates) {
    if (count <= limits.maxCount && bytes <= limits.maxBytes) break;
    evictions.push(record.hash);
    count--;
    bytes -= record.bytes;
  }
  if (count > limits.maxCount || bytes > limits.maxBytes) {
    throw new Error('引用中的 IR 占满了本地库，请先删除引用它们的预设或快照');
  }
  return evictions;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务中止'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'));
  });
}

export interface BrowserCabIrLibraryOptions {
  indexedDb?: IDBFactory;
  pinnedHashes?: () => ReadonlySet<string>;
  now?: () => number;
}

export interface CabIrLibraryStore extends CabIrLibraryPort {
  list(): Promise<StoredCabIr[]>;
  delete(hash: string): Promise<boolean>;
}

/** 原始 WAV Blob 与可展示元数据的 IndexedDB 库。 */
export class BrowserCabIrLibrary implements CabIrLibraryStore {
  private readonly idb: IDBFactory;
  private readonly pinnedHashes: () => ReadonlySet<string>;
  private readonly now: () => number;
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(options: BrowserCabIrLibraryOptions = {}) {
    if (!options.indexedDb && typeof indexedDB === 'undefined') {
      throw new Error('当前浏览器不支持 IndexedDB');
    }
    this.idb = options.indexedDb ?? indexedDB;
    this.pinnedHashes = options.pinnedHashes ?? (() => new Set());
    this.now = options.now ?? Date.now;
  }

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = this.idb.open('guitar-pedalboard-ir-library', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('irs')) {
          const store = db.createObjectStore('irs', { keyPath: 'hash' });
          store.createIndex('lastUsedAt', 'lastUsedAt');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('无法打开 IR Library'));
    });
    return this.databasePromise;
  }

  async get(hash: string): Promise<StoredCabIr | null> {
    const db = await this.open();
    const tx = db.transaction('irs', 'readonly');
    const result = await requestResult(tx.objectStore('irs').get(hash) as IDBRequest<StoredCabIr | undefined>);
    await transactionDone(tx);
    return result ?? null;
  }

  async list(): Promise<StoredCabIr[]> {
    const db = await this.open();
    const tx = db.transaction('irs', 'readonly');
    const result = await requestResult(tx.objectStore('irs').getAll() as IDBRequest<StoredCabIr[]>);
    await transactionDone(tx);
    return result.toSorted((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  async put(record: StoredCabIr): Promise<CabIrPersistReceipt> {
    const existing = await this.get(record.hash);
    if (existing) {
      await this.touch(record.hash);
      return {
        rollback: async () => {
          const db = await this.open();
          const tx = db.transaction('irs', 'readwrite');
          tx.objectStore('irs').put(existing);
          await transactionDone(tx);
        },
      };
    }
    const records = await this.list();
    const evictions = planCabIrEviction(records, this.pinnedHashes(), record.bytes);
    const evictedRecords = records.filter((candidate) => evictions.includes(candidate.hash));
    const db = await this.open();
    const tx = db.transaction('irs', 'readwrite');
    const store = tx.objectStore('irs');
    for (const hash of evictions) store.delete(hash);
    store.put(record);
    await transactionDone(tx);
    return {
      rollback: async () => {
        const rollbackTx = db.transaction('irs', 'readwrite');
        const rollbackStore = rollbackTx.objectStore('irs');
        rollbackStore.delete(record.hash);
        for (const evicted of evictedRecords) rollbackStore.put(evicted);
        await transactionDone(rollbackTx);
      },
    };
  }

  async touch(hash: string): Promise<void> {
    const current = await this.get(hash);
    if (!current) return;
    const db = await this.open();
    const tx = db.transaction('irs', 'readwrite');
    tx.objectStore('irs').put({ ...current, lastUsedAt: this.now() });
    await transactionDone(tx);
  }

  async delete(hash: string): Promise<boolean> {
    if (this.pinnedHashes().has(hash)) return false;
    const db = await this.open();
    const tx = db.transaction('irs', 'readwrite');
    tx.objectStore('irs').delete(hash);
    await transactionDone(tx);
    return true;
  }
}

/** 无 IndexedDB 环境仍允许内置 IR 走完整事务；自定义持久化明确失败关闭。 */
export class UnavailableCabIrLibrary implements CabIrLibraryStore {
  async get(): Promise<StoredCabIr | null> {
    return null;
  }

  async list(): Promise<StoredCabIr[]> {
    return [];
  }

  async put(): Promise<never> {
    throw new Error('当前浏览器不支持本机 IR Library（IndexedDB 不可用）');
  }

  async touch(): Promise<void> {}

  async delete(): Promise<boolean> {
    return false;
  }
}
