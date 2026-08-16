import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
// TONE3000 生产单例:注册模型文本提供者(侧效应,见 tone3000/instance.ts)
import './tone3000/instance.ts'
import { tone3000, notifyTone3000AuthChanged } from './tone3000/instance.ts'
import { maybeHandleOAuthCallback, popReturnRig } from './tone3000/callback.ts'
import { rigStore } from './state/useRig.ts'
import { rigFromShare } from './state/rigStore.ts'
import { decodeShareState } from './state/share.ts'

// OAuth 回调着陆(ADR-0007):先恢复跳转前暂存的 rig,再装载选中的 tone;
// 处理完清掉回调 URL,避免刷新重复交换授权码
void (async () => {
  const outcome = await maybeHandleOAuthCallback(window.location.href, tone3000)
  if (!outcome.handled) return
  const stashed = popReturnRig(window.localStorage)
  if (stashed) {
    const share = decodeShareState(stashed)
    if (share) rigStore.applyRig(rigFromShare(share))
  }
  if (outcome.toneId) {
    rigStore.setAmpModel('tone3000', `tone3000:${outcome.toneId}`)
    notifyTone3000AuthChanged()
  } else if (outcome.error) {
    console.warn('[tone3000] OAuth 回调失败:', outcome.error)
    notifyTone3000AuthChanged()
  }
  history.replaceState(null, '', window.location.pathname.replace('/tone3000/callback', '') || '/')
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
