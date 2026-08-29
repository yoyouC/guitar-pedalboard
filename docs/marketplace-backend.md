# 音色广场后端开发

首个纵切提供 `GET /api/marketplace/presets/:id`。核心位于 `server/marketplace/`，使用标准 Web `Request` / `Response`；`api/marketplace-preset.ts` 是 Vercel 入口，Vite 开发中间件使用相同核心与确定性 demo seed。

## 本地走通 demo

```bash
npm run dev
open http://localhost:5173/marketplace/presets/preset-demo-crunch
```

本地开发不要求数据库。页面可读取 demo Published Preset、展示当前不可变修订和资源依赖，并在音频输入启动后应用到当前 Rig 和会话内撤销。

## PostgreSQL

生产环境设置 `DATABASE_URL`（也兼容 `POSTGRES_URL`），然后运行：

```bash
npm run marketplace:migrate
npm run marketplace:seed
```

迁移创建成员、作品和修订事实表。数据库约束保证每个作品都有属于自己的当前修订，修订更新和删除由 trigger 拒绝；作品元数据和当前修订指针仍可在后续写接口中独立修改。账号期满清理需要由对应生命周期迁移建立专用受控路径，普通应用写入不能物理删除修订。seed 命令幂等创建 `preset-demo-crunch`。

部署路由先把公开稳定 URL 转给 Vercel Function，再由最后的 SPA rewrite 处理前端页面。数据库未配置或查询失败时 API 返回稳定的 `503 marketplace_unavailable`；不存在和非公开作品统一返回 `404 published_preset_not_found`。
