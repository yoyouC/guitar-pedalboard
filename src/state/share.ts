import { getEffectDef } from '../audio/effects';
import { getCabDef } from '../audio/cabs';
import { getAmpDef } from '../audio/amps';
import { getAmpModelEntry, getAmpModelCategory } from '../audio/ampCategories';
import type { ChainItem } from './store';

/**
 * 效果链/箱头/箱体配置的 URL 分享编码。
 * 格式:`#p=` + base64url(JSON),字段全用短名控制长度,带版本号 v 向前兼容。
 * 未知 effectId/型号/箱体会被容错跳过,参数值钳制到定义范围内。
 */

export interface ShareState {
  chain: ChainItem[];
  ampCategoryId: string;
  ampModelKey: string;
  ampEnabled: boolean;
  ampValues: Record<string, number>;
  cabId: string;
  cabEnabled: boolean;
  cabValues: Record<string, number>;
}

interface SharePayload {
  v: 1;
  c: { id: string; e: 0 | 1; v: Record<string, number> }[];
  a?: { cat: string; key: string; on: 0 | 1; v: Record<string, number> };
  b?: { id: string; on: 0 | 1; v: Record<string, number> };
}

function base64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function clampValues(defParams: { key: string; min: number; max: number; defaultValue: number }[], values: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const src = (values ?? {}) as Record<string, unknown>;
  for (const p of defParams) {
    const raw = Number(src[p.key]);
    out[p.key] = Number.isFinite(raw)
      ? Math.min(p.max, Math.max(p.min, raw))
      : p.defaultValue;
  }
  return out;
}

export function encodeShareState(state: ShareState): string {
  const payload: SharePayload = {
    v: 1,
    c: state.chain.map((i) => ({ id: i.effectId, e: i.enabled ? 1 : 0, v: i.values })),
    a: {
      cat: state.ampCategoryId,
      key: state.ampModelKey,
      on: state.ampEnabled ? 1 : 0,
      v: state.ampValues,
    },
    b: {
      id: state.cabId,
      on: state.cabEnabled ? 1 : 0,
      v: state.cabValues,
    },
  };
  return base64urlEncode(JSON.stringify(payload));
}

/** 解码失败返回 null(调用方忽略);未知项跳过,参数钳制 */
export function decodeShareState(encoded: string): ShareState | null {
  try {
    const payload = JSON.parse(base64urlDecode(encoded)) as SharePayload;
    if (payload?.v !== 1 || !Array.isArray(payload.c)) return null;

    const chain: ChainItem[] = [];
    for (const item of payload.c) {
      try {
        const def = getEffectDef(item.id);
        chain.push({
          uid: crypto.randomUUID(),
          effectId: def.id,
          enabled: item.e !== 0,
          values: clampValues(def.params, item.v),
        });
      } catch {
        console.warn(`[share] 跳过未知效果器: ${item.id}`);
      }
    }

    const ampModelKey = payload.a?.key ?? 'builtin:crunch';
    const ampEntry = getAmpModelEntry(ampModelKey);
    const ampCategory = getAmpModelCategory(ampModelKey);

    let cabId = 'gb4x12';
    let cabValues: Record<string, number> = {};
    if (payload.b?.id) {
      try {
        const def = getCabDef(payload.b.id);
        cabId = def.id;
        cabValues = clampValues(def.params, payload.b.v);
      } catch {
        console.warn(`[share] 未知箱体 ${payload.b.id},使用默认`);
        cabValues = clampValues(getCabDef('gb4x12').params, {});
      }
    }

    // 箱头参数钳制(def 由型号 kind 解析:builtin→ref,其余→nam-wasm)
    const resolvedKey = ampEntry ? ampModelKey : 'builtin:crunch';
    const resolvedEntry = ampEntry ?? getAmpModelEntry(resolvedKey)!;
    const ampDefId =
      resolvedEntry.kind === 'builtin' ? resolvedEntry.ref : 'nam-wasm';
    const ampValues = clampValues(getAmpDef(ampDefId).params, payload.a?.v);

    return {
      chain,
      ampCategoryId: ampCategory?.id ?? 'crunch',
      ampModelKey: resolvedKey,
      ampEnabled: payload.a?.on !== 0,
      ampValues,
      cabId,
      cabEnabled: payload.b?.on !== 0,
      cabValues,
    };
  } catch {
    return null;
  }
}

export const SHARE_HASH_PREFIX = '#p=';

export function readShareFromLocation(loc: Location = window.location): ShareState | null {
  if (!loc.hash.startsWith(SHARE_HASH_PREFIX)) return null;
  return decodeShareState(loc.hash.slice(SHARE_HASH_PREFIX.length));
}

export function writeShareToLocation(state: ShareState, loc: Location = window.location): string {
  const url = `${loc.origin}${loc.pathname}${loc.search}${SHARE_HASH_PREFIX}${encodeShareState(state)}`;
  history.replaceState(null, '', url);
  return url;
}
