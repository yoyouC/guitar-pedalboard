import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
// TONE3000 生产单例:注册模型文本提供者(侧效应,见 tone3000/instance.ts)
import './tone3000/instance.ts'
import { tone3000, notifyTone3000AuthChanged } from './tone3000/instance.ts'
import { handleOAuthCallbackBoot } from './tone3000/callback.ts'
import { rigStore } from './state/useRig.ts'
import { rigFromShare } from './state/rigStore.ts'
import { decodeShareState } from './state/share.ts'
import { buildTone3000Key } from './audio/namWasm.ts'

// OAuth 回调着陆(ADR-0007):编排见 tone3000/callback.ts;
// 处理完清掉回调 URL,避免刷新重复交换授权码
void handleOAuthCallbackBoot(window.location.href, {
  client: tone3000,
  storage: window.localStorage,
  applyShareRig: (encoded) => {
    const share = decodeShareState(encoded)
    if (share) rigStore.applyRig(rigFromShare(share))
  },
  applyTone: (toneId) => rigStore.setAmpModel('tone3000', buildTone3000Key(toneId)),
  onSettled: () => notifyTone3000AuthChanged(),
  onError: (error) => console.warn('[tone3000] OAuth 回调失败:', error),
}).then((handled) => {
  if (handled) {
    history.replaceState(null, '', window.location.pathname.replace('/tone3000/callback', '') || '/')
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
