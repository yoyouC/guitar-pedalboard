# 音色广场后端开发

后端提供公开 Published Preset、显式发布、独立成员认证与创作者资料。核心位于 `server/`，使用标准 Web `Request` / `Response`；`api/` 是 Vercel 薄入口，Vite 开发中间件使用相同核心、内存认证和确定性 demo seed。

## 本地走通 demo

```bash
npm run dev
open http://localhost:5173/marketplace/presets/preset-demo-crunch
```

本地开发不要求数据库。页面可读取 demo Published Preset、展示当前不可变修订和资源依赖，并在音频输入启动后应用到当前 Rig 和会话内撤销。应用时会记录固定作品/修订来源；来源随本地 Preset 保存与编辑保留，只有明确从空白或出厂 Rig 开始才清除。

本地“登录 / 创作者”面板发送魔法链接后，开发服务器会把一次性链接写到终端；仅用于本机开发，不接触 Resend。打开链接即可建立本地 session、编辑资料并查看公开创作者页。登录后可从当前完整 Rig 或所选本地 Preset 打开发布预览：无来源时创建新作品，他人来源创建带固定来源的 Remix，自己的来源默认追加原作品的新修订。
如果用非默认 host/port 启动 Vite，同时设置 `VITE_DEV_AUTH_BASE_URL` 为浏览器实际 origin。

## PostgreSQL

生产环境设置 `DATABASE_URL`（也兼容 `POSTGRES_URL`），然后依次运行：

```bash
npm run marketplace:migrate
npm run marketplace:seed
```

迁移脚本按文件名顺序运行全部 SQL，创建成员、认证、handle claim、作品、修订、受控标签和 Rig 筛选投影。数据库约束保证每个作品都有属于自己的当前修订，修订更新和删除由 trigger 拒绝；Remix 的来源作品/修订使用成对复合外键固定，来源撤回不级联删除 Remix；handle claim 不删除，因此旧 handle 不会被其他成员占用。首发事务一次写入作品、不可变修订、标签关系和从 Rig 派生的筛选投影，任一步失败都会回滚。声音更新同样在一个事务内追加修订、推进当前指针并重建筛选投影；每条修订同时冻结当时的派生器材属性，回退直接复制旧 Rig 与该快照，不依赖当前器材目录，也不移动历史指针。账号期满清理需要由对应生命周期迁移建立专用受控路径。seed 命令幂等创建 `preset-demo-crunch`，提交后会调用统一重建器补齐全部搜索投影字段。

生产认证还需配置：

```bash
BETTER_AUTH_SECRET=至少32字符的随机密钥
BETTER_AUTH_URL=https://你的正式域名
RESEND_API_KEY=...
AUTH_EMAIL_FROM='Guitar Pedalboard <login@example.com>'
GOOGLE_CLIENT_ID=...          # 可选；必须与 secret 同时提供
GOOGLE_CLIENT_SECRET=...      # 可选
CRON_SECRET=至少16字符的独立随机密钥
MARKETPLACE_TRENDING_WINDOW_HOURS=168       # 可选，默认 7 天
MARKETPLACE_TRENDING_HALF_LIFE_HOURS=48    # 可选，默认 48 小时
```

Google OAuth 回调 URI 为 `https://你的域名/api/auth/callback/google`。魔法链接验证令牌在数据库中哈希保存、五分钟过期并且只能消费一次；本站不启用密码认证。相同邮箱不会自动连接 Google 身份，成员必须从资料面板显式发起“验证并绑定 Google”。

成员相关稳定入口：

- `POST /api/auth/sign-in/magic-link`
- `POST /api/auth/sign-in/social` 与登录后的 `POST /api/auth/link-social`
- `GET /api/marketplace/me`
- `PATCH /api/marketplace/me/profile`
- `GET /api/marketplace/creators/:handle`
- `GET /api/marketplace/tags`
- `GET|PUT|DELETE /api/marketplace/likes/presets/:id`
- `GET|PUT|DELETE /api/marketplace/likes/collections/:id`
- `GET /api/marketplace/me/likes`
- `GET /api/marketplace/popular/presets` 与 `GET /api/marketplace/popular/collections`
- `GET /api/marketplace/trending/presets` 与 `GET /api/marketplace/trending/collections`
- `POST /api/marketplace/presets`
- `GET /api/marketplace/presets/:id`（Public / Unlisted 当前修订）
- `GET /api/marketplace/presets/:id/revisions/:revisionId`（固定修订永久链接）
- `GET /api/marketplace/presets/:id/manage` 与 `GET /api/marketplace/presets/:id/revisions`（仅作者）
- `PATCH /api/marketplace/presets/:id/metadata`
- `POST /api/marketplace/presets/:id/revisions` 与 `POST /api/marketplace/presets/:id/revisions/:revisionId/restore`
- `PATCH /api/marketplace/presets/:id/visibility`

资料与作品管理写入携带 `expectedUpdatedAt` 做乐观并发检查；冲突返回 `409 preset_update_conflict` 及最新 `updatedAt/currentRevisionId/visibility`，客户端不会静默覆盖。公开创作者响应使用字段白名单，不包含邮箱、认证账户或第三方 token。发布请求只接受标题、纯文本介绍、1–5 个标签、schema 版本、完整 Rig，以及可选的来源作品/修订；来源必须真实存在、修订属于该作品、对发布者可引用且不是发布者自己的作品，自己的作品改走作者专属追加修订接口。owner、点赞数与排名全部由服务端拥有。写入前共用 `publishableRig` 边界执行无损 canonical 校验，并自行派生 Pedal、Amp、Cab 与精确 TONE3000 依赖；本机 NAM 和自定义 Cab IR 会被拒绝。

Public 作品进入公开发现；Unlisted 只通过直接链接访问，页面动态设置 `noindex,nofollow`；Withdrawn 对访客与不存在作品使用相同 404，但作者仍可通过管理入口恢复原作品 id。Hidden 不属于作者可写状态。

部署路由先把公开稳定 URL 转给 Vercel Function，再由最后的 SPA rewrite 处理前端页面。数据库未配置或查询失败时 API 返回稳定的 `503 marketplace_unavailable`；不存在和非公开作品统一返回 `404 published_preset_not_found`。

Trending 由 Vercel Cron 以五分钟目标周期重建，也可用 `npm run marketplace:rebuild-trending` 手动重建。任务只读取当前点赞事实、点赞时间和成员 `community_status`，取消点赞与封禁在下一次成功重建后从榜单排除；公开 API 不接受趋势权重或任何浏览/应用信号。定时入口只接受 Vercel 从 `CRON_SECRET` 生成的 Bearer 授权。
