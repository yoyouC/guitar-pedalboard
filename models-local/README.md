# models-local/(本地评估模型,不随 git 跟踪)

本目录存放**许可不允许公开分发**的 NAM 模型,已被 `.gitignore` 排除:只在本地
开发时由 vite 中间件提供(`vite.config.ts` 的 `serveLocalModels`),不进入
`dist/`,不会被部署。生产构建的模型注册表自动排除本目录内容
(`import.meta.env.DEV` 门控)。

## 恢复本目录内容

```bash
./scripts/fetch-local-models.sh   # 拉取 NAMKnobs 与 tone-3000 demo 模型
```

增益扫档包(`marshall-sweep/`、`bassman-sweep/`、`dualterror-sweep/`、
`evh-green-sweep/`、`recto-red-sweep/`)没有公开直链,来自用户自有的
`Marshall JCM800 2203 - updated.zip` 与 `NAM箱头模型合集*.zip`,按
fetch 脚本末尾提示手动放入。

## 许可(一律:未标明,仅本地评估,勿再分发)

| 路径 | 内容 | 来源 |
|---|---|---|
| `namknobs/` | NAMKnobs upstream_v2 条件化单块(comp/ts_full/rat/gr/ds1/ff/mxr) | [drockthedoc/NAMKnobs](https://github.com/drockthedoc/NAMKnobs)(仓库无 LICENSE) |
| `ac10-wavenet.nam` / `deluxe-wavenet.nam` | tone-3000 demo capture | [tone-3000/neural-amp-modeler-wasm](https://github.com/tone-3000/neural-amp-modeler-wasm) `ui/public/models/` |
| `marshall-sweep/` | JCM800-2203 增益扫档(SlimmableContainer) | 用户自有 zip,原始作者未考证 |
| `bassman-sweep/` `dualterror-sweep/` `evh-green-sweep/` `recto-red-sweep/` | Fender Bassman / Orange Dual Terror / EVH 5150 Green / Mesa Dual Recto 增益扫档 | 用户自有 NAM箱头模型合集 zips(包内目录署名 ArlingtonAudio/ObiJuan/NorthernFox) |
