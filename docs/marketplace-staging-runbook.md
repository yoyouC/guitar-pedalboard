# Marketplace Staging 操作手册

本手册从一个未配置 Marketplace 的 Vercel 项目开始。不要把 Staging 数据库连接到现有生产
项目；Staging 必须有独立项目、稳定域名和独立数据库。

## 1. 项目所有者先做的决策

在创建资源前确定以下四项：

1. 调度：已确定 Vercel Pro，使用仓库中的五分钟 Cron。
2. PostgreSQL：已确定 Neon；选择与 Vercel Function 接近的亚洲区域，并启用
   `pg_trgm`、pooled URL、direct URL 和 PITR。
3. Vercel Function 区域：与 PostgreSQL 主区域一致或尽可能接近。
4. 稳定 Staging 域名：首期使用 Staging 项目的固定 `.vercel.app` 域名；认证不能依赖
   随机 Preview URL。

## 2. 创建独立资源

1. 在 Vercel 创建新项目，建议命名 `guitar-pedalboard-staging`，连接同一个 GitHub 仓库。
2. Production Branch 暂时设为 `feat/marketplace-v1`；正式合并后改为约定的 staging 分支。
3. 创建独立 Staging PostgreSQL，开启 PITR，并保存两条连接串：
   - pooled URL：仅供 Vercel Functions 运行时使用；
   - direct URL：仅供迁移、管理和恢复工具使用。
4. 设置稳定域名，并等待 TLS 生效。
5. 在 Resend 验证 Staging 发件域名或子域名。

## 3. Vercel 环境变量

以下变量只配置到 Staging 项目的 Production 环境。不要把值提交到 Git：

```text
MARKETPLACE_RUNTIME_DATABASE_URL=<pooled PostgreSQL URL>
BETTER_AUTH_SECRET=<至少 32 字符随机值>
BETTER_AUTH_URL=https://<稳定 Staging 域名>
RESEND_API_KEY=<Resend server API key>
AUTH_EMAIL_FROM=Guitar Pedalboard Staging <login@staging.example.com>
CRON_SECRET=<至少 16 字符、与 auth secret 不同的随机值>
MARKETPLACE_ADMIN_AUTH_USER_IDS=
MARKETPLACE_DATABASE_POOL_MAX=2
MARKETPLACE_DATABASE_IDLE_TIMEOUT_MS=5000
MARKETPLACE_DATABASE_CONNECTION_TIMEOUT_MS=2000
MARKETPLACE_DATABASE_QUERY_TIMEOUT_MS=15000
```

`MARKETPLACE_MIGRATION_DATABASE_URL` 只保存到受控 release runner 的 secret 中，不配置到
Vercel Function 环境；它使用 Neon direct URL，避免迁移权限和直连凭据进入运行时。

`MARKETPLACE_ADMIN_AUTH_USER_IDS` 首次保持空值。完成第一次登录后，从数据库确认自己的稳定
`auth_user_id`，再配置管理员白名单并重新部署。不要使用邮箱作为管理员身份。

Google OAuth 可以在魔法链接验收后再启用：

```text
GOOGLE_CLIENT_ID=<staging OAuth client id>
GOOGLE_CLIENT_SECRET=<staging OAuth client secret>
```

回调地址固定为：

```text
https://<稳定 Staging 域名>/api/auth/callback/google
```

## 4. Function 区域

数据库区域确定后，在 `vercel.json` 显式设置 Functions 的 `regions`。不要在数据库区域确定前
猜测或硬编码；静态资源仍由全球 CDN 分发，区域设置只约束服务端 Functions。

## 5. 串行 Release

在可以访问 direct URL 的受控 runner 中执行，不能放进 Vercel build：

```sh
MARKETPLACE_MIGRATION_DATABASE_URL='postgresql://…' npm run marketplace:migrate
DATABASE_URL='postgresql://…' npm run marketplace:seed
DATABASE_URL='postgresql://…' npm run marketplace:rebuild-all
```

迁移 runner 会持有 session advisory lock，记录每个文件的 SHA-256；已执行文件发生变化会拒绝
发布。seed 幂等，统一投影重建在一个事务内完成。

## 6. 首次部署与冒烟

在本 worktree 链接 Staging 项目后再部署：

```sh
npx vercel link --project guitar-pedalboard-staging
npx vercel --prod
```

部署后依次验证：

1. `GET /api/marketplace/health` 返回 `204` 和 `cache-control: no-store`。
2. 本地 Rig、Preset 和音频在 Marketplace 断网时仍可工作。
3. 魔法链接登录、邮件验证和资料完成。
4. 创建一个 Unlisted Tone，追加 Revision，恢复旧 Revision。
5. 从另一个成员创建 Remix，确认来源作品和修订固定。
6. Public 发现、合集固定修订、Like、Popular 和 Trending。
7. 举报、管理员隐藏/恢复、封禁/解封。
8. 账户导出、申请注销和重新验证恢复。

## 7. Staging 验收完成后

- 运行带 Staging PostgreSQL 的完整集成测试。
- 运行性能基准、投影故障注入和恢复演练。
- 配置五分钟合成探针、Log Drain 和 backup runner。
- 只有上述证据通过后，才准备 Production 发布。
