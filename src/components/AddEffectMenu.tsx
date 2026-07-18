import { EFFECT_REGISTRY } from '../audio/effects';

interface AddEffectMenuProps {
  onAdd: (effectId: string) => void;
}

/** 链条末尾的“添加效果器”入口 */
export function AddEffectMenu({ onAdd }: AddEffectMenuProps) {
  return (
    <div className="add-effect">
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) onAdd(e.target.value);
        }}
      >
        <option value="" disabled>
          + 添加效果器
        </option>
        {EFFECT_REGISTRY.map((def) => (
          <option key={def.id} value={def.id}>
            {def.name}
          </option>
        ))}
      </select>
    </div>
  );
}
