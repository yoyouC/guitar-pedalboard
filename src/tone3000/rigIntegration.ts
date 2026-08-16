import type { RigStore } from '../state/rigStore';
import type { Tone3000ErrorReason, ToneInfo } from './client';
import { buildTone3000Key, parseTone3000Key } from '../audio/namWasm';
import {
  resolvePendingReplaceUid,
  tone3000GearForIntent,
  type Tone3000PendingIntent,
} from './callback';

export type Tone3000TargetIntent =
  | { kind: 'amp' }
  | { kind: 'add-pedal' }
  | { kind: 'replace-pedal'; uid: string };

export interface Tone3000HostedSelectionRequest {
  intent: Tone3000PendingIntent;
  gear: 'amp' | 'pedal';
  architecture: '2' | 'legacy';
  loadToneId?: string;
}

export interface Tone3000RigPort {
  getTone(toneId: string): Promise<ToneInfo>;
  loadModelText(modelRef: string, modelId?: string): Promise<string>;
  selectTone?(
    request: Tone3000HostedSelectionRequest,
  ): Promise<{ toneId: string; modelId?: string } | null>;
  login?(): Promise<boolean>;
  logout?(): void;
  clearModelCache?(): void;
}

export type Tone3000TargetPhase = 'loading' | 'ready' | 'error';

export interface Tone3000TargetState {
  phase: Tone3000TargetPhase;
  toneId: string;
  modelId?: string;
  info?: ToneInfo;
  reason?: Tone3000ErrorReason;
  message?: string;
}

export interface Tone3000RigIntegrationState {
  targets: Record<string, Tone3000TargetState>;
}

export type Tone3000RigResult =
  | { ok: true; uid: string }
  | { ok: false; reason: Tone3000ErrorReason; message: string };

export interface Tone3000RigIntegration {
  getState(): Tone3000RigIntegrationState;
  subscribe(listener: () => void): () => void;
  addPedal(toneId: string, modelId?: string): Promise<Tone3000RigResult>;
  replacePedal(uid: string, toneId: string, modelId?: string): Promise<Tone3000RigResult>;
  selectAmp(toneId: string, modelId?: string): Promise<Tone3000RigResult>;
  selectHosted(
    intent: Tone3000TargetIntent,
    architecture: '2' | 'legacy',
    loadToneId?: string,
  ): Promise<Tone3000RigResult | null>;
  applySelection(
    toneId: string,
    modelId: string | undefined,
    intent: Tone3000PendingIntent | null,
  ): Promise<Tone3000RigResult>;
  login(): Promise<boolean>;
  restoreAll(): Promise<void>;
  retryAll(): Promise<void>;
  logout(): void;
}

function failure(error: unknown): { reason: Tone3000ErrorReason; message: string } {
  const candidate = error as { reason?: unknown; message?: unknown } | null;
  const reason =
    candidate?.reason === 'not-authenticated' || candidate?.reason === 'tone-unavailable'
      ? candidate.reason
      : 'http';
  return {
    reason,
    message: typeof candidate?.message === 'string' ? candidate.message : String(error),
  };
}

function invalidIdentity(
  toneId: string,
  modelId: string | undefined,
): Tone3000RigResult | null {
  if (!/^\d+$/.test(toneId) || (modelId !== undefined && !/^\d+$/.test(modelId))) {
    return {
      ok: false,
      reason: 'tone-unavailable',
      message: 'TONE3000 tone/model id 格式无效',
    };
  }
  return null;
}

export function createTone3000RigIntegration({
  rig,
  port,
}: {
  rig: RigStore;
  port: Tone3000RigPort;
}): Tone3000RigIntegration {
  let state: Tone3000RigIntegrationState = { targets: {} };
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const setTarget = (key: string, target: Tone3000TargetState) => {
    state = { targets: { ...state.targets, [key]: target } };
    emit();
  };
  const requestGenerations = new Map<string, number>();
  const beginRequest = (key: string) => {
    const generation = (requestGenerations.get(key) ?? 0) + 1;
    requestGenerations.set(key, generation);
    return generation;
  };
  const isLatestRequest = (key: string, generation: number) =>
    requestGenerations.get(key) === generation;
  let activeDownloads = 0;
  const pendingDownloads: Array<{
    modelRef: string;
    modelId?: string;
    resolve(value: string): void;
    reject(error: unknown): void;
  }> = [];
  const pumpDownloads = () => {
    while (activeDownloads < 2 && pendingDownloads.length > 0) {
      const request = pendingDownloads.shift()!;
      activeDownloads += 1;
      void port
        .loadModelText(request.modelRef, request.modelId)
        .then(request.resolve, request.reject)
        .finally(() => {
          activeDownloads -= 1;
          pumpDownloads();
        });
    }
  };
  const loadModelText = (modelRef: string, modelId?: string) =>
    new Promise<string>((resolve, reject) => {
      pendingDownloads.push({ modelRef, ...(modelId ? { modelId } : {}), resolve, reject });
      pumpDownloads();
    });
  const isCurrentTarget = (key: string, modelRef: string, modelId?: string) => {
    const current = rig.getState();
    if (key === 'amp') {
      return (
        current.ampCategoryId === 'tone3000' &&
        current.ampModelKeys.tone3000 === modelRef &&
        (current.ampTone3000ModelId ?? undefined) === modelId
      );
    }
    const uid = key.slice('pedal:'.length);
    const item = current.chain.find((candidate) => candidate.uid === uid);
    return item?.modelRef === modelRef && item.modelId === modelId;
  };

  const loadCurrentTarget = async (
    key: string,
    toneId: string,
    modelRef: string,
    modelId?: string,
  ) => {
    const generation = beginRequest(key);
    setTarget(key, { phase: 'loading', toneId, ...(modelId ? { modelId } : {}) });
    try {
      await loadModelText(modelRef, modelId);
      if (!isLatestRequest(key, generation) || !isCurrentTarget(key, modelRef, modelId)) return;
      const stillCurrent = key.startsWith('pedal:')
        ? rig.reloadTone3000Pedal(key.slice('pedal:'.length))
        : rig.reloadTone3000Amp(modelRef, modelId);
      if (!stillCurrent) return;
      const info = await port.getTone(toneId).catch(() => undefined);
      if (!isLatestRequest(key, generation) || !isCurrentTarget(key, modelRef, modelId)) return;
      setTarget(key, {
        phase: 'ready',
        toneId,
        ...(modelId ? { modelId } : {}),
        ...(info ? { info } : {}),
      });
    } catch (error) {
      if (!isLatestRequest(key, generation) || !isCurrentTarget(key, modelRef, modelId)) return;
      const failed = failure(error);
      if (key === 'amp') rig.demoteTone3000Amp(modelRef);
      setTarget(key, {
        phase: 'error',
        toneId,
        ...(modelId ? { modelId } : {}),
        ...failed,
      });
    }
  };

  const loadAllCurrentTargets = async (errorsOnly = false) => {
    const current = rig.getState();
    const tasks: Array<() => Promise<void>> = [];
    for (const item of current.chain) {
      const toneId = item.modelRef ? parseTone3000Key(item.modelRef) : null;
      const key = `pedal:${item.uid}`;
      if (
        toneId !== null &&
        item.modelRef &&
        (!errorsOnly || state.targets[key]?.phase === 'error')
      ) {
        tasks.push(() => loadCurrentTarget(key, toneId, item.modelRef!, item.modelId));
      }
    }
    const ampRef = current.ampModelKeys[current.ampCategoryId];
    const ampToneId = ampRef ? parseTone3000Key(ampRef) : null;
    if (ampToneId !== null && (!errorsOnly || state.targets.amp?.phase === 'error')) {
      tasks.push(() =>
        loadCurrentTarget(
          'amp',
          ampToneId,
          ampRef,
          current.ampTone3000ModelId ?? undefined,
        ),
      );
    }
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const task = tasks[next++];
        await task();
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, tasks.length) }, () => worker()));
  };

  const integration: Tone3000RigIntegration = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async addPedal(toneId, modelId) {
      const invalid = invalidIdentity(toneId, modelId);
      if (invalid) return invalid;
      try {
        const info = await port.getTone(toneId);
        if (info.gear !== 'pedal' || info.format !== 'nam') {
          return {
            ok: false,
            reason: 'tone-unavailable',
            message: '所选 TONE3000 tone 不是 NAM pedal capture',
          };
        }
        const modelRef = buildTone3000Key(toneId);
        const uid = rig.addTone3000Pedal(modelRef, modelId);
        const key = `pedal:${uid}`;
        const generation = beginRequest(key);
        setTarget(key, {
          phase: 'loading',
          toneId,
          ...(modelId ? { modelId } : {}),
          info,
        });
        try {
          await loadModelText(modelRef, modelId);
          if (!isLatestRequest(key, generation) || !isCurrentTarget(key, modelRef, modelId)) {
            return { ok: true, uid };
          }
          rig.reloadTone3000Pedal(uid);
          setTarget(key, {
            phase: 'ready',
            toneId,
            ...(modelId ? { modelId } : {}),
            info,
          });
          return { ok: true, uid };
        } catch (error) {
          if (!isLatestRequest(key, generation) || !isCurrentTarget(key, modelRef, modelId)) {
            return { ok: true, uid };
          }
          const failed = failure(error);
          setTarget(key, {
            phase: 'error',
            toneId,
            ...(modelId ? { modelId } : {}),
            info,
            ...failed,
          });
          // gear 校验后 ChainItem 已是 canonical 用户意图；下载失败属于可重试运行态。
          return { ok: true, uid };
        }
      } catch (error) {
        return { ok: false, ...failure(error) };
      }
    },
    async replacePedal(uid, toneId, modelId) {
      const invalid = invalidIdentity(toneId, modelId);
      if (invalid) return invalid;
      const key = `pedal:${uid}`;
      const current = rig.getState().chain.find((item) => item.uid === uid && item.modelRef);
      if (!current) {
        return { ok: false, reason: 'tone-unavailable', message: '目标单块已不存在' };
      }
      const previousTarget = state.targets[key];
      const previousToneId = parseTone3000Key(current.modelRef!)!;
      const generation = beginRequest(key);
      setTarget(key, {
        phase: 'loading',
        toneId,
        ...(modelId ? { modelId } : {}),
      });
      try {
        const info = await port.getTone(toneId);
        if (info.gear !== 'pedal' || info.format !== 'nam') {
          throw Object.assign(new Error('所选 TONE3000 tone 不是 NAM pedal capture'), {
            reason: 'tone-unavailable',
          });
        }
        const modelRef = buildTone3000Key(toneId);
        await loadModelText(modelRef, modelId);
        if (!isLatestRequest(key, generation)) {
          return { ok: false, reason: 'tone-unavailable', message: '替换请求已被更新' };
        }
        if (!rig.replaceTone3000Pedal(uid, modelRef, modelId)) {
          throw Object.assign(new Error('目标单块已不存在'), { reason: 'tone-unavailable' });
        }
        setTarget(key, {
          phase: 'ready',
          toneId,
          ...(modelId ? { modelId } : {}),
          info,
        });
        return { ok: true, uid };
      } catch (error) {
        const failed = failure(error);
        if (!isLatestRequest(key, generation)) return { ok: false, ...failed };
        setTarget(
          key,
          previousTarget ?? {
            phase: 'error',
            toneId: previousToneId,
            ...(current.modelId ? { modelId: current.modelId } : {}),
            ...failed,
            message: `替换失败，仍保留原模型：${failed.message}`,
          },
        );
        return { ok: false, ...failed };
      }
    },
    async selectAmp(toneId, modelId) {
      const invalid = invalidIdentity(toneId, modelId);
      if (invalid) return invalid;
      const generation = beginRequest('amp');
      setTarget('amp', { phase: 'loading', toneId, ...(modelId ? { modelId } : {}) });
      try {
        const info = await port.getTone(toneId);
        if (info.gear !== 'amp' || info.format !== 'nam') {
          throw Object.assign(new Error('所选 TONE3000 tone 不是 NAM amp capture'), {
            reason: 'tone-unavailable',
          });
        }
        const modelRef = buildTone3000Key(toneId);
        await loadModelText(modelRef, modelId);
        if (!isLatestRequest('amp', generation)) {
          return { ok: false, reason: 'tone-unavailable', message: '箱头选择已被更新' };
        }
        rig.setAmpModel('tone3000', modelRef, modelId);
        setTarget('amp', {
          phase: 'ready',
          toneId,
          ...(modelId ? { modelId } : {}),
          info,
        });
        return { ok: true, uid: 'amp' };
      } catch (error) {
        const failed = failure(error);
        if (!isLatestRequest('amp', generation)) return { ok: false, ...failed };
        setTarget('amp', {
          phase: 'error',
          toneId,
          ...(modelId ? { modelId } : {}),
          ...failed,
        });
        return { ok: false, ...failed };
      }
    },
    async selectHosted(targetIntent, architecture, loadToneId) {
      if (!port.selectTone) {
        return { ok: false, reason: 'http', message: 'TONE3000 OAuth adapter 未注册' };
      }
      let intent: Tone3000PendingIntent;
      if (targetIntent.kind === 'replace-pedal') {
        const chain = rig.getState().chain;
        const returnIndex = chain.findIndex((item) => item.uid === targetIntent.uid);
        const returnModelRef = returnIndex >= 0 ? chain[returnIndex].modelRef : undefined;
        intent = {
          ...targetIntent,
          architecture,
          ...(returnIndex >= 0 ? { returnIndex } : {}),
          ...(returnModelRef ? { returnModelRef } : {}),
        };
      } else {
        intent = { ...targetIntent, architecture };
      }
      try {
        const selection = await port.selectTone({
          intent,
          gear: tone3000GearForIntent(intent),
          architecture,
          ...(loadToneId ? { loadToneId } : {}),
        });
        if (!selection) return null;
        return integration.applySelection(selection.toneId, selection.modelId, intent);
      } catch (error) {
        return { ok: false, ...failure(error) };
      }
    },
    async applySelection(toneId, modelId, intent) {
      let result: Tone3000RigResult;
      if (intent?.kind === 'add-pedal') {
        result = await integration.addPedal(toneId, modelId);
      } else if (intent?.kind === 'replace-pedal') {
        const uid = resolvePendingReplaceUid(intent, rig.getState().chain);
        result = uid
          ? await integration.replacePedal(uid, toneId, modelId)
          : { ok: false, reason: 'tone-unavailable', message: '目标单块已不存在' };
      } else {
        // 无 intent 是旧 redirect stash，保留原箱头语义。
        result = await integration.selectAmp(toneId, modelId);
      }
      if (result.ok) await integration.retryAll();
      return result;
    },
    async login() {
      if (!port.login) return false;
      const authenticated = await port.login();
      if (authenticated) await integration.retryAll();
      return authenticated;
    },
    restoreAll: loadAllCurrentTargets,
    retryAll: () => loadAllCurrentTargets(true),
    logout() {
      port.logout?.();
      port.clearModelCache?.();
    },
  };
  return integration;
}
