/**
 * Tone3000 生产单例(ADR-0007):真实 fetch + localStorage 令牌存储,
 * 并把模型文本提供者注册进 namWasm(resolveAmpModel 的 tone3000: 分支
 * 经此按用户身份下载模型)。客户端本体见 ./client.ts(可在 node 下测试)。
 */

import { createTone3000Client } from './client';
import { setTone3000ModelTextProvider } from '../audio/namWasm';
import { stashReturnRig } from './callback';

/** publishable key(官方明确浏览器可公开;于 Tone3000 Settings → API Keys 申请) */
export const TONE3000_CLIENT_ID = 't3k_pub_lO_hzGrdnS3IJTurOy5GCEcDQkPOajmN';

export const tone3000 = createTone3000Client({
  clientId: TONE3000_CLIENT_ID,
  // 生产与 dev 各注册了一条 <origin>/tone3000/callback(见 provisioning 记录)
  redirectUri: `${window.location.origin}/tone3000/callback`,
  fetchFn: fetch.bind(window),
  storage: window.localStorage,
});

setTone3000ModelTextProvider((toneId) => tone3000.getModelText(toneId));

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

/** "浏览 TONE3000":暂存当前 rig(整页跳转后恢复),跳转 OAuth Select 流程 */
export async function browseTone3000(getEncodedRig: () => string): Promise<void> {
  stashReturnRig(getEncodedRig(), window.localStorage);
  const { url } = await tone3000.buildAuthorizeUrl({ prompt: 'select_tone', format: 'nam' });
  window.location.href = url;
}

/**
 * 模型失效的修复入口(issue #14):load_tone 流程——TONE3000 校验访问权,
 * 失效时提供替代选择;回传(可能不同的)tone_id 由 boot 装载。
 * 暂存当前 rig 以便跳回后恢复。
 */
export async function replaceTone3000(toneId: string, getEncodedRig: () => string): Promise<void> {
  stashReturnRig(getEncodedRig(), window.localStorage);
  const { url } = await tone3000.buildAuthorizeUrl({
    prompt: 'load_tone',
    toneId,
    format: 'nam',
  });
  window.location.href = url;
}

/** 登出并通知 UI */
export function logoutTone3000(): void {
  tone3000.logout();
  emitAuth();
}
