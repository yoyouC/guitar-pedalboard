# Marketplace 运维与验收手册

本手册是 Issue #37 的可重复验证入口。所有时间窗口使用 UTC，报告和原始证据放在受控的持久存储中，不提交生产数据或连接串。

## 性能和收敛

准备一个名称包含 `benchmark`、`bench` 或 `perf` 的一次性 PostgreSQL 数据库，然后运行：

```sh
MARKETPLACE_BENCHMARK_DATABASE_URL='postgresql://…/marketplace_benchmark' \
MARKETPLACE_ALLOW_BENCHMARK_RESET=true npm run marketplace:benchmark:prepare

MARKETPLACE_BENCHMARK_DATABASE_URL='postgresql://…/marketplace_benchmark' \
MARKETPLACE_BENCHMARK_SAMPLES=30 \
MARKETPLACE_BENCHMARK_REPORT=artifacts/marketplace-performance.json \
npm run marketplace:benchmark:verify
```

准备命令会清空该一次性数据库并生成 10,000 成员、100,000 Public 预设及对应不可变修订和 Rig 搜索投影。验证命令预热后测量列表、详情、罕见词搜索和追加修订，使用 nearest-rank p95 自动检查 500ms/2s 门槛；然后修改元数据并轮询搜索，自动检查一分钟收敛目标。非零退出码表示失败。

硬件、PostgreSQL/Node 版本、区域、数据库规格、命令和 JSON 报告必须随每次结果一起保存。共享或远程环境至少执行 30 个样本；本地诊断可使用最低 20 个样本。

## 投影重建和故障注入

```sh
DATABASE_URL='postgresql://…' npm run marketplace:rebuild-all
```

该命令从事实数据在一个事务中重建搜索/Rig 筛选、Preset/Collection Like 数量与版本化 Popular、Trending 排名。失败会回滚整个重建，旧投影仍可读。测试 `marketplace-operations.test.ts` 注入中途失败并验证没有提交；发布与修订的 PostgreSQL 测试验证投影写失败会回滚事实写；限流存储测试验证其失败只拒绝社区写，不影响读取。本地音频不调用 Marketplace 服务端，因此这些故障不进入音频链路。

故障演练顺序：先保留事实表行数和摘要，分别令投影写、缓存/数据库健康探针、限流存储和备份目标失败，确认写事务回滚、现有事实不变、健康端点返回非缓存 503、本地 Rig 仍可编辑和发声；恢复组件后运行统一重建并比较事实和投影不变量。

## 月度 99.5% 可用性

合成监控每五分钟请求生产 `/api/marketplace/health`，记录每个预期时间槽（包括超时和未执行）。Vercel Log Drain 对生产 `/api/marketplace/**` 以 100% 转发到至少保留 35 天的存储，按 Vercel event id 去重，并监控 drain 自身断流。状态 1xx–4xx 视为服务已响应，5xx、crash/无响应视为失败；健康探针仅 2xx 为成功。

把 drain 和探针规范化为每行一个 JSON 对象：`id`、`environment`、`source`、`path`、`status`、`observedAt`。生成月报：

```sh
MARKETPLACE_AVAILABILITY_INPUT=artifacts/2026-08-observations.jsonl \
MARKETPLACE_AVAILABILITY_START=2026-08-01T00:00:00Z \
MARKETPLACE_AVAILABILITY_END=2026-09-01T00:00:00Z \
MARKETPLACE_AVAILABILITY_REPORT=artifacts/2026-08-availability.json \
npm run marketplace:availability-report
```

策略在 `server/operations/availability.ts` 版本化。只有生产 `/api/marketplace/**` 进入统计；路径包含 `tone3000` 的外部下载明确排除并单独告警。缺失的合成探针槽按失败处理。告警覆盖 99.5% 快速/慢速 burn、连续探针失败、drain 断流和数据库错误。

## 每日备份和恢复演练

备份 runner 必须是支持 `pg_dump` 的持久任务环境，不使用 Vercel Function 的 `/tmp` 作为归档。调度器每天触发；由于触发可能重复、重叠且失败不重试，runner 以 UTC 日期作幂等键、加互斥 lease，并在 23 小时没有成功完成时告警和触发 catch-up。完成只指 archive 与 manifest 已进入加密、跨故障域的持久存储。

```sh
MARKETPLACE_BACKUP_DATABASE_URL='postgresql://…/marketplace' \
MARKETPLACE_BACKUP_DIR='/mounted/encrypted/durable/marketplace' \
npm run marketplace:backup
```

每天检查最后成功 manifest 不超过 24 小时且摘要对象存在。至少每月在名称包含 `restore`、`drill`、`recovery` 或 `scratch` 的新建空数据库演练：

```sh
MARKETPLACE_ALLOW_RESTORE_DRILL=true \
MARKETPLACE_RESTORE_DATABASE_URL='postgresql://…/marketplace_restore_drill' \
MARKETPLACE_RESTORE_DRILL_ARCHIVE='artifacts/marketplace.dump' \
MARKETPLACE_RESTORE_DRILL_MANIFEST='artifacts/marketplace.dump.json' \
MARKETPLACE_RESTORE_DRILL_REPORT='artifacts/marketplace-restore.json' \
npm run marketplace:restore-drill
```

脚本拒绝生产目标，校验 SHA-256，以 `pg_restore --single-transaction` 恢复，检查事实数量和每个作品的当前不可变修订，并自动判定 RPO≤24h、RTO≤8h。演练后运行 `ANALYZE` 和统一投影重建，再执行性能验证。归档、manifest、PostgreSQL client/server 版本和 JSON 报告一并保留。数据库提供商 PITR/备份作为第二层保护，不能替代这份恢复证据。

## 发布检查清单

- 迁移完成，`pg_trgm` 可用，完整测试、build 和 lint 通过。
- 代表性环境性能报告通过，搜索收敛小于一分钟。
- 最近每日备份完成时间小于 24 小时，恢复演练报告满足 RPO/RTO。
- 当月请求、探针和 drain 覆盖完整；TONE3000 指标保持在外部依赖面板。
- 投影/限流/备份故障注入后事实摘要不变，统一重建成功。
