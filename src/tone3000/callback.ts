/**
 * OAuth 回调的启动处理(ADR-0007):SPA 在 /tone3000/callback 着陆时
 * 判定 URL、分派客户端交换令牌;以及"跳转前暂存当前 rig"的
 * return-rig stash(整页跳转后当前 rig 会丢,借分享编码暂存)。
 * 纯函数 + 注入,node 下可测(tests/tone3000-callback.test.ts)。
 */

export interface OAuthCallbackOutcome {
  handled: boolean;
  toneId?: string;
  modelId?: string;
  error?: string;
  canceled?: boolean;
}

const CALLBACK_PATH = '/tone3000/callback';
const RETURN_RIG_KEY = 't3k_return_rig';
const PENDING_INTENT_KEY = 't3k_pending_intent';

export type Tone3000PendingIntent =
  | { kind: 'amp'; architecture: '2' | 'legacy' }
  | { kind: 'add-pedal'; architecture: '2' | 'legacy' }
  | {
      kind: 'replace-pedal';
      uid: string;
      architecture: '2' | 'legacy';
      /** Share Rig 恢复会重建 uid；用位置+原引用做安全重映射。 */
      returnIndex?: number;
      returnModelRef?: string;
    };

export interface Tone3000ReplaceCandidate {
  uid: string;
  effectId: string;
  modelRef?: string;
}

/** OAuth gear 是域意图的投影，避免 UI 另传一个可能冲突的值。 */
export function tone3000GearForIntent(intent: { kind: Tone3000PendingIntent['kind'] }): 'amp' | 'pedal' {
  return intent.kind === 'amp' ? 'amp' : 'pedal';
}

/** 优先使用仍有效的 uid；整页回跳后只在位置和原模型同时匹配时重映射。 */
export function resolvePendingReplaceUid(
  intent: Extract<Tone3000PendingIntent, { kind: 'replace-pedal' }>,
  chain: Tone3000ReplaceCandidate[],
): string | null {
  const byUid = chain.find(
    (item) => item.uid === intent.uid && item.effectId === 'tone3000Nam',
  );
  if (byUid) return byUid.uid;
  if (
    intent.returnIndex === undefined ||
    intent.returnModelRef === undefined ||
    !/^tone3000:\d+$/.test(intent.returnModelRef)
  ) {
    return null;
  }
  const restored = chain[intent.returnIndex];
  return restored?.effectId === 'tone3000Nam' && restored.modelRef === intent.returnModelRef
    ? restored.uid
    : null;
}

/**
 * 若是 OAuth 回调着陆(路径匹配且带 code/error 参数),交给客户端处理;
 * 否则 { handled: false }。调用方负责后续动作(装载 toneId / 清 URL)。
 */
export async function maybeHandleOAuthCallback(
  url: string,
  client: {
    handleCallback(callbackUrl: string): Promise<
      { ok: true; toneId?: string; modelId?: string } | { ok: false; error: string }
    >;
  },
): Promise<OAuthCallbackOutcome> {
  const u = new URL(url);
  if (!u.pathname.endsWith(CALLBACK_PATH)) return { handled: false };
  if (
    !u.searchParams.get('code') &&
    !u.searchParams.get('error') &&
    u.searchParams.get('canceled') !== 'true'
  ) {
    return { handled: false };
  }
  const result = await client.handleCallback(url);
  if (result.ok) {
    return {
      handled: true,
      ...(result.toneId ? { toneId: result.toneId } : {}),
      ...(result.modelId ? { modelId: result.modelId } : {}),
    };
  }
  if (result.error === 'canceled') return { handled: true, canceled: true };
  return { handled: true, error: result.error };
}

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 跳转 TONE3000 前暂存当前 rig 的分享编码(整页跳转后恢复用) */
export function stashReturnRig(encodedRig: string, storage: KeyValueStorage): void {
  storage.setItem(RETURN_RIG_KEY, encodedRig);
}

/** 取出并清除暂存的 rig(一次性) */
export function popReturnRig(storage: KeyValueStorage): string | null {
  const encoded = storage.getItem(RETURN_RIG_KEY);
  if (encoded !== null) storage.removeItem(RETURN_RIG_KEY);
  return encoded;
}

export function stashPendingIntent(
  intent: Tone3000PendingIntent,
  storage: KeyValueStorage,
): void {
  storage.setItem(PENDING_INTENT_KEY, JSON.stringify(intent));
}

export function popPendingIntent(storage: KeyValueStorage): Tone3000PendingIntent | null {
  const raw = storage.getItem(PENDING_INTENT_KEY);
  if (raw !== null) storage.removeItem(PENDING_INTENT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Tone3000PendingIntent>;
    const architecture = value.architecture;
    if (architecture !== '2' && architecture !== 'legacy') return null;
    if (value.kind === 'amp' || value.kind === 'add-pedal') {
      return { kind: value.kind, architecture };
    }
    if (value.kind === 'replace-pedal' && typeof value.uid === 'string' && value.uid) {
      const returnIndex =
        Number.isInteger(value.returnIndex) && Number(value.returnIndex) >= 0
          ? Number(value.returnIndex)
          : undefined;
      const returnModelRef =
        typeof value.returnModelRef === 'string' && /^tone3000:\d+$/.test(value.returnModelRef)
          ? value.returnModelRef
          : undefined;
      return {
        kind: value.kind,
        uid: value.uid,
        architecture,
        ...(returnIndex !== undefined ? { returnIndex } : {}),
        ...(returnModelRef ? { returnModelRef } : {}),
      };
    }
    return null;
  } catch {
    return null;
  }
}

export interface OAuthBootDeps {
  client: {
    handleCallback(callbackUrl: string): Promise<
      { ok: true; toneId?: string; modelId?: string } | { ok: false; error: string }
    >;
  };
  storage: KeyValueStorage;
  /** 恢复跳转前暂存的 rig(分享编码) */
  applyShareRig(encoded: string): void | Promise<void>;
  /** 装载选中的 tone(setAmpModel('tone3000', buildTone3000Key(toneId))) */
  applyTone(
    toneId: string,
    modelId: string | undefined,
    intent: Tone3000PendingIntent | null,
  ): void | Promise<void>;
  /** 回调已处理完毕(无论成败):通知登录态订阅者刷新 */
  onSettled(): void;
  onError(error: string): void;
}

/**
 * OAuth 回调着陆的完整启动编排(ADR-0007):
 * 判定回调 → 恢复暂存 rig → 装载选中的 tone → 通知登录态。
 * 返回是否为本流程处理;调用方(main.tsx)负责清回调 URL。
 */
export async function handleOAuthCallbackBoot(
  url: string,
  deps: OAuthBootDeps,
): Promise<boolean> {
  const outcome = await maybeHandleOAuthCallback(url, deps.client);
  if (!outcome.handled) return false;
  const stashed = popReturnRig(deps.storage);
  const intent = popPendingIntent(deps.storage);
  try {
    if (stashed) await deps.applyShareRig(stashed);
    if (outcome.toneId) {
      await deps.applyTone(outcome.toneId, outcome.modelId, intent);
    } else if (outcome.error && !outcome.canceled) {
      deps.onError(outcome.error);
    }
  } catch (error) {
    deps.onError(error instanceof Error ? error.message : String(error));
  } finally {
    deps.onSettled();
  }
  return true;
}

// ---------- popup 流程(issue #14 UAT:全页跳转丢页面,改弹窗授权) ----------

/** popup 回传的消息形状(回调页在弹窗内 postMessage 给 opener) */
export interface Tone3000OAuthRelay {
  type: 't3k_oauth_callback';
  code: string | null;
  state: string | null;
  tone_id?: string | null;
  model_id?: string | null;
  error?: string | null;
  canceled?: boolean;
}

/** 从回调 URL 提取 relay 消息;非回调 URL(或无 code/error/canceled)返回 null */
export function relayFromCallbackUrl(url: string): Tone3000OAuthRelay | null {
  const u = new URL(url);
  if (!u.pathname.endsWith(CALLBACK_PATH)) return null;
  const code = u.searchParams.get('code');
  const error = u.searchParams.get('error');
  const canceled = u.searchParams.get('canceled') === 'true';
  if (!code && !error && !canceled) return null;
  return {
    type: 't3k_oauth_callback',
    code,
    state: u.searchParams.get('state'),
    tone_id: u.searchParams.get('tone_id'),
    model_id: u.searchParams.get('model_id'),
    error,
    canceled,
  };
}

/** 把 popup 回传的消息还原为回调 URL(复用 client.handleCallback 的 state 校验) */
export function relayToCallbackUrl(relay: Tone3000OAuthRelay, redirectUri: string): string {
  const params = new URLSearchParams();
  if (relay.code) params.set('code', relay.code);
  if (relay.state) params.set('state', relay.state);
  if (relay.tone_id) params.set('tone_id', relay.tone_id);
  if (relay.model_id) params.set('model_id', relay.model_id);
  if (relay.error) params.set('error', relay.error);
  if (relay.canceled) params.set('canceled', 'true');
  return `${redirectUri}?${params.toString()}`;
}
