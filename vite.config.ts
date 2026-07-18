import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // 相对路径构建:dist 可部署到任意子路径,也可本地直接用静态服务器打开
  base: './',
  plugins: [react()],
})
