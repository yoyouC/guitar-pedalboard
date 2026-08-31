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

生产 Functions 把提供商的 pooled URL 配置为 `MARKETPLACE_RUNTIME_DATABASE_URL`；它与
Vercel Functions suspension 生命周期绑定，默认每个 Function 实例最多保留两个连接、
空闲五秒释放、连接两秒超时、查询十五秒超时。`MARKETPLACE_DATABASE_POOL_MAX`、
`MARKETPLACE_DATABASE_IDLE_TIMEOUT_MS`、`MARKETPLACE_DATABASE_CONNECTION_TIMEOUT_MS` 和
`MARKETPLACE_DATABASE_QUERY_TIMEOUT_MS` 可以在既定安全范围内覆盖默认值。

迁移需要跨多个事务持有 session advisory lock，不得使用 transaction-mode pooler。把数据库
提供商的 direct URL 单独配置为 `MARKETPLACE_MIGRATION_DATABASE_URL`；本地仍兼容
`DATABASE_URL` 或 `POSTGRES_URL`。然后依次运行：

```bash
npm run marketplace:migrate
npm run marketplace:seed
```

迁移脚本在专用 PostgreSQL session 上取得 advisory lock，按文件名顺序执行尚未记录的 SQL，并把文件名和 SHA-256 摘要与 schema 变更放入同一事务。重复执行只校验摘要；已应用文件发生变化会拒绝发布，迁移 runner 因而必须作为串行 release job 运行，不能放入并发的 Vercel build。迁移创建成员、认证、handle claim、作品、修订、受控标签和 Rig 筛选投影。数据库约束保证每个作品都有属于自己的当前修订，修订更新和删除由 trigger 拒绝；Remix 的来源作品/修订使用成对复合外键固定，来源撤回不级联删除 Remix；handle claim 不删除，因此旧 handle 不会被其他成员占用。首发事务一次写入作品、不可变修订、标签关系和从 Rig 派生的筛选投影，任一步失败都会回滚。声音更新同样在一个事务内追加修订、推进当前指针并重建筛选投影；每条修订同时冻结当时的派生器材属性，回退直接复制旧 Rig 与该快照，不依赖当前器材目录，也不移动历史指针。账号生命周期迁移记录 30 天恢复窗口和仅限本次注销撤回的可见性快照，并为到期清除提供只能擦除 Rig/依赖/派生属性、不能恢复正文的受控修订路径。seed 命令幂等创建 `preset-demo-crunch`，提交后会调用统一重建器补齐全部搜索投影字段。

生产认证还需配置：

```bash
BETTER_AUTH_SECRET=至少32字符的随机密钥
BETTER_AUTH_URL=https://你的正式域名
RESEND_API_KEY=...
AUTH_EMAIL_FROM='Guitar Pedalboard <login@example.com>'
MARKETPLACE_RUNTIME_DATABASE_URL=postgresql://运行时连接池地址
GOOGLE_CLIENT_ID=...          # 可选；必须与 secret 同时提供
GOOGLE_CLIENT_SECRET=...      # 可选
CRON_SECRET=至少16字符的独立随机密钥
MARKETPLACE_TRENDING_WINDOW_HOURS=168       # 可选，默认 7 天
MARKETPLACE_TRENDING_HALF_LIFE_HOURS=48    # 可选，默认 48 小时
MARKETPLACE_ADMIN_AUTH_USER_IDS=auth-user-id-1,auth-user-id-2
```

`MARKETPLACE_MIGRATION_DATABASE_URL` 仅保存到受控 release runner，不进入 Vercel Function
环境。

Google OAuth 回调 URI 为 `https://你的域名/api/auth/callback/google`。魔法链接验证令牌在数据库中哈希保存、五分钟过期并且只能消费一次；本站不启用密码认证。相同邮箱不会自动连接 Google 身份，成员必须从资料面板显式发起“验证并绑定 Google”。

成员相关稳定入口：

- `POST /api/auth/sign-in/magic-link`
- `POST /api/auth/sign-in/social` 与登录后的 `POST /api/auth/link-social`
- `GET /api/marketplace/me`
- `PATCH /api/marketplace/me/profile`
- `GET /api/marketplace/me/export`（私有、不可缓存的机器可读平台数据）
- `GET|POST|DELETE /api/marketplace/me/deletion`（查看、申请与再次验证后的取消注销）
- `GET /api/marketplace/creators/:handle`
- `GET /api/marketplace/creators/id/:memberId`（创作者 canonical 身份；旧 handle 链接继续解析并跳转）
- `GET /api/marketplace/tags`
- `GET|PUT|DELETE /api/marketplace/likes/presets/:id`
- `GET|PUT|DELETE /api/marketplace/likes/collections/:id`
- `GET /api/marketplace/me/likes`
- `GET /api/marketplace/popular/presets` 与 `GET /api/marketplace/popular/collections`
- `GET /api/marketplace/trending/presets` 与 `GET /api/marketplace/trending/collections`
- `POST /api/marketplace/reports`（已验证成员举报可访问的 Public / Unlisted 内容；同一成员和目标只接受一次）
- `POST /api/marketplace/infringement-notices`（无需登录的独立正式通知）
- `GET /api/marketplace/me/moderation` 与 `POST /api/marketplace/moderation/appeals`
- `GET /api/marketplace/admin/moderation/queue`
- `POST /api/marketplace/admin/moderation/actions` 与 `POST /api/marketplace/admin/moderation/appeals`
- `GET /api/marketplace/admin/moderation/audit`
- `POST /api/marketplace/presets`
- `GET /api/marketplace/presets/:id`（Public / Unlisted 当前修订）
- `GET /api/marketplace/search/presets|collections|creators`（统一发现的独立分栏与稳定游标）
- `GET /api/marketplace/presets/:id/revisions/:revisionId`（固定修订永久链接）
- `GET /api/marketplace/presets/:id/revisions/:revisionId/compatibility`（按当前目录与外部资源事实重算）
- `GET /api/marketplace/presets/:id/manage` 与 `GET /api/marketplace/presets/:id/revisions`（仅作者）
- `PATCH /api/marketplace/presets/:id/metadata`
- `POST /api/marketplace/presets/:id/revisions` 与 `POST /api/marketplace/presets/:id/revisions/:revisionId/restore`
- `PATCH /api/marketplace/presets/:id/visibility`

资料与作品管理写入携带 `expectedUpdatedAt` 做乐观并发检查；冲突返回 `409 preset_update_conflict` 及最新 `updatedAt/currentRevisionId/visibility`，客户端不会静默覆盖。公开创作者响应使用字段白名单，不包含邮箱、认证账户或第三方 token。发布请求只接受标题、纯文本介绍、1–5 个标签、schema 版本、完整 Rig，以及可选的来源作品/修订；来源必须真实存在、修订属于该作品、对发布者可引用且不是发布者自己的作品，自己的作品改走作者专属追加修订接口。owner、点赞数与排名全部由服务端拥有。写入前共用 `publishableRig` 边界执行无损 canonical 校验，并自行派生 Pedal、Amp、Cab 与精确 TONE3000 依赖；当前明确接受 schema 2–5，旧版输入只有在每个已提供字段都能原样保留时才规范化为 schema 5，未知或有损版本会被拒绝。本机 NAM 和自定义 Cab IR 会被拒绝。

兼容性不是修订上的持久化状态。接口从不可变 Rig、当前器材目录和请求方的 TONE3000 检查事实即时计算 `compatible`、`authorization-required` 或 `incompatible`，并列出 schema、Pedal/Amp/Cab 或外部依赖阻塞项。没有外部检查事实时不会猜测资源可用；删除、转私有或许可失效也不会自动撤回作品。手动修复先记录固定来源，再按作者所有权追加 Revision 或创建 Remix，原修订保持不变。

Public 作品进入公开发现；Unlisted 只通过直接链接访问，页面动态设置 `noindex,nofollow`；Withdrawn 对访客与不存在作品使用相同 404，但作者仍可通过管理入口恢复原作品 id。Hidden 不属于作者可写状态。

统一发现的三个分栏分别维护绑定类型与规范化查询的游标。合集搜索只读取 Public 合集的标题、介绍、标签和作者，不连接或返回合集条目正文；创作者搜索只返回公开资料白名单。公开预设、合集与创作者页面设置描述、canonical URL 和 `index,follow`，canonical URL 只依赖不可变 id；Unlisted 页面使用相同稳定直接链接但设置 `noindex,nofollow`。

`npm run test:e2e` 使用 Playwright 启动 Vite 开发适配器，贯通三类发现结果、历史 handle 到成员 id 页的跳转、Public canonical/description/robots 元数据，以及 Unlisted 页面与搜索排除。

治理入口把普通成员举报与无需登录的正式侵权通知分开保存。管理员白名单使用认证系统生成的稳定 `auth_user_id`，不是邮箱；生产部署必须显式设置 `MARKETPLACE_ADMIN_AUTH_USER_IDS`，空值表示没有管理员。管理员私有队列包含处理正式通知所需的联系人，但公开内容与作者治理记录不会投影举报人或通知人信息。管理员动作只允许隐藏/恢复内容、封禁/解封成员、关闭举报/通知和复核申诉；没有冒充成员、读取认证凭据或转移作品所有权的接口。每次动作记录 actor、目标、动作、原因和时间。

Hidden 与 Withdrawn 独立：管理员隐藏时保存治理前可见性，恢复或申诉成立时回到原来的 Public、Unlisted 或 Withdrawn。成员封禁会阻止发布、作品/合集管理、资料修改、点赞、举报和申诉等社区写入，但仍允许读取本人记录；既有点赞事实保留在私有事实表，公开计数、Popular 和 Trending 会立即重建并排除这些点赞。解封同样触发重建。

账户导出只返回当前成员自己的资料、作品与修订正文、合集、点赞及治理关系；不展开他人资料，不返回 session、认证账户、token 或管理员私有数据。申请注销会在一个事务中保存本次受影响的 Public/Unlisted 可见性、撤回成员作品与合集、标记账户待删除并吊销全部既有 session；所有发布、合集、资料、点赞、举报与申诉写事务都会先锁定并复查成员状态，因此注销与并发社区写入之间没有读后写窗口。治理 Restore 和申诉成立同样不能在待删除状态重新公开 Hidden 正文。待删除成员重新验证后只能恢复该快照中的内容，Hidden 和申请前 Withdrawn 内容不变。每日 Vercel Cron 通过 `CRON_SECRET` 调用 `GET /api/internal/marketplace/purge-deleted-accounts`：到期事务删除认证身份、个人资料、明文历史 handle、标题介绍、修订 Rig、资源/器材派生内容和点赞；历史 handle 仅保留 SHA-256 预留摘要以防冒充复用。事务同时立即重建 Popular 与 Trending 投影，擦除自有合集正文，并保留 Remix 来源、他人合集条目及必要治理记录所需的匿名成员/作品占位。

真实数据库验证可指向一次性 PostgreSQL 数据库：

```bash
MARKETPLACE_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55440/marketplace_test \
  npx tsx --test tests/marketplace-moderation-postgres.integration.test.ts
```

部署路由先把公开稳定 URL 转给 Vercel Function，再由最后的 SPA rewrite 处理前端页面。数据库未配置或查询失败时 API 返回稳定的 `503 marketplace_unavailable`；不存在和非公开作品统一返回 `404 published_preset_not_found`。

Trending 在 Hobby/Test 阶段由 Vercel Cron 每日重建一次，也可用 `npm run marketplace:rebuild-trending` 手动重建；升级 Pro 并准备正式上线时，将目标周期恢复为五分钟。任务只读取当前点赞事实、点赞时间和成员 `community_status`，取消点赞与封禁在下一次成功重建后从榜单排除；公开 API 不接受趋势权重或任何浏览/应用信号。定时入口只接受 Vercel 从 `CRON_SECRET` 生成的 Bearer 授权。
