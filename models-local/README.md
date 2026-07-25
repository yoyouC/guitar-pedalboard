# models-local/(预留的"仅本地评估"目录)

本目录**预留**给许可不允许公开分发的模型:放在这里的文件被 `.gitignore`
排除,只在本地开发时由 vite 中间件提供(`vite.config.ts` 的
`serveLocalModels`),不进入 `dist/`,不会被部署。

> 现状:原先在本目录的内容(扫档包、NAMKnobs、tone-3000 demo)已获作者
> 授权,迁回 `public/models/` 随 git 跟踪发布(见
> `public/models/ATTRIBUTION.md` 的授权记录)。

## 用法

- 新增"仅本地评估"的模型时,直接放入本目录任意子路径,URL 为
  `/models-local/<相对路径>`(仅 dev server 可访问);
- 该模型在注册表中的条目需加 `import.meta.env.DEV` 门控(参考 git 历史
  中 `namWasm.ts` / `namPedal.ts` 的写法),保证生产构建不含;
- `scripts/check-publish-models.mjs` 会保证 dist 中不出现本目录内容。
