import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { createMarketplaceApi } from './server/marketplace/api.ts'
import { demoPublishedPreset } from './server/marketplace/demoPreset.ts'
import { createMemoryPublishedPresetRepository } from './server/marketplace/memoryRepository.ts'

// 本地评估模型(models-local/,git-ignored,许可不允许公开分发):
// 仅开发期经此中间件提供;/models-local/** 不进入 dist,也不会被部署。
function serveLocalModels(): Plugin {
  const root = normalize(join(process.cwd(), 'models-local'))
  return {
    name: 'serve-local-models',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const url = decodeURIComponent(req.url.split('?')[0])
        const m = url.match(/^\/?models-local\/(.*)$/)
        if (!m) return next()
        const file = normalize(join(root, m[1]))
        if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
          return next()
        }
        res.setHeader('Content-Type', 'application/octet-stream')
        createReadStream(file).pipe(res)
      })
    },
  }
}

/** 开发期 API：用确定性种子跑同一 Request → Response 核心，不接触本地音频路径。 */
function serveMarketplaceApi(): Plugin {
  const api = createMarketplaceApi({
    publishedPresets: createMemoryPublishedPresetRepository([demoPublishedPreset]),
  })
  return {
    name: 'serve-marketplace-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/marketplace/')) return next()
        try {
          const headers = new Headers()
          for (const [key, value] of Object.entries(req.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
            else if (value !== undefined) headers.set(key, value)
          }
          const response = await api.fetch(
            new Request(new URL(req.url, 'http://localhost'), {
              method: req.method,
              headers,
            }),
          )
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (error) {
          next(error)
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // 相对路径构建:dist 可部署到任意子路径,也可本地直接用静态服务器打开
  base: '/',  // 回调子路径(/tone3000/callback)下相对 base 会把 assets 解析到子目录 404(白屏);本应用只挂根路径
  plugins: [react(), serveLocalModels(), serveMarketplaceApi()],
})
