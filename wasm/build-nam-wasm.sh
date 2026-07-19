#!/bin/bash
# 编译 NAM Core + 极简绑定为 WASM(产物进 public/nam-wasm/)。
# 依赖:emsdk(默认 /tmp/emsdk,可用 EMSDK 覆盖)与 tone-3000/neural-amp-modeler-wasm
# 源码树(含子模块,默认 /tmp/nam-wasm-src,可用 NAM_WASM_SRC 覆盖)。
set -euo pipefail

EMSDK="${EMSDK:-/tmp/emsdk}"
SRC="${NAM_WASM_SRC:-/tmp/nam-wasm-src}"
WASM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${WASM_DIR}/../public/nam-wasm"
mkdir -p "${OUT_DIR}"

# shellcheck disable=SC1091
source "${EMSDK}/emsdk_env.sh" > /dev/null

# -DNAM_SAMPLE_FLOAT: processAudio 用 float*(NAM Core 默认 double)
# -msimd128 -DNAM_USE_INLINE_GEMM: 与 tone-3000 官方构建一致的优化项
em++ -O3 -std=c++17 -msimd128 -DNAM_SAMPLE_FLOAT -DNAM_USE_INLINE_GEMM \
  -I"${SRC}" -I"${SRC}/Dependencies" -I"${SRC}/Dependencies/nlohmann" -I"${SRC}/Dependencies/eigen" \
  "${SRC}"/NAM/*.cpp "${SRC}"/NAM/wavenet/*.cpp "${WASM_DIR}/nam-dsp-binding.cpp" \
  -sMODULARIZE=1 -sEXPORT_NAME=NamWasmModule \
  -sEXPORTED_FUNCTIONS=_setDsp,_setSampleRate,_setConditioning,_getNumInputChannels,_processAudio,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=stringToUTF8,lengthBytesUTF8 \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 \
  -sFILESYSTEM=0 -sENVIRONMENT=worker,node \
  -fexceptions \
  -o "${OUT_DIR}/nam-wasm-glue.js"

echo "产物:"
ls -la "${OUT_DIR}"
