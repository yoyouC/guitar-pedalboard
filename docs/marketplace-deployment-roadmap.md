# Marketplace V1 部署 Roadmap

本路线图把 `feat/marketplace-v1` 从已通过本地验收的实现推进到可恢复、可观测的生产服务。
步骤按依赖顺序执行；每一阶段只有在验收门槛通过后才进入下一阶段。

状态约定：`TODO` 尚未开始，`DOING` 正在执行，`DONE` 已通过验收，`USER` 需要项目所有者操作。

## 当前基线

- 分支：`feat/marketplace-v1`
- 本地无数据库测试：603 passed，16 skipped，0 failed；跳过项需要真实 PostgreSQL。
- PostgreSQL 17 完整测试：619 passed，0 skipped，0 failed。
- Playwright：14 passed。
- TypeScript/Vite build、Oxlint 和发布资产门禁通过。
- 现有 Vercel 项目已链接，但没有 Marketplace 环境变量；生产 health URL 仍落到 SPA。

## 执行顺序

### D0 — 仓库发布门禁

状态：`DONE`　执行者：Codex

- [x] GitHub Actions 执行 lint、无数据库单测、生产 build 和发布资产检查。
- [x] GitHub Actions 使用 PostgreSQL 17 执行全部数据库集成测试，禁止 skip。
- [x] GitHub Actions 安装 Chromium 并执行 Playwright 验收。
- [x] 本地复跑与工作流等价的命令；PostgreSQL 17 下 619 passed、0 skipped。

验收门槛：三个 CI job 全部通过；真实 PostgreSQL 运行中没有 skip 或失败。

### D1 — 数据库迁移发布安全

状态：`DONE`　执行者：Codex

- [x] 增加 migration ledger，记录文件名和内容摘要。
- [x] 使用 PostgreSQL advisory lock 串行化迁移 runner。
- [x] 已执行迁移内容发生变化时拒绝继续，不静默重放。
- [x] 增加空库首次迁移、重复迁移、并发迁移和摘要漂移测试。
- [x] 保持迁移为独立 release job，不放入 Vercel build。

验收门槛：迁移 runner 在真实 PostgreSQL 上满足一次执行、重复执行和并发执行不变量。

### D2 — Serverless PostgreSQL 连接安全

状态：`DONE`　执行者：Codex

- [x] 明确生产 runtime 使用独立 pooled PostgreSQL URL，迁移使用独立 direct URL。
- [x] 将连接池生命周期接入 Vercel Functions 的 suspension hook。
- [x] 给 pool 大小、空闲、连接和查询超时建立有界配置；Function 区域在 D3 与数据库区域一起选择。
- [x] 验证 11 个 Vercel Functions 能完成平台生产构建和单独 TypeScript bundling。

验收门槛：连接总量上界可计算，冷启动/暂停不会遗留失控连接，health 超时仍保持两秒上限。

### D3 — Staging 基础设施

状态：`USER`　执行者：项目所有者 + Codex

已确认决策：Vercel Pro、Neon PostgreSQL、亚洲同区域；Staging 先使用稳定的
`.vercel.app` 域名。

需要项目所有者完成：

- [x] 确认 Vercel Pro，以仓库中的五分钟 Trending Cron 作为调度器。
- [ ] 创建独立 Vercel Staging 项目、稳定域名和同区域 PostgreSQL。
- [ ] 开启数据库 PITR，并提供 pooled `MARKETPLACE_RUNTIME_DATABASE_URL` 与仅供 release runner
      使用的 direct `MARKETPLACE_MIGRATION_DATABASE_URL`。
- [ ] 在 Staging 配置 `BETTER_AUTH_SECRET`、`BETTER_AUTH_URL`、`RESEND_API_KEY`、
      `AUTH_EMAIL_FROM`、`CRON_SECRET`、`MARKETPLACE_ADMIN_AUTH_USER_IDS`。
- [ ] 可选配置 Google OAuth client 与 callback。

Codex 随后执行：

- [ ] 在 Staging 数据库执行 migrate、seed 和 `marketplace:rebuild-all`。
- [ ] 部署 Staging 并验证 health、登录、发布、Revision、Remix、搜索、Like、治理和注销恢复。
- [ ] 验证 Cron 授权和失败行为。

验收门槛：稳定 Staging 域名完成端到端验收，Marketplace 故障不影响本地 Rig 和音频。

### D4 — 运维基线

状态：`USER`　执行者：项目所有者 + Codex

需要项目所有者提供持久基础设施：

- [ ] 一个带 `pg_dump`/`pg_restore`、加密持久目录和独立故障域的 backup runner。
- [ ] 五分钟外部合成探针。
- [ ] Vercel Log Drain 目标，日志至少保留 35 天。

Codex 随后执行：

- [ ] 安装每小时 backup/freshness crontab。
- [ ] 生成首份备份 manifest，并在一次性数据库完成恢复演练。
- [ ] 运行 10 万作品性能基准和投影故障注入。
- [ ] 验证 RPO 不超过 24 小时、RTO 不超过 8 小时、p95 读小于 500ms、写小于 2s。

验收门槛：备份、恢复、性能、可用性均有机器可读报告。

### D5 — Production 发布

状态：`USER`　执行者：项目所有者 + Codex

发布前用户决策：

- [ ] 确认 GPL-3.0 随附许可文本。
- [ ] 确认 BossLSTM 两个 CC BY-NC-ND 模型符合产品的非商业使用边界；否则从生产资产移除。
- [ ] 批准生产域名、数据库、邮件发件域名、管理员和上线时间窗。

发布顺序：

1. 创建生产数据库并开启 PITR、pooling 和备份。
2. 串行执行生产 migration、seed 和投影重建。
3. 配置生产环境变量并部署 Vercel。
4. 检查 health，先发布一个 Unlisted Tone，再验证 Public 发现路径。
5. 开启 Cron、合成探针、Log Drain 和 backup runner 告警。
6. 观察稳定后开放成员 Public 发布。

验收门槛：生产 health、核心旅程、备份 freshness 和告警全部正常。

## 回滚原则

- 应用代码使用 Vercel deployment rollback。
- 数据库迁移只做向前兼容和 roll-forward，不自动执行破坏性 schema rollback。
- Vercel rollback 后单独核对 Cron 配置；代码回滚不代表 Cron 自动回滚。
- 数据恢复只用于灾难恢复，恢复后必须执行统一投影重建和事实摘要核对。
