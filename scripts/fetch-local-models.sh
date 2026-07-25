#!/bin/bash
# 拉取"仅本地评估"的 NAM 模型到 models-local/(git-ignored)。
# 可重新下载的(NAMKnobs、tone-3000 demo)直接拉;增益扫档包没有公开直链,
# 需自行放入(见末尾提示)。
set -euo pipefail
cd "$(dirname "$0")/.."

NK="https://raw.githubusercontent.com/drockthedoc/NAMKnobs/main/offline_cond_nam/out/upstream_v2"
T3K="https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/main/ui/public/models"

mkdir -p models-local/namknobs
for m in comp rat ts_full gr ds1 ff mxr; do
  echo "→ namknobs/$m.nam"
  curl -sfL --retry 2 "$NK/$m.nam" -o "models-local/namknobs/$m.nam"
done

echo "→ ac10-wavenet.nam / deluxe-wavenet.nam"
curl -sfL --retry 2 "$T3K/ac10.nam" -o models-local/ac10-wavenet.nam
curl -sfL --retry 2 "$T3K/deluxe.nam" -o models-local/deluxe-wavenet.nam

cat <<'EOF'

完成。以下模型没有公开直链,需要你自己提供并放入 models-local/:
  marshall-sweep/   JCM800 2203 增益扫档(来自 "Marshall JCM800 2203 - updated.zip")
  bassman-sweep/ dualterror-sweep/ evh-green-sweep/ recto-red-sweep/
                    来自 "NAM箱头模型合集*.zip"(各取 8 个 g*.nam 档)

注意:models-local/ 下所有文件许可均未标明,仅限本地评估,不得公开分发。
EOF
