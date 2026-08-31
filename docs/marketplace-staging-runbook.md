# Marketplace Test Preview 操作手册

本手册描述正式 Staging 之前的受保护 Test Preview：复用现有 Vercel 项目的 Preview 环境，
连接 Neon `guitar-pedalboard` 项目的 `Test` 分支。Production 环境、生产别名和 Neon
`production` 分支不在本阶段范围内。

## 1. 项目所有者先做的决策

在创建资源前确定以下四项：

1. 调度：当前 Vercel Hobby，Test Cron 每日运行；升级 Pro 后再恢复五分钟周期。
2. PostgreSQL：复用 Neon `Test` 分支；runtime 用 pooled URL，release runner 用 direct URL。
3. 访问控制：使用 Vercel Standard Protection 保护生成的 Preview URL。
4. 认证基址：Preview 自动使用平台提供的 `VERCEL_URL`；Production 仍需显式
   `BETTER_AUTH_URL`。

## 2. Test 隔离边界

1. Vercel 只部署 Preview，禁止使用 `--prod`。
2. Neon 只操作 `Test` 分支，禁止对默认 `production` 分支执行迁移或 seed。
3. 保存两条连接串：
   - pooled URL：仅供 Vercel Functions 运行时使用；
   - direct URL：仅供迁移、管理和恢复工具使用。
4. Resend 发件域名或地址由项目所有者验证后，再启用登录测试。

## 3. Vercel 环境变量

以下变量只配置到 Vercel Preview 环境。不要把值提交到 Git：

```text
MARKETPLACE_RUNTIME_DATABASE_URL=<pooled PostgreSQL URL>
BETTER_AUTH_SECRET=<至少 32 字符随机值>
# Preview 自动使用 VERCEL_URL；无需配置 BETTER_AUTH_URL
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

当前 Neon 项目位于 `aws-us-east-2`，Vercel 构建/函数默认运行区域与其相邻。正式 Staging
选定数据库区域后，再在 `vercel.json` 显式固定 Functions 区域。

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

在本 worktree 链接现有 Vercel 项目后部署 Preview：

```sh
npx vercel link --project guitar-pedalboard
npx vercel deploy
```

部署后依次验证：

1. `GET /api/marketplace/health` 返回 `204` 和 `cache-control: no-store`。
2. 本地 Rig、Preset 和音频在 Marketplace 断网时仍可工作。
3. 配置 Resend 后验证魔法链接登录、邮件验证和资料完成。
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
