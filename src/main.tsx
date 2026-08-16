import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
// Tone3000 生产单例:注册模型文本提供者(侧效应,见 tone3000/instance.ts)
import './tone3000/instance.ts'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
