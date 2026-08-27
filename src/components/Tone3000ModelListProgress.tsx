import type { Tone3000ModelListProgress as ModelListProgress } from '../tone3000/client';
import { tone3000ModelListProgressText } from '../tone3000/modelListProgressPresentation';

export function Tone3000ModelListProgress({
  progress,
}: {
  progress: ModelListProgress;
}) {
  return (
    <div className="tone3000-notice" role="status" aria-live="polite">
      {tone3000ModelListProgressText(progress)}
    </div>
  );
}
