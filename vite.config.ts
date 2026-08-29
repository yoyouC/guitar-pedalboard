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
import { createPresetCollectionApi } from './server/collections/api.ts'
import { createMemoryPresetCollectionRepository } from './server/collections/memoryRepository.ts'
import type { MarketplaceTag, PresetCollection } from './shared/marketplace.ts'
import { createMarketplaceSearchApi } from './server/search/api.ts'
import { createMemoryMarketplaceDiscoveryRepository } from './server/search/memoryRepository.ts'
import { createMarketplaceLikesApi } from './server/likes/api.ts'
import { createMemoryMarketplaceLikeRepository } from './server/likes/memoryRepository.ts'
import { DEFAULT_MARKETPLACE_TRENDING_POLICY } from './server/trending/policy.ts'
import { createMemoryMarketplaceTrendingRepository } from './server/trending/memoryRepository.ts'
import { createMarketplaceModerationApi } from './server/moderation/api.ts'
import { createMemoryMarketplaceModerationRepository } from './server/moderation/memoryRepository.ts'
import { createMemoryMarketplaceWriteLimiter } from './server/abuse/memoryWriteLimiter.ts'
import { DEFAULT_MARKETPLACE_WRITE_POLICIES } from './server/abuse/policy.ts'
import { createMarketplaceAccountApi } from './server/accounts/api.ts'
import { createMemoryMarketplaceAccountRepository } from './server/accounts/memoryRepository.ts'
import {
  AccountDeletionPendingError,
  assertAccountActive,
  assertCommunityWriteAllowed,
} from './server/members/standing.ts'

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
  const devAuthStore: Record<string, Array<Record<string, unknown>>> = {
    marketplace_auth_users: [],
    marketplace_auth_sessions: [],
    marketplace_auth_accounts: [],
    marketplace_auth_verifications: [],
  }
  const auth = createPlatformAuth({
    baseURL: devAuthBaseURL,
    secret: 'local-development-secret-at-least-32-characters',
    trustedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    database: memoryAdapter(devAuthStore),
    sendMagicLink: ({ email, url }) => {
      console.info(`[dev auth] ${email}: ${url}`)
    },
  })
  const demoCreatedAt = new Date(demoPublishedPreset.createdAt)
  const members = createMemoryMemberRepository([{
    id: demoPublishedPreset.creator.id,
    authUserId: null,
    handle: demoPublishedPreset.creator.handle,
    displayName: demoPublishedPreset.creator.displayName,
    bio: 'Official Guitar Pedalboard demo tones.',
    avatarUrl: null,
    handleChangedAt: null,
    termsAcceptedVersion: '2026-08-29',
    publicProfileCompletedAt: demoCreatedAt,
    createdAt: demoCreatedAt,
    updatedAt: demoCreatedAt,
  }], [{ handle: 'guitar-pedalboard-old', memberId: demoPublishedPreset.creator.id }])
  const marketplaceTags: Array<MarketplaceTag & { aliases: string[] }> = [
    { id: 'tone-clean', dimension: 'tone', nameZh: '清音', nameEn: 'Clean', aliases: ['clean tone'] },
    { id: 'tone-crunch', dimension: 'tone', nameZh: 'Crunch', nameEn: 'Crunch', aliases: ['crunch tone', 'overdrive'] },
    { id: 'tone-high-gain', dimension: 'tone', nameZh: '高增益', nameEn: 'High Gain', aliases: ['high-gain', 'distortion'] },
    { id: 'genre-blues', dimension: 'genre', nameZh: '布鲁斯', nameEn: 'Blues', aliases: ['blues'] },
    { id: 'genre-rock', dimension: 'genre', nameZh: '摇滚', nameEn: 'Rock', aliases: ['rock'] },
    { id: 'use-live', dimension: 'use', nameZh: '现场', nameEn: 'Live', aliases: ['stage'] },
    { id: 'use-recording', dimension: 'use', nameZh: '录音', nameEn: 'Recording', aliases: ['studio'] },
  ]
  const writeAllowed = async (memberId: string) => {
    const member = await members.findById(memberId)
    if (!member) throw new Error('Member not found')
    assertCommunityWriteAllowed(member)
  }
  const contentRestorable = async (memberId: string) => {
    const member = await members.findById(memberId)
    if (!member) throw new AccountDeletionPendingError()
    assertAccountActive(member)
  }
  const demoUnlistedPreset = {
    ...structuredClone(demoPublishedPreset),
    id: 'preset-demo-unlisted',
    title: 'Secret Demo Tone',
    description: 'Direct-link-only development fixture.',
    visibility: 'unlisted' as const,
    currentRevision: {
      ...structuredClone(demoPublishedPreset.currentRevision),
      id: 'revision-demo-unlisted-1',
    },
  }
  const publications = createMemoryPublishedPresetRepository(
    [demoPublishedPreset, demoUnlistedPreset],
    marketplaceTags,
    writeAllowed,
  )
  const writeLimiter = createMemoryMarketplaceWriteLimiter(DEFAULT_MARKETPLACE_WRITE_POLICIES)
  const sessions = createBetterAuthSessionVerifier(auth.api)
  const presetApi = createMarketplaceApi({
    publishedPresets: publications,
    availableTags: publications,
    publication: {
      repository: publications,
      sessions,
      members,
      now: () => new Date(),
      createPresetId: () => `preset-${crypto.randomUUID()}`,
      createRevisionId: () => `revision-${crypto.randomUUID()}`,
      createMemberId: () => crypto.randomUUID(),
      createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
      writeLimiter,
    },
  })
  const memberApi = createMemberApi({
    members,
    sessions,
    now: () => new Date(),
    createId: () => crypto.randomUUID(),
    createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    publicWorks: createMemoryPublicCreatorWorks([demoPublishedPreset]),
  })
  const demoCollection: PresetCollection = {
    id: 'collection-demo-stage-tones',
    title: 'Demo Stage Tones',
    description: 'A fixed-revision collection for local development.',
    visibility: 'public',
    creator: demoPublishedPreset.creator,
    tags: demoPublishedPreset.tags,
    items: [{
      position: 0,
      presetId: demoPublishedPreset.id,
      revisionId: demoPublishedPreset.currentRevision.id,
      availability: 'available',
      title: demoPublishedPreset.title,
      creator: demoPublishedPreset.creator,
    }],
    createdAt: demoPublishedPreset.createdAt,
    updatedAt: demoPublishedPreset.updatedAt,
  }
  const collections = createMemoryPresetCollectionRepository(
    [demoCollection],
    publications,
    marketplaceTags,
    writeAllowed,
  )
  const collectionApi = createPresetCollectionApi({
    collections,
    management: {
      repository: collections,
      sessions,
      members,
      now: () => new Date(),
      createCollectionId: () => `collection-${crypto.randomUUID()}`,
      createMemberId: () => crypto.randomUUID(),
      createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    },
  })
  const searchApi = createMarketplaceSearchApi({
    presets: publications,
    discovery: createMemoryMarketplaceDiscoveryRepository({
      collections: () => collections.listForDiscovery(),
      members: () => members.listForDiscovery(),
    }),
  })
  const bannedMemberIds = new Set<string>()
  const likes = createMemoryMarketplaceLikeRepository({
    presets: [demoPublishedPreset],
    collections: [demoCollection],
    bannedMemberIds,
    writeAllowed,
  })
  const trending = createMemoryMarketplaceTrendingRepository({
    presets: [demoPublishedPreset],
    collections: [demoCollection],
    likes,
    bannedMemberIds,
  })
  const rebuildTrending = () => trending.rebuild({
    now: new Date(), policy: DEFAULT_MARKETPLACE_TRENDING_POLICY,
  })
  void rebuildTrending()
  const likesApi = createMarketplaceLikesApi({
    repository: likes,
    trending,
    sessions,
    members,
    now: () => new Date(),
    createMemberId: () => crypto.randomUUID(),
    createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    writeLimiter,
  })
  const moderation = createMemoryMarketplaceModerationRepository({
      targets: [
        {
          kind: 'preset', id: demoPublishedPreset.id,
          creatorId: demoPublishedPreset.creator.id, visibility: demoPublishedPreset.visibility,
        },
        {
          kind: 'collection', id: demoCollection.id,
          creatorId: demoCollection.creator.id, visibility: demoCollection.visibility,
        },
      ],
      setMemberStatus: async (memberId, status) => {
        await members.setCommunityStatus(memberId, status)
        if (status === 'banned') bannedMemberIds.add(memberId)
        else bannedMemberIds.delete(memberId)
      },
      setTargetVisibility: async (kind, targetId, visibility) => {
        if (kind === 'preset') await publications.setModerationVisibility(targetId, visibility)
        else await collections.setModerationVisibility(targetId, visibility)
        await likes.setTargetVisibility(kind, targetId, visibility)
      },
      standingChanged: async () => {
        await likes.rebuildCounts()
        await rebuildTrending()
      },
      writeAllowed,
      contentRestorable,
    })
  const moderationApi = createMarketplaceModerationApi({
    repository: moderation,
    sessions,
    members,
    adminAuthUserIds: new Set(
      (process.env.VITE_DEV_ADMIN_AUTH_USER_IDS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    ),
    now: () => new Date(),
    createId: () => crypto.randomUUID(),
    createMemberId: () => crypto.randomUUID(),
    createHandleSuffix: () => crypto.randomUUID().replaceAll('-', '').slice(0, 8),
    writeLimiter,
  })
  const removeAuthRows = (table: string, predicate: (row: Record<string, unknown>) => boolean) => {
    const rows = devAuthStore[table]
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (predicate(rows[index])) rows.splice(index, 1)
    }
  }
  const accountApi = createMarketplaceAccountApi({
    repository: createMemoryMarketplaceAccountRepository({
      members,
      emailForAuthUserId: (authUserId) => String(
        devAuthStore.marketplace_auth_users.find((row) => row.id === authUserId)?.email
          ?? 'local-development@example.invalid',
      ),
      lifecycle: {
        async exportData(memberId) {
          const [presets, collectionsData, liked, cases] = await Promise.all([
            publications.exportForAccount(memberId),
            collections.exportForAccount(memberId),
            likes.exportForAccount(memberId),
            moderation.exportForAccount(memberId),
          ])
          return {
            presets,
            collections: collectionsData,
            relationships: { ...liked, ...cases },
          }
        },
        async withdraw(memberId, now) {
          const snapshot = {
            presets: await publications.withdrawForAccountDeletion(memberId, now),
            collections: await collections.withdrawForAccountDeletion(memberId, now),
          }
          for (const presetId of Object.keys(snapshot.presets)) {
            await likes.setAccountTargetVisibility('preset', presetId, 'withdrawn')
            await moderation.setAccountTargetVisibility('preset', presetId, 'withdrawn')
          }
          for (const collectionId of Object.keys(snapshot.collections)) {
            await likes.setAccountTargetVisibility('collection', collectionId, 'withdrawn')
            await moderation.setAccountTargetVisibility('collection', collectionId, 'withdrawn')
          }
          return snapshot
        },
        async restore(memberId, snapshot, now) {
          const saved = snapshot as {
            presets: Awaited<ReturnType<typeof publications.withdrawForAccountDeletion>>
            collections: Awaited<ReturnType<typeof collections.withdrawForAccountDeletion>>
          }
          await publications.restoreForAccountDeletion(memberId, saved.presets, now)
          await collections.restoreForAccountDeletion(memberId, saved.collections, now)
          for (const [presetId, visibility] of Object.entries(saved.presets)) {
            await likes.setAccountTargetVisibility('preset', presetId, visibility)
            await moderation.setAccountTargetVisibility('preset', presetId, visibility)
          }
          for (const [collectionId, visibility] of Object.entries(saved.collections)) {
            await likes.setAccountTargetVisibility('collection', collectionId, visibility)
            await moderation.setAccountTargetVisibility('collection', collectionId, visibility)
          }
        },
        async purge(memberId, now) {
          const member = await members.findById(memberId)
          const email = member?.authUserId
            ? String(devAuthStore.marketplace_auth_users.find(
                (row) => row.id === member.authUserId,
              )?.email ?? '')
            : ''
          await likes.purgeAccount(memberId)
          await publications.purgeAccount(memberId, now)
          await collections.purgeAccount(memberId, now)
          if (member?.authUserId) {
            removeAuthRows('marketplace_auth_sessions', (row) => row.userId === member.authUserId)
            removeAuthRows('marketplace_auth_accounts', (row) => row.userId === member.authUserId)
            removeAuthRows('marketplace_auth_users', (row) => row.id === member.authUserId)
          }
          if (email) {
            removeAuthRows('marketplace_auth_verifications', (row) => (
              typeof row.value === 'string' && row.value.includes(`"email":"${email}"`)
            ))
          }
          await rebuildTrending()
        },
        async revokeAuth(authUserId, email) {
          removeAuthRows('marketplace_auth_sessions', (row) => row.userId === authUserId)
          removeAuthRows('marketplace_auth_verifications', (row) => (
            typeof row.value === 'string' && row.value.includes(`"email":"${email}"`)
          ))
        },
      },
    }),
    sessions,
    now: () => new Date(),
    cronSecret: 'local-account-cron',
  })
  return {
    name: 'serve-marketplace-api',
    configureServer(server) {
      const trendingInterval = setInterval(() => void rebuildTrending(), 5 * 60_000)
      server.httpServer?.once('close', () => clearInterval(trendingInterval))
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
            : req.url.startsWith('/api/marketplace/me/export')
              || req.url.startsWith('/api/marketplace/me/deletion')
              || req.url.startsWith('/api/internal/marketplace/purge-deleted-accounts')
              ? await accountApi.fetch(request)
            : req.url.startsWith('/api/marketplace/reports')
              || req.url.startsWith('/api/marketplace/infringement-notices')
              || req.url.startsWith('/api/marketplace/me/moderation')
              || req.url.startsWith('/api/marketplace/moderation/')
              || req.url.startsWith('/api/marketplace/admin/moderation/')
              ? await moderationApi.fetch(request)
            : req.url.startsWith('/api/marketplace/likes/')
              || req.url.startsWith('/api/marketplace/popular/')
              || req.url.startsWith('/api/marketplace/trending/')
              || req.url.startsWith('/api/marketplace/me/likes')
              ? await likesApi.fetch(request)
            : req.url.startsWith('/api/marketplace/me')
              || req.url.startsWith('/api/marketplace/creators/')
              ? await memberApi.fetch(request)
              : req.url.startsWith('/api/marketplace/collections')
                ? await collectionApi.fetch(request)
              : req.url.startsWith('/api/marketplace/search/')
                ? await searchApi.fetch(request)
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
