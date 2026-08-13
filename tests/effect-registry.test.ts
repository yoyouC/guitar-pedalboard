import assert from 'node:assert/strict';
import test from 'node:test';
import { EFFECT_REGISTRY } from '../src/audio/effects/index.ts';

/**
 * 效果注册表快照 pin(issue #4):数据化工厂重构前后,注册表的内容、
 * 顺序与形状(id、name、color、完整参数表)必须逐字节一致。
 * 快照生成自重构前代码;如需有意变更注册表,同步更新此快照。
 */
const SNAPSHOT = [
  {
    "id": "noiseGate",
    "name": "Noise Gate",
    "color": "#8a8f98",
    "params": [
      {
        "key": "threshold",
        "label": "Threshold",
        "min": -90,
        "max": 0,
        "step": 1,
        "defaultValue": -50,
        "unit": "dB"
      },
      {
        "key": "attack",
        "label": "Attack",
        "min": 0.001,
        "max": 0.05,
        "step": 0.001,
        "defaultValue": 0.005,
        "unit": "s"
      },
      {
        "key": "release",
        "label": "Release",
        "min": 0.01,
        "max": 0.5,
        "step": 0.01,
        "defaultValue": 0.08,
        "unit": "s"
      }
    ]
  },
  {
    "id": "whammy",
    "name": "Whammy",
    "color": "#c0392b",
    "params": [
      {
        "key": "position",
        "label": "TREADLE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 0,
        "unit": "%"
      },
      {
        "key": "range",
        "label": "RANGE",
        "min": -2,
        "max": 2,
        "step": 1,
        "defaultValue": 2,
        "unit": "st"
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "compressor",
    "name": "Compressor",
    "color": "#4a90d9",
    "params": [
      {
        "key": "threshold",
        "label": "Threshold",
        "min": -60,
        "max": 0,
        "step": 1,
        "defaultValue": -24,
        "unit": "dB"
      },
      {
        "key": "ratio",
        "label": "Ratio",
        "min": 1,
        "max": 20,
        "step": 0.5,
        "defaultValue": 4
      },
      {
        "key": "attack",
        "label": "Attack",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 10,
        "unit": "ms"
      },
      {
        "key": "release",
        "label": "Release",
        "min": 10,
        "max": 1000,
        "step": 10,
        "defaultValue": 250,
        "unit": "ms"
      },
      {
        "key": "makeup",
        "label": "Makeup",
        "min": 0,
        "max": 12,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "la2a",
    "name": "LA-2A 光学压缩 ⚗",
    "color": "#c9862d",
    "params": [
      {
        "key": "reduction",
        "label": "REDUCTION",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 30
      },
      {
        "key": "gain",
        "label": "GAIN",
        "min": 0,
        "max": 30,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      },
      {
        "key": "mode",
        "label": "MODE",
        "min": 0,
        "max": 1,
        "step": 1,
        "defaultValue": 0
      }
    ]
  },
  {
    "id": "fet1176",
    "name": "1176 FET 压缩 ⚗",
    "color": "#31405c",
    "params": [
      {
        "key": "threshold",
        "label": "THRESHOLD",
        "min": -60,
        "max": 0,
        "step": 1,
        "defaultValue": -20,
        "unit": "dB"
      },
      {
        "key": "ratio",
        "label": "RATIO",
        "min": 0,
        "max": 4,
        "step": 1,
        "defaultValue": 1
      },
      {
        "key": "attack",
        "label": "ATTACK",
        "min": 20,
        "max": 800,
        "step": 1,
        "defaultValue": 200,
        "unit": "µs"
      },
      {
        "key": "release",
        "label": "RELEASE",
        "min": 50,
        "max": 1100,
        "step": 5,
        "defaultValue": 250,
        "unit": "ms"
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "dynacomp",
    "name": "Dyna Comp 压缩 ⚗",
    "color": "#c0392b",
    "params": [
      {
        "key": "sensitivity",
        "label": "SENSITIVITY",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "klon",
    "name": "Transparent OD",
    "color": "#c8a24a",
    "params": [
      {
        "key": "gain",
        "label": "GAIN",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 35
      },
      {
        "key": "treble",
        "label": "TREBLE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": -19.5,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "overdrive",
    "name": "Overdrive",
    "color": "#3f9e4d",
    "params": [
      {
        "key": "drive",
        "label": "Drive",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50,
        "unit": "%"
      },
      {
        "key": "tone",
        "label": "Tone",
        "min": 500,
        "max": 8000,
        "step": 50,
        "defaultValue": 3000,
        "unit": "Hz"
      },
      {
        "key": "level",
        "label": "Level",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": -19,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "ts808",
    "name": "TS808 Drive",
    "color": "#2e8b57",
    "params": [
      {
        "key": "drive",
        "label": "DRIVE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 45
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 55
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": -11,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "ts808wdf",
    "name": "TS808 WDF ⚗",
    "color": "#1f6e43",
    "params": [
      {
        "key": "drive",
        "label": "DRIVE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 45
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 55
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "klonwdf",
    "name": "Klon WDF ⚗",
    "color": "#b8860b",
    "params": [
      {
        "key": "gain",
        "label": "GAIN",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 30
      },
      {
        "key": "treble",
        "label": "TREBLE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "ratwdf",
    "name": "RAT WDF ⚗",
    "color": "#26262a",
    "params": [
      {
        "key": "drive",
        "label": "DIST",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 55
      },
      {
        "key": "filter",
        "label": "FILTER",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 35
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "ds1wdf",
    "name": "DS-1 WDF ⚗",
    "color": "#d97218",
    "params": [
      {
        "key": "dist",
        "label": "DIST",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "fuzzfacewdf",
    "name": "Fuzz Face WDF ⚗",
    "color": "#a93226",
    "params": [
      {
        "key": "fuzz",
        "label": "FUZZ",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 70
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "bigmuffwdf",
    "name": "Big Muff WDF ⚗",
    "color": "#b03a2e",
    "params": [
      {
        "key": "sustain",
        "label": "SUSTAIN",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "distortion",
    "name": "Distortion",
    "color": "#c0392b",
    "params": [
      {
        "key": "gain",
        "label": "Gain",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 60
      },
      {
        "key": "tone",
        "label": "Tone",
        "min": 500,
        "max": 8000,
        "step": 50,
        "defaultValue": 2500,
        "unit": "Hz"
      },
      {
        "key": "level",
        "label": "Level",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": -18,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "rat",
    "name": "RAT Dist",
    "color": "#26262a",
    "params": [
      {
        "key": "drive",
        "label": "DIST",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 55
      },
      {
        "key": "filter",
        "label": "FILTER",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 35
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": -19.5,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "fuzz",
    "name": "Fuzz",
    "color": "#d35400",
    "params": [
      {
        "key": "fuzz",
        "label": "Fuzz",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 65
      },
      {
        "key": "tone",
        "label": "Tone",
        "min": 400,
        "max": 6000,
        "step": 50,
        "defaultValue": 2200,
        "unit": "Hz"
      },
      {
        "key": "level",
        "label": "Level",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": -18,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "autowah",
    "name": "Auto-Wah",
    "color": "#27ae60",
    "params": [
      {
        "key": "sens",
        "label": "SENS",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 60
      },
      {
        "key": "freq",
        "label": "FREQ",
        "min": 150,
        "max": 1200,
        "step": 10,
        "defaultValue": 400,
        "unit": "Hz"
      },
      {
        "key": "reso",
        "label": "RESO",
        "min": 1,
        "max": 12,
        "step": 0.5,
        "defaultValue": 6
      },
      {
        "key": "mix",
        "label": "MIX",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 100
      }
    ]
  },
  {
    "id": "crybabywdf",
    "name": "Wah WDF ⚗",
    "color": "#3a3f46",
    "params": [
      {
        "key": "position",
        "label": "TREADLE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50,
        "unit": "%"
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "wahpedal",
    "name": "Wah",
    "color": "#23262b",
    "params": [
      {
        "key": "position",
        "label": "TREADLE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50,
        "unit": "%"
      },
      {
        "key": "reso",
        "label": "RESO",
        "min": 50,
        "max": 200,
        "step": 1,
        "defaultValue": 100,
        "unit": "%"
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": 0,
        "max": 200,
        "step": 1,
        "defaultValue": 100,
        "unit": "%"
      }
    ]
  },
  {
    "id": "eq",
    "name": "3-Band EQ",
    "color": "#16a085",
    "params": [
      {
        "key": "low",
        "label": "Low",
        "min": -15,
        "max": 15,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      },
      {
        "key": "mid",
        "label": "Mid",
        "min": -15,
        "max": 15,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      },
      {
        "key": "high",
        "label": "High",
        "min": -15,
        "max": 15,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "chorus",
    "name": "Chorus",
    "color": "#9b59b6",
    "params": [
      {
        "key": "rate",
        "label": "Rate",
        "min": 0.1,
        "max": 5,
        "step": 0.1,
        "defaultValue": 0.8,
        "unit": "Hz"
      },
      {
        "key": "depth",
        "label": "Depth",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50,
        "unit": "%"
      },
      {
        "key": "mix",
        "label": "Mix",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50,
        "unit": "%"
      }
    ]
  },
  {
    "id": "flanger",
    "name": "Flanger",
    "color": "#e67e22",
    "params": [
      {
        "key": "rate",
        "label": "Rate",
        "min": 0.1,
        "max": 2,
        "step": 0.01,
        "defaultValue": 0.3,
        "unit": "Hz"
      },
      {
        "key": "depth",
        "label": "Depth",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 60,
        "unit": "%"
      },
      {
        "key": "feedback",
        "label": "Feedback",
        "min": 0,
        "max": 95,
        "step": 1,
        "defaultValue": 50,
        "unit": "%"
      },
      {
        "key": "mix",
        "label": "Mix",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50,
        "unit": "%"
      }
    ]
  },
  {
    "id": "phaser",
    "name": "Phaser",
    "color": "#1abc9c",
    "params": [
      {
        "key": "rate",
        "label": "Rate",
        "min": 0.1,
        "max": 5,
        "step": 0.1,
        "defaultValue": 0.5,
        "unit": "Hz"
      },
      {
        "key": "depth",
        "label": "Depth",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 70,
        "unit": "%"
      }
    ]
  },
  {
    "id": "tremolo",
    "name": "Tremolo",
    "color": "#f1c40f",
    "params": [
      {
        "key": "rate",
        "label": "Rate",
        "min": 0.5,
        "max": 10,
        "step": 0.1,
        "defaultValue": 5,
        "unit": "Hz"
      },
      {
        "key": "depth",
        "label": "Depth",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50,
        "unit": "%"
      }
    ]
  },
  {
    "id": "delay",
    "name": "Delay",
    "color": "#3498db",
    "params": [
      {
        "key": "time",
        "label": "Time",
        "min": 50,
        "max": 2000,
        "step": 1,
        "defaultValue": 400,
        "unit": "ms"
      },
      {
        "key": "feedback",
        "label": "Feedback",
        "min": 0,
        "max": 90,
        "step": 1,
        "defaultValue": 35,
        "unit": "%"
      },
      {
        "key": "mix",
        "label": "Mix",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 30,
        "unit": "%"
      }
    ]
  },
  {
    "id": "analogdelay",
    "name": "模拟延迟 ⚗",
    "color": "#b0793a",
    "params": [
      {
        "key": "time",
        "label": "TIME",
        "min": 20,
        "max": 600,
        "step": 1,
        "defaultValue": 300,
        "unit": "ms"
      },
      {
        "key": "feedback",
        "label": "FEEDBACK",
        "min": 0,
        "max": 95,
        "step": 1,
        "defaultValue": 40,
        "unit": "%"
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 55
      },
      {
        "key": "mod",
        "label": "MOD",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 0,
        "unit": "%"
      },
      {
        "key": "mix",
        "label": "MIX",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 35,
        "unit": "%"
      }
    ]
  },
  {
    "id": "tapedelay",
    "name": "磁带延迟 ⚗",
    "color": "#b5651d",
    "params": [
      {
        "key": "time",
        "label": "TIME",
        "min": 50,
        "max": 1000,
        "step": 1,
        "defaultValue": 400,
        "unit": "ms"
      },
      {
        "key": "feedback",
        "label": "FEEDBACK",
        "min": 0,
        "max": 110,
        "step": 1,
        "defaultValue": 40,
        "unit": "%"
      },
      {
        "key": "wow",
        "label": "WOW",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 30
      },
      {
        "key": "saturation",
        "label": "SATURATION",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 40
      },
      {
        "key": "mix",
        "label": "MIX",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 30,
        "unit": "%"
      }
    ]
  },
  {
    "id": "pingpong",
    "name": "乒乓延迟 ⚗",
    "color": "#9b59b6",
    "params": [
      {
        "key": "time",
        "label": "TIME",
        "min": 50,
        "max": 1500,
        "step": 1,
        "defaultValue": 400,
        "unit": "ms"
      },
      {
        "key": "feedback",
        "label": "FEEDBACK",
        "min": 0,
        "max": 90,
        "step": 1,
        "defaultValue": 40,
        "unit": "%"
      },
      {
        "key": "mix",
        "label": "MIX",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 30,
        "unit": "%"
      }
    ]
  },
  {
    "id": "reverb",
    "name": "Reverb",
    "color": "#5d6d7e",
    "params": [
      {
        "key": "time",
        "label": "Time",
        "min": 0.5,
        "max": 6,
        "step": 0.1,
        "defaultValue": 2.5,
        "unit": "s"
      },
      {
        "key": "decay",
        "label": "Decay",
        "min": 1,
        "max": 6,
        "step": 0.1,
        "defaultValue": 2.5
      },
      {
        "key": "mix",
        "label": "Mix",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 35,
        "unit": "%"
      }
    ]
  },
  {
    "id": "springreverb",
    "name": "弹簧混响 ⚗",
    "color": "#4e8d8d",
    "params": [
      {
        "key": "time",
        "label": "TIME",
        "min": 1,
        "max": 4,
        "step": 0.1,
        "defaultValue": 2,
        "unit": "s"
      },
      {
        "key": "dwell",
        "label": "DWELL",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 50
      },
      {
        "key": "mix",
        "label": "MIX",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 30,
        "unit": "%"
      }
    ]
  },
  {
    "id": "plate",
    "name": "板式混响 ⚗",
    "color": "#9b59b6",
    "params": [
      {
        "key": "time",
        "label": "TIME",
        "min": 0.5,
        "max": 6,
        "step": 0.05,
        "defaultValue": 2.5,
        "unit": "s"
      },
      {
        "key": "damp",
        "label": "DAMP",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 40
      },
      {
        "key": "preDelay",
        "label": "PREDELAY",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 0,
        "unit": "ms"
      },
      {
        "key": "mix",
        "label": "MIX",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 30,
        "unit": "%"
      }
    ]
  },
  {
    "id": "shimmer",
    "name": "微光混响 ⚗",
    "color": "#7b6cf0",
    "params": [
      {
        "key": "time",
        "label": "TIME",
        "min": 2,
        "max": 8,
        "step": 0.1,
        "defaultValue": 4.5,
        "unit": "s"
      },
      {
        "key": "shimmer",
        "label": "SHIMMER",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 40,
        "unit": "%"
      },
      {
        "key": "damp",
        "label": "DAMP",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 40,
        "unit": "%"
      },
      {
        "key": "mix",
        "label": "MIX",
        "min": 0,
        "max": 100,
        "step": 1,
        "defaultValue": 35,
        "unit": "%"
      }
    ]
  },
  {
    "id": "volume",
    "name": "Volume & Pan",
    "color": "#bdc3c7",
    "params": [
      {
        "key": "level",
        "label": "Level",
        "min": -60,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      },
      {
        "key": "pan",
        "label": "Pan",
        "min": -50,
        "max": 50,
        "step": 1,
        "defaultValue": 0
      }
    ]
  },
  {
    "id": "namComp",
    "name": "NAM Comp",
    "color": "#2e8b57",
    "params": [
      {
        "key": "threshold",
        "label": "THRESH",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "ratio",
        "label": "RATIO",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "attack",
        "label": "ATTACK",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "release",
        "label": "RELEASE",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namTs",
    "name": "NAM TS",
    "color": "#3f7a3f",
    "params": [
      {
        "key": "drive",
        "label": "DRIVE",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namRat",
    "name": "NAM RAT",
    "color": "#5a5a5a",
    "params": [
      {
        "key": "distortion",
        "label": "DIST",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "filter",
        "label": "FILTER",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namDs1",
    "name": "NAM DS-1",
    "color": "#c8842a",
    "params": [
      {
        "key": "dist",
        "label": "DIST",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namFf",
    "name": "NAM FuzzFace",
    "color": "#8a4a8a",
    "params": [
      {
        "key": "fuzz",
        "label": "FUZZ",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namGr",
    "name": "NAM GreenMuff",
    "color": "#4a6b3a",
    "params": [
      {
        "key": "sustain",
        "label": "SUSTAIN",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "tone",
        "label": "TONE",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namMxr",
    "name": "NAM Dist+",
    "color": "#b03a2e",
    "params": [
      {
        "key": "distortion",
        "label": "DIST",
        "min": 0,
        "max": 1,
        "step": 0.01,
        "defaultValue": 0.5
      },
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namSd1",
    "name": "NAM SD-1",
    "color": "#c8a24a",
    "params": [
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namFortin",
    "name": "NAM Fortin",
    "color": "#7a7a7a",
    "params": [
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  },
  {
    "id": "namKlone",
    "name": "NAM Klone",
    "color": "#8a8f98",
    "params": [
      {
        "key": "level",
        "label": "LEVEL",
        "min": -30,
        "max": 6,
        "step": 0.5,
        "defaultValue": 0,
        "unit": "dB"
      }
    ]
  }
];

test('EFFECT_REGISTRY 与快照一致(内容、顺序、参数表)', () => {
  const actual = EFFECT_REGISTRY.map((d) => ({
    id: d.id,
    name: d.name,
    color: d.color,
    params: d.params,
  }));
  assert.deepEqual(actual, SNAPSHOT);
});
