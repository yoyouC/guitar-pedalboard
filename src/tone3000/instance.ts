/**
 * Tone3000 生产单例(ADR-0007):真实 fetch + localStorage 令牌存储,
 * 并把模型文本提供者注册进 namWasm(resolveAmpModel 的 tone3000: 分支
 * 经此按用户身份下载模型)。客户端本体见 ./client.ts(可在 node 下测试)。
 *
 * OAuth 以 popup 流程为主(issue #14 UAT:全页跳转丢页面)——主页面不跳转,
 * 回调在弹窗内经 postMessage 回传;弹窗被拦截时兜底为全页跳转 + return-rig stash。
 */

import { createTone3000Client } from './client';
import { clearTone3000ModelTextCache, setTone3000ModelTextProvider } from '../audio/namWasm';
import {
  relayToCallbackUrl,
  stashPendingIntent,
  stashReturnRig,
  type Tone3000PendingIntent,
  type Tone3000OAuthRelay,
} from './callback';

/** publishable key(官方明确浏览器可公开;于 Tone3000 Settings → API Keys 申请) */
export const TONE3000_CLIENT_ID = 't3k_pub_lO_hzGrdnS3IJTurOy5GCEcDQkPOajmN';

// 生产与 dev 各注册了一条 <origin>/tone3000/callback(见 provisioning 记录)
const redirectUri = `${window.location.origin}/tone3000/callback`;

export const tone3000 = createTone3000Client({
  clientId: TONE3000_CLIENT_ID,
  redirectUri,
  fetchFn: fetch.bind(window),
  storage: window.localStorage,
});

setTone3000ModelTextProvider((toneId, modelId) => tone3000.getModelText(toneId, modelId));

// ---------- 登录态的 UI 订阅面(仿 loadProgress 的 pub-sub) ----------

const authListeners = new Set<() => void>();
const emitAuth = () => {
  for (const listener of authListeners) listener();
};

export function subscribeTone3000Auth(listener: () => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export function getTone3000Authenticated(): boolean {
  return tone3000.isAuthenticated();
}

/** 登录后/登出后由 boot 或 UI 调用,通知订阅者刷新 */
export function notifyTone3000AuthChanged(): void {
  emitAuth();
}

// ---------- popup OAuth ----------

export interface Tone3000Selection {
  toneId: string;
  modelId?: string;
}

type PopupOutcome = { kind: 'blocked' } | { kind: 'done'; selection: Tone3000Selection | null };

/**
 * 弹窗授权:回传经 postMessage(opener 同源校验 + client.handleCallback 的
 * state 校验)交换令牌;用户关窗/取消/出错 → toneId null;弹窗被拦截 → blocked。
 */
function openOAuthPopup(url: string): Promise<PopupOutcome> {
  return new Promise((resolve) => {
    const popup = window.open(
      url,
      't3k_oauth',
      'width=480,height=700,left=200,top=100,toolbar=no,menubar=no,location=no,status=no,resizable=yes,scrollbars=yes',
    );
    if (!popup) {
      resolve({ kind: 'blocked' });
      return;
    }
    const cleanup = () => {
      window.clearInterval(timer);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as Tone3000OAuthRelay | undefined;
      if (data?.type !== 't3k_oauth_callback') return;
      cleanup();
      void (async () => {
        if (data.canceled || data.error || !data.code) {
          resolve({ kind: 'done', selection: null });
          return;
        }
        const result = await tone3000.handleCallback(relayToCallbackUrl(data, redirectUri));
        if (result.ok) notifyTone3000AuthChanged();
        resolve({
          kind: 'done',
          selection:
            result.ok && result.toneId
              ? { toneId: result.toneId, ...(result.modelId ? { modelId: result.modelId } : {}) }
              : null,
        });
      })();
    };
    const timer = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        resolve({ kind: 'done', selection: null });
      }
    }, 500);
    window.addEventListener('message', onMessage);
  });
}

/** 弹窗被拦截时的兜底:暂存当前 rig,整页跳转授权(boot 的 redirect 路径恢复) */
function fallbackToRedirect(
  encodedRig: string,
  url: string,
  intent?: Tone3000PendingIntent,
): void {
  stashReturnRig(encodedRig, window.localStorage);
  if (intent) stashPendingIntent(intent, window.localStorage);
  window.location.href = url;
}

/**
 * "浏览 TONE3000"(select 流程):弹窗选模型,返回选中的 toneId
 * (取消/失败返回 null);弹窗被拦截时兜底整页跳转(返回 null,页面随后跳转)。
 */
export async function browseTone3000(
  getEncodedRig: () => string,
  options: {
    intent?: Tone3000PendingIntent;
    gears?: 'amp' | 'pedal';
    architecture?: '2' | 'legacy';
  } = {},
): Promise<Tone3000Selection | null> {
  const { url } = await tone3000.buildAuthorizeUrl({
    prompt: 'select_tone',
    format: 'nam',
    ...(options.gears ? { gears: options.gears } : {}),
    ...(options.architecture === '2' ? { architecture: '2' as const } : {}),
  });
  const outcome = await openOAuthPopup(url);
  if (outcome.kind === 'blocked') {
    fallbackToRedirect(getEncodedRig(), url, options.intent);
    return null;
  }
  return outcome.selection;
}

/**
 * 纯登录(standard 流程,不选模型):用于降级通知的"登录 TONE3000"——
 * 登录成功后由调用方重试原模型,不强迫用户重选。
 */
export async function loginTone3000(getEncodedRig: () => string): Promise<boolean> {
  const { url } = await tone3000.buildAuthorizeUrl();
  const outcome = await openOAuthPopup(url);
  if (outcome.kind === 'blocked') {
    fallbackToRedirect(getEncodedRig(), url);
    return false;
  }
  return tone3000.isAuthenticated();
}

/**
 * 模型失效的修复入口(issue #14):load_tone 流程——TONE3000 校验访问权,
 * 失效时提供替代选择;返回(可能不同的)toneId。
 */
export async function replaceTone3000(
  toneId: string,
  getEncodedRig: () => string,
  options: {
    intent?: Tone3000PendingIntent;
    gears?: 'amp' | 'pedal';
    architecture?: '2' | 'legacy';
  } = {},
): Promise<Tone3000Selection | null> {
  const { url } = await tone3000.buildAuthorizeUrl({
    prompt: 'load_tone',
    toneId,
    format: 'nam',
    ...(options.gears ? { gears: options.gears } : {}),
    ...(options.architecture === '2' ? { architecture: '2' as const } : {}),
  });
  const outcome = await openOAuthPopup(url);
  if (outcome.kind === 'blocked') {
    fallbackToRedirect(getEncodedRig(), url, options.intent);
    return null;
  }
  return outcome.selection;
}

/** 登出并通知 UI */
export function logoutTone3000(): void {
  tone3000.logout();
  clearTone3000ModelTextCache();
  emitAuth();
}
