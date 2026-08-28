import type { ChainItem } from './store';
import { RIG_PRESET_CATALOG } from './store';
import { normalizeRig } from './presetCodec';
import type { CabIrRef } from '../audio/cabIrTypes';
import { isBuiltinCabId } from '../audio/cabIrTypes';

/**
 * 效果链/箱头/箱体配置的 URL 分享编码。
 * 格式:`#p=` + base64url(JSON),字段全用短名控制长度,带版本号 v 向前兼容。
 * 编码层只负责压缩;decode 后的 normalize/clamp 统一走 presetCodec 的
 * catalog 路径(ADR-0006):未知 effectId/型号/箱体回退目录默认,
 * 参数值按 presetCodec 严格语义(非 number 回退默认)钳制到定义范围。
 */

export interface ShareState {
  chain: ChainItem[];
  ampCategoryId: string;
  ampModelKey: string;
  ampModelId?: string;
  ampEnabled: boolean;
  ampValues: Record<string, number>;
  cabId: string;
  cabIrRef?: CabIrRef;
  cabEnabled: boolean;
  cabValues: Record<string, number>;
}

interface SharePayload {
  v: 1 | 2 | 3;
  c: { id: string; e: 0 | 1; v: Record<string, number>; p?: 0 | 1; r?: string; m?: string }[];
  a?: { cat: string; key: string; on: 0 | 1; v: Record<string, number>; m?: string };
  b?: {
    id: string;
    on: 0 | 1;
    v: Record<string, number>;
    r?: { k: 'b'; i: string } | { k: 'c'; h: string };
  };
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

/** 解码失败返回 null(调用方忽略);normalize/clamp 走 catalog 统一路径 */
export function decodeShareState(encoded: string): ShareState | null {
  try {
    const payload = JSON.parse(base64urlDecode(encoded)) as SharePayload;
    if ((payload?.v !== 1 && payload?.v !== 2 && payload?.v !== 3) || !Array.isArray(payload.c)) return null;

    // payload → canonical 形状的原始输入,交给 presetCodec 统一规范化
    const rig = normalizeRig(
      {
        chain: payload.c.map((item) => ({
          effectId: item?.id,
          modelRef: payload.v >= 2 ? item?.r : undefined,
          modelId: payload.v >= 2 ? item?.m : undefined,
          enabled: typeof item?.e === 'number' ? item.e !== 0 : undefined,
          values: item?.v,
          post: typeof item?.p === 'number' ? item.p === 1 : undefined,
        })),
        amp: payload.a
          ? {
              categoryId: payload.a.cat,
              modelKey: payload.a.key,
              enabled: payload.a.on !== 0,
              values: payload.a.v,
              customName: null,
              modelId: payload.v >= 2 ? payload.a.m : undefined,
            }
          : undefined,
        cab: payload.b
          ? {
              id: payload.b.id,
              ir: payload.v === 3 && payload.b.r
                ? payload.b.r.k === 'c'
                  ? { kind: 'custom', hash: payload.b.r.h }
                  : { kind: 'builtin', id: payload.b.r.i }
                : undefined,
              enabled: payload.b.on !== 0,
              values: payload.b.v,
            }
          : undefined,
        globals: undefined,
      },
      RIG_PRESET_CATALOG,
    );

    return {
      chain: rig.chain.map((item) => ({ ...item, uid: crypto.randomUUID() })),
      ampCategoryId: rig.amp.categoryId,
      ampModelKey: rig.amp.modelKey,
      ...(rig.amp.modelId ? { ampModelId: rig.amp.modelId } : {}),
      ampEnabled: rig.amp.enabled,
      ampValues: rig.amp.values,
      cabId: rig.cab.id,
      cabIrRef: rig.cab.ir,
      cabEnabled: rig.cab.enabled,
      cabValues: rig.cab.values,
    };
  } catch {
    return null;
  }
}

export function encodeShareState(state: ShareState): string {
  const payload: SharePayload = {
    v: 3,
    c: state.chain.map((i) => ({
      id: i.effectId,
      e: i.enabled ? 1 : 0,
      v: i.values,
      p: i.post ? 1 : 0,
      ...(i.modelRef ? { r: i.modelRef } : {}),
      ...(i.modelId ? { m: i.modelId } : {}),
    })),
    a: {
      cat: state.ampCategoryId,
      key: state.ampModelKey,
      on: state.ampEnabled ? 1 : 0,
      v: state.ampValues,
      ...(state.ampModelId ? { m: state.ampModelId } : {}),
    },
    b: {
      id: state.cabId,
      on: state.cabEnabled ? 1 : 0,
      v: state.cabValues,
      r: state.cabIrRef?.kind === 'custom'
        ? { k: 'c', h: state.cabIrRef.hash }
        : {
            k: 'b',
            i: state.cabIrRef?.kind === 'builtin'
              ? state.cabIrRef.id
              : isBuiltinCabId(state.cabId) ? state.cabId : 'gb4x12',
          },
    },
  };
  return base64urlEncode(JSON.stringify(payload));
}

export const SHARE_HASH_PREFIX = '#p=';

/**
 * 出厂初始配置(进入页面且无 URL 分享参数时的初始预设):
 * DynaComp → Klon WDF → Analog Delay → Spring Reverb(后两块 FX Loop),
 * JCM800 sweep NAM 箱头 + GB 4x12 箱体。
 * 与用户分享的 #p= 编码同格式,可随时用新分享链接的编码替换。
 */
export const DEFAULT_RIG_ENCODED =
  'eyJ2IjoxLCJjIjpbeyJpZCI6ImR5bmFjb21wIiwiZSI6MSwidiI6eyJzZW5zaXRpdml0eSI6NTUsImxldmVsIjowfSwicCI6MH0seyJpZCI6Imtsb253ZGYiLCJlIjoxLCJ2Ijp7ImdhaW4iOjIyLCJ0cmVibGUiOjUwLCJsZXZlbCI6LTExLjV9LCJwIjowfSx7ImlkIjoiYW5hbG9nZGVsYXkiLCJlIjoxLCJ2Ijp7InRpbWUiOjMwMCwiZmVlZGJhY2siOjYyLCJ0b25lIjo1NSwibW9kIjowLCJtaXgiOjM1fSwicCI6MX0seyJpZCI6InNwcmluZ3JldmVyYiIsImUiOjEsInYiOnsidGltZSI6MiwiZHdlbGwiOjUwLCJ0b25lIjo1MCwibWl4IjozMH0sInAiOjF9XSwiYSI6eyJjYXQiOiJjcnVuY2giLCJrZXkiOiJuYW0td2FzbS1wYWNrOmpjbTgwMC1zd2VlcCIsIm9uIjoxLCJ2Ijp7ImdhaW4iOjY0LCJiYXNzIjo1MCwibWlkIjo1MCwidHJlYmxlIjoxNSwicHJlc2VuY2UiOjUwLCJtYXN0ZXIiOjB9fSwiYiI6eyJpZCI6ImdiNHgxMiIsIm9uIjoxLCJ2Ijp7ImxldmVsIjotMTMuNX19fQ';

export function readShareFromLocation(loc: Location = window.location): ShareState | null {
  if (!loc.hash.startsWith(SHARE_HASH_PREFIX)) return null;
  return decodeShareState(loc.hash.slice(SHARE_HASH_PREFIX.length));
}

export function writeShareToLocation(state: ShareState, loc: Location = window.location): string {
  const url = `${loc.origin}${loc.pathname}${loc.search}${SHARE_HASH_PREFIX}${encodeShareState(state)}`;
  history.replaceState(null, '', url);
  return url;
}
