export interface RuntimeTransaction<Runtime> {
  /** 准备候选 runtime；此阶段不得破坏当前 runtime。 */
  prepare(): Promise<Runtime>;
  /** 让候选 runtime 可发声；失败仍未提交。 */
  activate(candidate: Runtime): Promise<void>;
  /** 原子替换调用方持有的 current，并清理旧 runtime。 */
  commit(candidate: Runtime): Promise<void>;
  /** 恢复当前 runtime，并清理尚未提交的候选。 */
  rollback(candidate: Runtime | null, error: unknown): Promise<void>;
}

export type ProfileSwitchBlock = 'recording' | 'looper-not-empty' | null;

export function profileSwitchBlock(
  recording: boolean,
  looper: { phase: string; lengthSeconds: number },
): ProfileSwitchBlock {
  if (recording) return 'recording';
  if (looper.phase !== 'empty' || looper.lengthSeconds > 0) return 'looper-not-empty';
  return null;
}

/** AudioContext 档位切换的事务骨架；只有 prepare+activate 全成功才 commit。 */
export async function runRuntimeTransaction<Runtime>(
  transaction: RuntimeTransaction<Runtime>,
): Promise<void> {
  let candidate: Runtime | null = null;
  try {
    candidate = await transaction.prepare();
    await transaction.activate(candidate);
    await transaction.commit(candidate);
  } catch (error) {
    await transaction.rollback(candidate, error);
    throw error;
  }
}
