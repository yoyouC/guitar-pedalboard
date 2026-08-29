# PostgreSQL 事实源与 Web 标准 API 核心

音色广场以 PostgreSQL 保存成员、Published Preset 与不可变 Preset Revision，并让领域 API 只暴露标准 `Request → Response` 接口；Vercel Function 和 Vite 开发服务器只是薄适配器。这样可以用数据库约束保证作品、当前修订与作者关系强一致，也能在不改客户端契约和领域逻辑的前提下替换部署运行时。搜索索引、排行榜和计数仍按 ADR-0012 至 ADR-0019 的边界作为可重建投影，不进入本次事实表。
