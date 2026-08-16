/**
 * OAuth 回调的启动处理(ADR-0007):SPA 在 /tone3000/callback 着陆时
 * 判定 URL、分派客户端交换令牌;以及"跳转前暂存当前 rig"的
 * return-rig stash(整页跳转后当前 rig 会丢,借分享编码暂存)。
 * 纯函数 + 注入,node 下可测(tests/tone3000-callback.test.ts)。
 */

export interface OAuthCallbackOutcome {
  handled: boolean;
  toneId?: string;
  error?: string;
}

const CALLBACK_PATH = '/tone3000/callback';
const RETURN_RIG_KEY = 't3k_return_rig';

/**
 * 若是 OAuth 回调着陆(路径匹配且带 code/error 参数),交给客户端处理;
 * 否则 { handled: false }。调用方负责后续动作(装载 toneId / 清 URL)。
 */
export async function maybeHandleOAuthCallback(
  url: string,
  client: {
    handleCallback(callbackUrl: string): Promise<
      { ok: true; toneId?: string } | { ok: false; error: string }
    >;
  },
): Promise<OAuthCallbackOutcome> {
  const u = new URL(url);
  if (!u.pathname.endsWith(CALLBACK_PATH)) return { handled: false };
  if (!u.searchParams.get('code') && !u.searchParams.get('error')) {
    return { handled: false };
  }
  const result = await client.handleCallback(url);
  if (result.ok) return { handled: true, toneId: result.toneId };
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

export interface OAuthBootDeps {
  client: {
    handleCallback(callbackUrl: string): Promise<
      { ok: true; toneId?: string } | { ok: false; error: string }
    >;
  };
  storage: KeyValueStorage;
  /** 恢复跳转前暂存的 rig(分享编码) */
  applyShareRig(encoded: string): void;
  /** 装载选中的 tone(setAmpModel('tone3000', buildTone3000Key(toneId))) */
  applyTone(toneId: string): void;
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
  if (stashed) deps.applyShareRig(stashed);
  if (outcome.toneId) {
    deps.applyTone(outcome.toneId);
  } else if (outcome.error) {
    deps.onError(outcome.error);
  }
  deps.onSettled();
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

/** 从回调 URL 提取 relay 消息;非回调 URL(或无 code/error)返回 null */
export function relayFromCallbackUrl(url: string): Tone3000OAuthRelay | null {
  const u = new URL(url);
  if (!u.pathname.endsWith(CALLBACK_PATH)) return null;
  const code = u.searchParams.get('code');
  const error = u.searchParams.get('error');
  if (!code && !error) return null;
  return {
    type: 't3k_oauth_callback',
    code,
    state: u.searchParams.get('state'),
    tone_id: u.searchParams.get('tone_id'),
    model_id: u.searchParams.get('model_id'),
    error,
    canceled: u.searchParams.get('canceled') === 'true',
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
