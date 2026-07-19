/**
 * NAM Core 的极简 emscripten 绑定:只暴露纯 DSP 能力,不涉及任何
 * Web Audio / AudioContext 创建(与 tone-3000 的 t3k-wasm-module.cpp 不同),
 * 因此可嵌入本项目的 AudioWorklet,与其他节点共享同一个 AudioContext。
 *
 * 导出函数:
 *   setDsp(json)       从 .nam JSON 原文构建模型(NAM Core 全架构:LSTM/WaveNet/ConvNet/Container)
 *   setSampleRate(sr)  设置采样率(DC blocker 系数)
 *   processAudio(in, out, n)  单声道处理 n 帧;无模型时直通
 *
 * 对齐官方模块(t3k-wasm-module.cpp)的两个细节:
 *   - 模型加载后按 GetPrewarmSamples() 预热(静默驱动内部状态到位);
 *   - 输出经 10Hz DC blocker(WaveNet 模型常见缓慢 DC 漂移)。
 *
 * 编译:见 build-nam-wasm.sh(产物 nam-wasm-glue.js + nam-wasm.wasm)
 */
#include <NAM/dsp.h>
#include <NAM/get_dsp.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <cstring>
#include <memory>

static std::unique_ptr<nam::DSP> g_model = nullptr;
static float g_dcCoeff = 0.99869f;  // 10Hz @48k 计算值,setSampleRate 后按实际采样率重算
static float g_dcPrevIn = 0.0f;
static float g_dcPrevOut = 0.0f;

extern "C" {

/** 从 .nam JSON 原文加载模型并预热。返回 1 成功,0 构建失败,-1 JSON/配置异常。 */
int setDsp(const char* jsonStr) {
  try {
    auto j = nlohmann::json::parse(jsonStr);
    auto model = nam::get_dsp(j);
    if (!model) return 0;
    // 预热:让模型内部状态(WaveNet 感受野缓冲/LSTM 状态)到位
    model->prewarm();
    g_dcPrevIn = g_dcPrevOut = 0.0f;
    g_model = std::move(model);
    return 1;
  } catch (...) {
    g_model.reset();
    return -1;
  }
}

/** 设置 AudioContext 采样率,重算 DC blocker 系数(10Hz 截止)。 */
void setSampleRate(float sampleRate) {
  const float pi = 3.14159265358979323846f;
  const float omega = 2.0f * pi * 10.0f / sampleRate;
  g_dcCoeff = 1.0f - omega;
}

/** 单声道处理 n 帧 + DC blocker;无模型时直通。 */
void processAudio(float* in, float* out, int n) {
  if (!g_model) {
    if (in != out) std::memcpy(out, in, sizeof(float) * (size_t)n);
    return;
  }
  NAM_SAMPLE* ip = in;
  NAM_SAMPLE* op = out;
  g_model->process(&ip, &op, n);
  float prevIn = g_dcPrevIn;
  float prevOut = g_dcPrevOut;
  for (int i = 0; i < n; i++) {
    const float x = out[i];
    const float y = x - prevIn + g_dcCoeff * prevOut;
    prevIn = x;
    prevOut = y;
    out[i] = y;
  }
  g_dcPrevIn = prevIn;
  g_dcPrevOut = prevOut;
}

}  // extern "C"
