import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
// TONE3000 生产单例必须先于 App 链 evaluate:rigStore 创建时会恢复初始 rig
// 并触发 tone3000 可用性检查,provider 须已注册(issue #14 手动验收发现)
import './tone3000/instance.ts'
import App from './App.tsx'
import { tone3000, notifyTone3000AuthChanged } from './tone3000/instance.ts'
import { handleOAuthCallbackBoot, relayFromCallbackUrl } from './tone3000/callback.ts'
import { rigStore } from './state/useRig.ts'
import { rigFromShare } from './state/rigStore.ts'
import { decodeShareState } from './state/share.ts'
import { buildTone3000Key } from './audio/namWasm.ts'

// OAuth 回调着陆(ADR-0007)分两种:
// 1) popup 流程(默认):回调在弹窗内着陆,把参数 postMessage 回 opener 后关窗,
//    主页面从未跳转;弹窗自己不再走 boot(否则授权码被消费两次)
// 2) redirect 兜底(弹窗被拦截):编排见 tone3000/callback.ts
const relay = relayFromCallbackUrl(window.location.href)
if (relay && window.opener) {
  window.opener.postMessage(relay, window.location.origin)
  window.close()
} else {
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
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
