import { getEffectDef } from '../audio/effects';
import { getAmpDef } from '../audio/amps';
import { getCabDef } from '../audio/cabs';
import { getAmpModelEntry } from '../audio/ampCategories';
import type { InputSourceType } from '../audio/AudioEngine';
import type { RigStoreState } from '../state/rigStore';
import { useRig } from '../state/useRig';

/** 信号流向文本(rig 派生;selector 返回字符串,内容不变时不重渲染) */
function signalFlowText(s: RigStoreState): string {
  let text = `信号流向:输入 → ${s.chain
    .filter((i) => !i.post)
    .map((i) => getEffectDef(i.effectId).name)
    .join(' → ')}`;
  if (s.ampEnabled) {
    text += ` → ${getAmpModelEntry(s.ampModelKeys[s.ampCategoryId])?.name ?? getAmpDef(s.ampId).name}`;
  }
  const post = s.chain.filter((i) => i.post);
  if (post.length > 0) {
    text += ` → [FX Loop] ${post.map((i) => getEffectDef(i.effectId).name).join(' → ')}`;
  }
  if (s.cabEnabled) text += ` → ${getCabDef(s.cabId).name}`;
  text += ' → 输出';
  if (s.globalBypass) text += '(全局 Bypass 中)';
  return text;
}

/** 页脚:信号流向 + 输入源提示 + 模型许可链接 */
export function RigFooter({ inputType }: { inputType: InputSourceType | null }) {
  const flow = useRig(signalFlowText);
  return (
    <footer className="app-footer">
      {flow}
      {!inputType && <span className="hint"> — 请在上方选择一个输入源开始</span>}
      {' · '}
      <a href="models/ATTRIBUTION.md" target="_blank" rel="noreferrer">
        模型许可
      </a>
    </footer>
  );
}
