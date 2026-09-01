import type { CSSProperties } from 'react';
import { EFFECT_REGISTRY } from '../../audio/effects';
import { hashString } from './hash';

const MAX_PEDALS = 5;
const UNKNOWN_PEDAL_COLOR = '#4a4f57';

/** id → pedal enclosure color; unknown ids (e.g. withdrawn pedals) fall back to neutral gray. */
function pedalColor(id: string): string {
  return EFFECT_REGISTRY.find((d) => d.id === id)?.color ?? UNKNOWN_PEDAL_COLOR;
}

export interface MiniRigChainProps {
  pedalIds: string[];
  ampId?: string;
  /**
   * @deprecated The amp block no longer renders a text label (it truncated
   * badly at card scale); kept only for call-site compatibility.
   */
  ampName?: string;
  /** Seed (usually the preset id) for the deterministic backdrop gradient. */
  seed?: string;
  compact?: boolean;
  /** Banner-sized variant for the tone detail hero: larger objects, calmer backdrop. */
  hero?: boolean;
}

/**
 * Signature marketplace card visual: a mini signal chain built purely from
 * data — one colored mini stompbox per pedal plus an amp block at the end,
 * on a seeded gradient backdrop with a patch-cable line and a vignette.
 * Presentational only; renders nothing interactive.
 */
export function MiniRigChain({ pedalIds, ampId, seed, compact = false, hero = false }: MiniRigChainProps) {
  const shown = pedalIds.slice(0, MAX_PEDALS);
  const overflow = pedalIds.length - shown.length;

  const style: CSSProperties = {};
  if (seed) {
    const h = hashString(seed);
    const hueA = h % 360;
    const hueB = (hueA + 36 + ((h >> 9) % 48)) % 360;
    style.background = hero
      ? `linear-gradient(135deg, hsl(${hueA} 22% 15%), hsl(${hueB} 18% 9%))`
      : `linear-gradient(135deg, hsl(${hueA} 30% 22%), hsl(${hueB} 26% 12%))`;
  }

  const className = [
    'mk-rig-chain',
    compact ? 'mk-rig-chain--compact' : '',
    hero ? 'mk-rig-chain--hero' : '',
    shown.length === 0 && ampId ? 'mk-rig-chain--amp-only' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={className} style={style} aria-hidden="true">
      {shown.map((id, index) => (
        <div key={`${id}-${index}`} className="mk-rig-pedal" style={{ backgroundColor: pedalColor(id) }}>
          <div className="mk-rig-pedal__knobs">
            <span className="mk-rig-pedal__knob" />
            <span className="mk-rig-pedal__knob" />
            <span className="mk-rig-pedal__knob" />
          </div>
          <span className="mk-rig-pedal__led" />
        </div>
      ))}
      {overflow > 0 && <span className="mk-rig-overflow">+{overflow}</span>}
      {ampId && <div className="mk-rig-amp" />}
    </div>
  );
}
