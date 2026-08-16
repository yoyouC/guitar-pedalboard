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
