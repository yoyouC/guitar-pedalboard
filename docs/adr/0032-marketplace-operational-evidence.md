# ADR-0032: 用可重放证据验证 Marketplace 运维目标

状态：Accepted（2026-08-29）

## 决策

作品、修订、权限、来源和 Like 明细是事实数据；搜索 Rig 投影、Like 聚合与版本化排行榜是可重建投影。统一重建在一个事务中完成，任一投影失败则全部回滚。

性能门槛由仓库内的代表性数据生成器和服务端仓储基准自动判定，不以仪表盘截图作为证据；新作品发布与元数据更新分别计量搜索收敛。文本搜索由应用侧唯一的 Unicode 规范化函数生成持久投影，正常写路径在事实事务内同步更新投影；数据库触发器会把绕过应用写入的旧投影置空。PostgreSQL trigram 索引以经过长度四、一次编辑边界验证的 0.2 阈值生成候选集，再使用领域搜索函数精确判定，以保持兼容 Unicode、前缀及一次编辑容错语义。NULL 投影绕过候选过滤，确保异常写入或重建期间候选集仍是领域匹配的超集。标签候选同时检查当前标签及所有扁平转发到它的 merged source 身份、名称和别名，目标标签后续编辑不能丢失历史搜索兼容。

可用性使用版本化路由范围、去重的生产请求和固定间隔合成探针计算；探针按时间槽聚合，同槽任一失败使该槽失败。健康探针读取 Marketplace 作品/修订 schema 并设置响应超时。TONE3000 是外部依赖，不进入本站 Marketplace API 的分子或分母。

恢复基线采用每小时 catch-up、UTC 日幂等、PostgreSQL session advisory mutex 与 durable-store fencing token 的 PostgreSQL 自定义格式逻辑备份、SHA-256 manifest 和一次性数据库恢复演练。archive 与事实指纹来自同一个 exported snapshot；advisory mutex 避免正常重叠并在进程崩溃或连接断开时由 PostgreSQL 原子释放。由于数据库 session 不能原子约束文件系统 rename，最终 publication fence 位于 durable store：runner 以 `O_EXCL` 创建单调递增 claim，并把 bundle 发布到 token 隔离路径；完成状态和恢复只承认最高 claim 对应且通过严格 manifest/archive 摘要校验的 bundle。失去数据库连接的旧 runner 即使晚到发布低 token bundle，也不能覆盖或被读取为当前备份。事实摘要固定使用 UTC 序列化；恢复必须比对事实计数/校验摘要、以单事务遇错退出，并检查作品当前修订不变量。逻辑备份不是 PITR；部署仍应启用数据库提供商的 PITR 作为额外保护。

## 后果

- 性能、可用性、备份和恢复都产出机器可读报告，可在环境变化后重跑。
- Vercel Cron 的成功调用不等于备份成功；备份必须在持久加密存储落盘后才记为完成。
- 运行环境必须允许 `pg_trgm` 扩展，并为备份 runner 固定不旧于服务端的 PostgreSQL client。
