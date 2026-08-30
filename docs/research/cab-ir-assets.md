# Cabinet IR asset licensing research

Research snapshot: 2026-08-28.

This note evaluates whether a concrete WAV may be bundled with and redistributed from this
repository. “Free to download” or “free to use in music” is not sufficient: the source must identify
the asset and grant redistribution rights. This is a provenance record, not legal advice.

## Result

| Existing cab label | Status | Candidate | Conclusion |
|---|---|---|---|
| `1x12 Open` | **Approved** | Tone Factor `TF 66 DR 1X12 JENSN C12NA - 57 U87 70-30.wav` | Exact Deluxe/Jensen open-combo match; direct project redistribution permission confirmed by the project owner. |
| `2x12 Blue` | **Approved** | Tone Factor `TF AC 2X12 BLUE ALNICO 57 3 - Top Boost.wav` | Exact AC30 / 2x12 Blue match; direct project redistribution permission confirmed by the project owner. |
| `4x12 Greenback` | **Approved** | Tone Factor `TF 71 MARSH 4X12 G12M GREEN - 57 R121 70-30.wav` | Exact 1971 G12M Greenback 4x12 match; direct project redistribution permission confirmed by the project owner. |
| `4x12 V30` | **Approved** | Tone Factor `TF ORANGE 4X12 V30 57 3 - Enhanced.wav` | Exact Orange/Vintage 30 4x12 match; direct project redistribution permission confirmed by the project owner. |

The CC0 assets below remain documented as fallback provenance options. They are not the selected
production assets; the project-approved Tone Factor choices and their separate authorization basis
are recorded later in this note.

## Cleared: 4x12 Greenback

- **Author/source:** Jester Dyne Productions (Bastian Karschewski), [official Emerald Pack release page](https://www.jester-dyne-productions.com/emerald-ir-pack/).
- **Original archive:** [Emerald Pack 1.0.zip](https://www.jester-dyne-productions.com/content/files/2023/04/Emerald-Pack-1.0.zip).
- **Concrete file:** `Emerald Pack 1.0/Impulses/48kHz/1_Nacho_Guacamole_48.wav`.
- **Capture identity:** the author's page identifies the cabinet as a Marshall 1960AX 4x12 with Celestion Greenback G12-M 25W speakers. The handbook inside the original archive maps “Nacho Guacamole” to an SM57 on the upper-left speaker.
- **Format verified from the file:** mono, 48 kHz, 24-bit signed PCM, 9,542 samples (about 199 ms).
- **SHA-256 of the original WAV:** `c1d0a337732ae6407b30055305e3ae579a9231b0a515b27795fb206946ef19fb`.
- **License proof:** the handbook inside the author's archive states that the pack is licensed under CC0 and explains that it may be distributed, remixed, adapted, and built upon without conditions. The same file is independently ledgered as CC0 and cleared for bundling in OrbitCab's [asset-license record](https://github.com/darwinscat/orbitcab/blob/main/docs/ASSET-LICENSES.md).
- **Immutable inspection mirror:** OrbitCab commit [`9081c0b`](https://github.com/darwinscat/orbitcab/blob/9081c0bdd84b325836d56aaebdb3955dbd9ccc0c/resources/ir/16-nacho-guacamole.wav) contains a byte-identical copy. This mirror is useful for verification; the author's archive remains the primary source.

[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) permits copying, modification,
distribution, and commercial use without permission or mandatory attribution. Preserve a courtesy
credit and the source URL in the project's asset ledger anyway. CC0 does not grant trademark rights;
brand names must remain descriptive and must not imply endorsement.

**Remaining approval:** approve this specific mic/position by listening. The Emerald Pack contains
six valid CC0 alternatives, so licensing alone does not establish that “Nacho Guacamole” is the best
default.

## Cleared: 4x12 V30

- **Author/source:** jesterdyne, [Freesound sound 616702](https://freesound.org/people/jesterdyne/sounds/616702/).
- **Concrete file shown by the source:** `Cabinet IR BG412S Even V30 SM57`, type Wave (`.wav`). Confirm the original filename after the authenticated Freesound download; the public title does not display the suffix.
- **Capture identity:** the author states that the IR was captured from their modified Behringer BG412S, fitted with two Celestion Vintage 30 speakers. The file is tagged V30; “Even” is described as the mix-ready, universal/full SM57 version. The cabinet is a 4x12 model; the manufacturer's [BG412S specification PDF](https://mediadl.musictribe.com/media/sys_master/hc4/hc3/8849870880798.pdf) documents four 8-ohm/100 W speakers and 400 W mono operation.
- **Format published on the file page:** mono, 48 kHz, 24-bit WAV, 1.196 seconds, 168.3 KB.
- **License proof:** the individual file page marks this sound **Creative Commons 0** and expressly permits copying, modification, distribution, and commercial use without asking permission.

The [CC0 1.0 deed](https://creativecommons.org/publicdomain/zero/1.0/) imposes no attribution
condition. Recommended courtesy notice: `Cabinet IR BG412S Even V30 SM57 — jesterdyne — Freesound
sound 616702 — CC0 1.0`. Do not use cabinet or speaker branding in a way that suggests endorsement.

**Remaining approval:** Freesound requires an account to retrieve the original file, so record the
downloaded filename and SHA-256 before committing it. The file is also much longer than the cleared
Greenback IR. If it is trimmed or faded, record the transformation and derivative checksum; CC0
allows that modification, but the sonic and runtime policy is a product decision.

## Blocked: 1x12 Open

The best exact physical match found is Shift Line's Fender Deluxe Reverb entry in its [Guitar HD IR
Pack 1](https://shift-line.com/guitarhdirpack1). The official page identifies a single Jensen P12R
in a compact open-back combo, publishes 48 kHz/24-bit WAV variants, and documents the pack naming
scheme. However, that page does **not** publish a license permitting the WAV to be hosted in another
repository or bundled in third-party software. A free download is not a redistribution grant.

Shift Line's published terms for its other free IR packs explicitly say that implementation in
third-party software or hardware requires permission; for example, see the [Bass IR Pack terms](https://shift-line.com/irpackbass).
Those terms are not asserted here as the license for Guitar HD IR Pack 1; they are evidence that the
word “free” on a Shift Line download must not be interpreted as permission to redistribute.

**Unblock condition:** obtain a written grant from Shift Line that specifically permits commercial
repository/application redistribution of a named Fender Deluxe Reverb WAV, or commission/capture an
original 1x12 open-back IR under CC0/CC-BY.

The CC0 Freesound file [`1x12 Black Panel.wav`](https://freesound.org/people/jesterdyne/sounds/129391/)
is **not recommended as a substitute**. Its source identifies it only as a 5 ms capture of a Korg
AX1500g cabinet-simulation algorithm; it neither proves an open-back physical cabinet nor documents
the upstream rights in the commercial hardware simulation.

## Blocked: 2x12 Blue

The exact physical match found is Shift Line's Vox AC30 entry in [Guitar HD IR Pack 1](https://shift-line.com/guitarhdirpack1).
The official page explicitly identifies two 12-inch Celestion Alnico Blue speakers and publishes
the format and naming scheme. It does not grant redistribution or application-bundling rights, so it
cannot be copied into this repository without written permission.

**Unblock condition:** obtain a written redistribution grant for a specifically named Vox AC30 WAV,
or commission/capture an original 2x12 Alnico Blue IR under CC0/CC-BY.

The CC0 Freesound files [`2x12 AC130.wav`](https://freesound.org/people/jesterdyne/sounds/129396/)
and [`2x12 Class A.wav`](https://freesound.org/people/jesterdyne/sounds/129394/) are **not recommended
as substitutes**. Both are 5 ms captures of a Korg AX1500g cabinet-simulation algorithm, and neither
source identifies Alnico Blue speakers or establishes the uploader's rights in the upstream commercial
simulation.

## Tone Factor evaluated selection

The locally purchased Tone Factor packs contain exact physical matches for all four product labels.
The standard retail-pack instructions and EULA prohibit redistribution; however, the project owner
confirmed on 2026-08-28 that the project has obtained separate direct permission to embed and
redistribute these four selected files. The separate permission held by the project owner—not the
retail EULA—would have permitted their inclusion. After listening review, the product owner chose the
original DSP defaults instead, so the candidate WAVs are not distributed by production.

The evaluated 48 kHz Starter selections were:

| Product cab | Exact Tone Factor candidate | Selection intent | First-window spectral check |
|---|---|---|---|
| `1x12 Open` | `TF 66 DR 1X12 JENSN C12NA - 57 U87 70-30.wav` | A balanced SM57/U87 blend keeps the Deluxe/Jensen option open and comparatively transparent. | centroid 1,621 Hz; rolloff 3,246 Hz |
| `2x12 Blue` | `TF AC 2X12 BLUE ALNICO 57 3 - Top Boost.wav` | The author-provided Top Boost variant preserves the AC30/Blue option's intended chime without choosing the brightest Starter file. | centroid 1,766 Hz; rolloff 3,246 Hz |
| `4x12 Greenback` | `TF 71 MARSH 4X12 G12M GREEN - 57 R121 70-30.wav` | The G12M cabinet and SM57/R121 blend give the warm vintage Greenback contrast expected by the existing label. | centroid 1,869 Hz; rolloff 3,926 Hz |
| `4x12 V30` | `TF ORANGE 4X12 V30 57 3 - Enhanced.wav` | The close SM57 Enhanced variant retains the V30 option's upper-mid attack while avoiding the even brighter Top Boost files. | centroid 2,933 Hz; rolloff 5,168 Hz |

All four selected files were inspected as mono, 48 kHz, 24-bit PCM, 500 ms WAVs. The spectral values
are comparative measurements of the first 4,096 samples using a Hann window; they help separate the
four intended voicings but are not a substitute for level-matched guitar listening. User-facing Cab
LEVEL defaults remain the legacy `-1/-1.5/-2/-2 dB` values. Independently, the manifest records an
asset calibration gain of `-15.909/-12.388/-16.436/-13.376 dB`: this matches each raw IR's 70 Hz–10
kHz pink-weighted RMS transfer to its corresponding legacy Biquad response at unity gain (48 kHz,
1,024 linearly spaced frequency samples). Runtime applies that gain inside each Convolver lane before
the unchanged user LEVEL. Fixed-DI blind listening remains the release approval for perceived level
and tone.

Custom IR 不复用某一个内置箱体的校准值。运行时以同一 pink-power 测量口径把每个导入
文件对齐到 `+1.8 dB` 的公共资产目标，并把其确定性 `calibrationDb` 存入本地 Library；
配合 `-2 dB` 的 Custom 新建 LEVEL，四个生产 WAV 以相同文件重新导入时，与对应内置身份
的默认输出差均不超过 `0.5 dB`。该处理只缩放固定资产增益，不修改 IR 文件或演奏动态。

License evidence was inspected from the following files in the local purchase:

- `TONE FACTOR - XR IR PACK - 66 DELUXE REVERB 1x12 - V1-1/READ ME - Instructions.pdf`
- `TONE FACTOR - XR IR PACK - AC30 6TB BLUE ALNICO 2x12 - V1-1/READ ME - Instructions.pdf`
- `Tone Factor '71 Marsh G12 Greenback Full Stack 4x12 XR IR Pack v1.1/READ ME - Instructions.pdf`
- `Tone Factor Orang V30 4x12 XR IR Pack/READ ME - License Agreement.pdf`

## Sources explicitly rejected for bundling

- A precise TONE3000 [Marshall 1960 4x12 Celestion G12M](https://www.tone3000.com/tones/marshall-1960-4x12-celestion-g12m-28968)
  capture exists, but its T3K license permits use and rendered output while prohibiting upload,
  republication, or distribution of the data file without the author's permission.
- Overdriven.fr permits its free IRs in musical/video output but [expressly prohibits other hosting,
  product bundling, and preset redistribution](https://overdriven.fr/overdriven/index.php/about/).
- Files copied into third-party GitHub collections without a per-file author, capture identity, and
  license proof are not acceptable provenance even when the repository itself has an open-source
  code license.

## Decision

Do not ship any of the four evaluated Tone Factor files. Restore the four product defaults to their
original Biquad DSP and retain convolution only for user-provided Custom IR files (ADR-0028). Keep the
selection and authorization research as decision history; do not relabel the low-confidence Korg
simulation captures as physical Open/Blue cabinets.
