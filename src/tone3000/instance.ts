/**
 * Tone3000 生产单例(ADR-0007):真实 fetch + localStorage 令牌存储,
 * 并把模型文本提供者注册进 namWasm(resolveAmpModel 的 tone3000: 分支
 * 经此按用户身份下载模型)。客户端本体见 ./client.ts(可在 node 下测试)。
 */

import { createTone3000Client } from './client';
import { setTone3000ModelTextProvider } from '../audio/namWasm';

/** publishable key(官方明确浏览器可公开;申请记录见 .scratch/tone3000-provisioning.env) */
export const TONE3000_CLIENT_ID = 't3k_pub_lO_hzGrdnS3IJTurOy5GCEcDQkPOajmN';

export const tone3000 = createTone3000Client({
  clientId: TONE3000_CLIENT_ID,
  // 生产与 dev 各注册了一条 <origin>/tone3000/callback(见 provisioning 记录)
  redirectUri: `${window.location.origin}/tone3000/callback`,
  fetchFn: fetch.bind(window),
  storage: window.localStorage,
});

setTone3000ModelTextProvider((toneId) => tone3000.getModelText(toneId));
