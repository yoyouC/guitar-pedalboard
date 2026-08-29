import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { createMarketplaceApi } from './server/marketplace/api.ts'
import { demoPublishedPreset } from './server/marketplace/demoPreset.ts'
import { createMemoryPublishedPresetRepository } from './server/marketplace/memoryRepository.ts'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { createPlatformAuth } from './server/auth/betterAuth.ts'
import { createBetterAuthSessionVerifier } from './server/auth/betterAuthSession.ts'
import { createMemberApi } from './server/members/api.ts'
import { createMemoryMemberRepository } from './server/members/memoryRepository.ts'
import { createMemoryPublicCreatorWorks } from './server/members/works.ts'

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
  const devAuthBaseURL = process.env.VITE_DEV_AUTH_BASE_URL ?? 'http://localhost:5173'
  const presetApi = createMarketplaceApi({
    publishedPresets: createMemoryPublishedPresetRepository([demoPublishedPreset]),
  })
  const auth = createPlatformAuth({
    baseURL: devAuthBaseURL,
    secret: 'local-development-secret-at-least-32-characters',
    trustedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    database: memoryAdapter({
      marketplace_auth_users: [],
      marketplace_auth_sessions: [],
      marketplace_auth_accounts: [],
      marketplace_auth_verifications: [],
    }),
    sendMagicLink: ({ email, url }) => {
      console.info(`[dev auth] ${email}: ${url}`)
    },
  })
  const demoCreatedAt = new Date(demoPublishedPreset.createdAt)
  const memberApi = createMemberApi({
    members: createMemoryMemberRepository([{
      id: demoPublishedPreset.creator.id,
      authUserId: null,
      handle: demoPublishedPreset.creator.handle,
      displayName: demoPublishedPreset.creator.displayName,
      bio: 'Official Guitar Pedalboard demo tones.',
      avatarUrl: null,
      handleChangedAt: null,
      createdAt: demoCreatedAt,
      updatedAt: demoCreatedAt,
    }]),
    sessions: createBetterAuthSessionVerifier(auth.api),
    now: () => new Date(),
    createId: () => crypto.randomUUID(),
    createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    publicWorks: createMemoryPublicCreatorWorks([demoPublishedPreset]),
  })
  return {
    name: 'serve-marketplace-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/marketplace/') && !req.url?.startsWith('/api/auth/')) {
          return next()
        }
        try {
          const headers = new Headers()
          for (const [key, value] of Object.entries(req.headers)) {
            if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
            else if (value !== undefined) headers.set(key, value)
          }
          const body = req.method === 'GET' || req.method === 'HEAD'
            ? undefined
            : await new Promise<Buffer>((resolve, reject) => {
                const chunks: Buffer[] = []
                req.on('data', (chunk: Buffer) => chunks.push(chunk))
                req.on('end', () => resolve(Buffer.concat(chunks)))
                req.on('error', reject)
              })
          const requestOrigin = `http://${req.headers.host ?? new URL(devAuthBaseURL).host}`
          const request = new Request(new URL(req.url, requestOrigin), {
            method: req.method,
            headers,
            ...(body && body.length > 0 ? { body: body.toString() } : {}),
          })
          const response = req.url.startsWith('/api/auth/')
            ? await auth.handler(request)
            : req.url.startsWith('/api/marketplace/me')
              || req.url.startsWith('/api/marketplace/creators/')
              ? await memberApi.fetch(request)
              : await presetApi.fetch(request)
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
