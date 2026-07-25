# 发布与 NAM 模型资产管理

本项目内置的 NAM 模型(capture 文件)按**许可**分为两级管理,决定 git 跟踪方式与
发布内容。

## 1. 许可分级

| 级别 | 内容 | git 跟踪 | 发布 |
|---|---|---|---|
| **可发布(MIT / GPL-3.0 / CC BY-NC-ND / 作者邮件授权)** | `public/models/` 下全部(71 个 .nam,含扫档包、NAMKnobs、tone-3000 demo) | ✓ 直接提交(共 ~21MB,无需 LFS) | ✓ 随 `dist` 发布,需在 `public/models/ATTRIBUTION.md` 记录(发布检查强制) |
| **仅本地评估(许可未标明)** | `models-local/`(预留目录,当前为空) | ✗ `.gitignore`(README 除外) | ✗ 生产构建与 dist 均排除 |

`public/nam-wasm/`(emscripten 产物,676KB)随 git 跟踪——使 CI/部署不必安装
emsdk;重编见 `wasm/build-nam-wasm.sh`。

## 2. 实现机制

- **注册表**:全部模型条目已获授权,`src/audio/namWasm.ts` 与
  `src/audio/effects/namPedal.ts` 生产与本地一致(历史上的 DEV 门控已随授权
  到位移除;`models-local/` 仅作未来"真·仅本地"文件的预留目录);
- **dev 静态服务**:`vite.config.ts` 的 `serveLocalModels` 中间件把
  `/models-local/**` 映射到仓库根的 `models-local/`(仅 dev server;该路径不在
  publicDir,永远不会进 dist);
- **发布检查**:`scripts/check-publish-models.mjs` 校验 ① dist 无
  models-local/扫档包/namknobs 内容 ② public/models 每个 .nam 都在
  ATTRIBUTION.md 有许可记录 ③ wasm 与模型产物齐全。挂在 Vercel 的
  buildCommand 里(`npm run build && node scripts/check-publish-models.mjs`),
  失败即阻断部署;本地也可 `npm run check:publish`;
- **恢复本地模型**:`./scripts/fetch-local-models.sh`(NAMKnobs 与 demo 直链;
  扫档包无直链,按脚本提示从用户自有 zip 放入)。

## 3. 部署(Vercel)

`vercel.json`:

- `buildCommand: npm run build && node scripts/check-publish-models.mjs`
- `outputDirectory: dist`(vite `base: './'`,任意路径可挂)
- SPA rewrite 到 `index.html`;`/models/**` 缓存 1h,`/nam-wasm/**` 缓存 1 天。

发布命令(需本机 `vercel login` 过,项目已 link 到 `.vercel/`):

```bash
npx vercel --prod
```

## 4. 上线前清单

- [x] dist 不含本地评估模型(检查脚本通过)
- [x] 许可页可访问:应用 footer"模型许可"→ `/models/ATTRIBUTION.md`
- [ ] GPL-3.0 模型随附许可文本确认(ATTRIBUTION 已标注来源与许可)
- [ ] 非商业使用确认(CC BY-NC-ND 的 BossLSTM 两个模型)

## 5. 若要公开分发扫档包/NAMKnobs

这些是目前"未标明许可"的内容,公开前必须获得作者授权或替换为许可明确的
capture(如自行采集/训练,或换 CC0 模型)。届时从 `models-local/` 移回
`public/models/` 并在 ATTRIBUTION 登记即可。
