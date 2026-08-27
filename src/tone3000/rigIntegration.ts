import type { RigStore } from '../state/rigStore';
import type {
  Tone3000ErrorReason,
  Tone3000ModelInfo,
  Tone3000ModelListProgress,
  ToneInfo,
} from './client';
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

export type Tone3000ModelVariantIntent =
  | Tone3000PendingIntent
  | { kind: 'switch-amp-model-variant' }
  | { kind: 'switch-pedal-model-variant'; uid: string };

export interface Tone3000HostedSelectionRequest {
  intent: Tone3000PendingIntent;
  gear: 'amp' | 'pedal';
  architecture: '2' | 'legacy';
  loadToneId?: string;
}

export interface Tone3000RigPort {
  getTone(toneId: string): Promise<ToneInfo>;
  listModels?(
    toneId: string,
    onProgress?: (progress: Tone3000ModelListProgress) => void,
  ): Promise<Tone3000ModelInfo[]>;
  getModelInfo?(toneId: string, modelId: string): Promise<Tone3000ModelInfo>;
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
  modelVariant?: Tone3000ModelInfo;
  reason?: Tone3000ErrorReason;
  message?: string;
}

export interface Tone3000RigIntegrationState {
  targets: Record<string, Tone3000TargetState>;
  selection?: Tone3000ModelVariantSelection;
  modelListProgress?: Tone3000ModelListProgress & { toneId: string };
}

export interface Tone3000ModelVariantSelection {
  toneId: string;
  preferredModelId?: string;
  modelVariants: Tone3000ModelInfo[];
  intent: Tone3000ModelVariantIntent;
  currentModelId?: string;
  currentModelUnavailable: boolean;
  resumed?: boolean;
}

export type Tone3000PrepareSelectionResult =
  | { ok: true; status: 'choose' }
  | { ok: true; status: 'applied'; result: Tone3000RigResult }
  | { ok: false; reason: Tone3000ErrorReason; message: string };

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
    resumed?: boolean,
  ): Promise<Tone3000PrepareSelectionResult | null>;
  prepareSelection(
    toneId: string,
    preferredModelId: string | undefined,
    intent: Tone3000ModelVariantIntent,
    resumed?: boolean,
  ): Promise<Tone3000PrepareSelectionResult>;
  prepareRedirectSelection(
    toneId: string,
    preferredModelId: string | undefined,
    intent: Tone3000PendingIntent | null,
  ): Promise<Tone3000PrepareSelectionResult>;
  prepareAmpModelVariantSwitch(): Promise<Tone3000PrepareSelectionResult>;
  preparePedalModelVariantSwitch(uid: string): Promise<Tone3000PrepareSelectionResult>;
  confirmSelection(modelId: string): Promise<Tone3000RigResult>;
  cancelSelection(): void;
  applySelection(
    toneId: string,
    modelId: string | undefined,
    intent: Tone3000ModelVariantIntent | null,
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
): Extract<Tone3000RigResult, { ok: false }> | null {
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
    state = { ...state, targets: { ...state.targets, [key]: target } };
    emit();
  };
  const setSelection = (selection?: Tone3000ModelVariantSelection) => {
    state = { ...state, ...(selection ? { selection } : { selection: undefined }) };
    emit();
  };
  const setModelListProgress = (
    progress?: Tone3000ModelListProgress & { toneId: string },
  ) => {
    state = {
      ...state,
      ...(progress ? { modelListProgress: progress } : { modelListProgress: undefined }),
    };
    emit();
  };
  const attachModelVariant = (
    result: Tone3000RigResult,
    modelVariant: Tone3000ModelInfo,
  ) => {
    if (!result.ok) return;
    const key = result.uid === 'amp' ? 'amp' : `pedal:${result.uid}`;
    const target = state.targets[key];
    if (target) setTarget(key, { ...target, modelVariant });
  };
  const requestGenerations = new Map<string, number>();
  let selectionGeneration = 0;
  const modelListSessions = new Map<
    string,
    {
      promise: Promise<Tone3000ModelInfo[]>;
      listeners: Set<(progress: Tone3000ModelListProgress) => void>;
      progress?: Tone3000ModelListProgress;
    }
  >();
  const clearModelListSessions = () => {
    for (const session of modelListSessions.values()) session.listeners.clear();
    modelListSessions.clear();
  };
  const releaseModelListSession = (toneId: string) => {
    const session = modelListSessions.get(toneId);
    session?.listeners.clear();
    modelListSessions.delete(toneId);
  };
  const listModelVariants = (
    toneId: string,
    onProgress: (progress: Tone3000ModelListProgress) => void,
  ): Promise<Tone3000ModelInfo[]> => {
    for (const activeToneId of modelListSessions.keys()) {
      if (activeToneId !== toneId) releaseModelListSession(activeToneId);
    }
    let session = modelListSessions.get(toneId);
    if (!session) {
      let resolve!: (modelVariants: Tone3000ModelInfo[]) => void;
      let reject!: (error: unknown) => void;
      session = {
        promise: new Promise<Tone3000ModelInfo[]>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
        listeners: new Set(),
      };
      session.listeners.add(onProgress);
      modelListSessions.set(toneId, session);
      void port.listModels!(toneId, (progress) => {
        const currentSession = modelListSessions.get(toneId);
        if (currentSession !== session) return;
        session!.progress = progress;
        for (const listener of session!.listeners) listener(progress);
      }).then(resolve, reject);
    } else {
      session.listeners.add(onProgress);
      if (session.progress) onProgress(session.progress);
    }
    return session.promise.finally(() => session!.listeners.delete(onProgress));
  };
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

  const switchModelVariant = async ({
    key,
    toneId,
    modelRef,
    modelId,
    uid,
    isCandidateStillCurrent,
    commit,
    staleMessage,
  }: {
    key: string;
    toneId: string;
    modelRef: string;
    modelId: string;
    uid: string;
    isCandidateStillCurrent(): boolean;
    commit(): boolean;
    staleMessage: string;
  }): Promise<Tone3000RigResult> => {
    const generation = beginRequest(key);
    try {
      await loadModelText(modelRef, modelId);
      if (
        !isLatestRequest(key, generation) ||
        !isCandidateStillCurrent() ||
        !commit()
      ) {
        return { ok: false, reason: 'tone-unavailable', message: staleMessage };
      }
      const info = await port.getTone(toneId).catch(() => undefined);
      setTarget(key, {
        phase: 'ready',
        toneId,
        modelId,
        ...(info ? { info } : {}),
      });
      return { ok: true, uid };
    } catch (error) {
      return { ok: false, ...failure(error) };
    }
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
      const [info, modelVariant] = await Promise.all([
        port.getTone(toneId).catch(() => undefined),
        modelId && port.getModelInfo
          ? port.getModelInfo(toneId, modelId).catch(() => undefined)
          : Promise.resolve(undefined),
      ]);
      if (!isLatestRequest(key, generation) || !isCurrentTarget(key, modelRef, modelId)) return;
      setTarget(key, {
        phase: 'ready',
        toneId,
        ...(modelId ? { modelId } : {}),
        ...(info ? { info } : {}),
        ...(modelVariant ? { modelVariant } : {}),
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
    async prepareSelection(toneId, preferredModelId, intent, resumed = false) {
      const invalid = invalidIdentity(toneId, preferredModelId);
      if (invalid) return invalid;
      if (!port.listModels) {
        return { ok: false, reason: 'http', message: 'TONE3000 采样列表 adapter 未注册' };
      }
      const generation = ++selectionGeneration;
      try {
        const expectedGear =
          intent.kind === 'switch-amp-model-variant'
            ? 'amp'
            : intent.kind === 'switch-pedal-model-variant'
              ? 'pedal'
              : tone3000GearForIntent(intent);
        const tone = await port.getTone(toneId);
        if (tone.gear !== expectedGear || tone.format !== 'nam') {
          return {
            ok: false,
            reason: 'tone-unavailable',
            message: `所选 TONE3000 tone 不是 NAM ${expectedGear} capture`,
          };
        }
        const architectureOrder: Record<Tone3000ModelInfo['architecture'], number> = {
          '2': 0,
          '1': 1,
          custom: 2,
        };
        const current = rig.getState();
        const currentModelId = (() => {
          if (
            (intent.kind === 'switch-amp-model-variant' || intent.kind === 'amp') &&
            current.ampCategoryId === 'tone3000' &&
            current.ampModelKeys.tone3000 === buildTone3000Key(toneId)
          ) {
            return current.ampTone3000ModelId ?? undefined;
          }
          if (intent.kind === 'switch-pedal-model-variant') {
            const item = current.chain.find((candidate) => candidate.uid === intent.uid);
            return item?.modelRef === buildTone3000Key(toneId) ? item.modelId : undefined;
          }
          if (intent.kind === 'replace-pedal') {
            const uid = resolvePendingReplaceUid(intent, current.chain) ?? intent.uid;
            const item = current.chain.find((candidate) => candidate.uid === uid);
            return item?.modelRef === buildTone3000Key(toneId) ? item.modelId : undefined;
          }
          return undefined;
        })();
        const prioritizedModelId = currentModelId ?? preferredModelId;
        setModelListProgress({ toneId, completedPages: 0 });
        const listedModelVariants = await listModelVariants(toneId, (progress) => {
          if (generation === selectionGeneration) {
            setModelListProgress({ toneId, ...progress });
          }
        });
        if (generation !== selectionGeneration) {
          return {
            ok: false,
            reason: 'tone-unavailable',
            message: '采样列表请求已被更新',
          };
        }
        const modelVariants = listedModelVariants
          .filter((modelVariant) => modelVariant.toneId === toneId && /^\d+$/.test(modelVariant.id))
          .sort((left, right) => {
            if (left.id === prioritizedModelId) return -1;
            if (right.id === prioritizedModelId) return 1;
            return (
              architectureOrder[left.architecture] - architectureOrder[right.architecture] ||
              left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }) ||
              left.size.localeCompare(right.size) ||
              Number(left.id) - Number(right.id)
            );
          });
        setModelListProgress(undefined);
        if (modelVariants.length === 0) {
          releaseModelListSession(toneId);
          return {
            ok: false,
            reason: 'tone-unavailable',
            message: '此 TONE3000 Tone 没有兼容采样',
          };
        }
        const currentModelUnavailable =
          currentModelId !== undefined && !modelVariants.some((modelVariant) => modelVariant.id === currentModelId);
        if (modelVariants.length === 1 && !currentModelUnavailable) {
          releaseModelListSession(toneId);
          setSelection(undefined);
          const result = await integration.applySelection(toneId, modelVariants[0].id, intent);
          attachModelVariant(result, modelVariants[0]);
          return result.ok ? { ok: true, status: 'applied', result } : result;
        }
        setSelection({
          toneId,
          ...(preferredModelId ? { preferredModelId } : {}),
          modelVariants,
          intent,
          ...(currentModelId ? { currentModelId } : {}),
          currentModelUnavailable,
          ...(resumed ? { resumed: true } : {}),
        });
        return { ok: true, status: 'choose' };
      } catch (error) {
        if (generation === selectionGeneration) {
          releaseModelListSession(toneId);
          setModelListProgress(undefined);
        }
        return { ok: false, ...failure(error) };
      }
    },
    prepareRedirectSelection(toneId, preferredModelId, intent) {
      return integration.prepareSelection(
        toneId,
        preferredModelId,
        intent ?? { kind: 'amp', architecture: 'legacy' },
        true,
      );
    },
    async prepareAmpModelVariantSwitch() {
      const current = rig.getState();
      const modelRef = current.ampModelKeys[current.ampCategoryId];
      const toneId =
        current.ampCategoryId === 'tone3000' && modelRef
          ? parseTone3000Key(modelRef)
          : null;
      if (toneId === null) {
        return {
          ok: false,
          reason: 'tone-unavailable',
          message: '当前箱头不是 TONE3000 Tone',
        };
      }
      return integration.prepareSelection(
        toneId,
        current.ampTone3000ModelId ?? undefined,
        { kind: 'switch-amp-model-variant' },
      );
    },
    async preparePedalModelVariantSwitch(uid) {
      const item = rig.getState().chain.find((candidate) => candidate.uid === uid);
      const toneId = item?.modelRef ? parseTone3000Key(item.modelRef) : null;
      if (toneId === null) {
        return {
          ok: false,
          reason: 'tone-unavailable',
          message: '目标单块不是 TONE3000 Tone',
        };
      }
      return integration.prepareSelection(toneId, item?.modelId, {
        kind: 'switch-pedal-model-variant',
        uid,
      });
    },
    async confirmSelection(modelId) {
      const selection = state.selection;
      if (!selection || !selection.modelVariants.some((modelVariant) => modelVariant.id === modelId)) {
        return {
          ok: false,
          reason: 'tone-unavailable',
          message: '所选 TONE3000 采样不在当前列表中',
        };
      }
      const result = await integration.applySelection(
        selection.toneId,
        modelId,
        selection.intent,
      );
      if (result.ok) {
        attachModelVariant(
          result,
          selection.modelVariants.find((modelVariant) => modelVariant.id === modelId)!,
        );
        clearModelListSessions();
        setSelection(undefined);
      }
      return result;
    },
    cancelSelection() {
      selectionGeneration += 1;
      clearModelListSessions();
      setModelListProgress(undefined);
      setSelection(undefined);
    },
    async selectHosted(targetIntent, architecture, loadToneId, resumed = false) {
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
        return integration.prepareSelection(selection.toneId, selection.modelId, intent, resumed);
      } catch (error) {
        return { ok: false, ...failure(error) };
      }
    },
    async applySelection(toneId, modelId, intent) {
      let result: Tone3000RigResult;
      if (intent?.kind === 'switch-amp-model-variant') {
        if (!modelId) {
          return { ok: false, reason: 'tone-unavailable', message: '切换采样需要精确 model id' };
        }
        const modelRef = buildTone3000Key(toneId);
        const current = rig.getState();
        const previousModelId = current.ampTone3000ModelId ?? undefined;
        if (
          current.ampCategoryId !== 'tone3000' ||
          current.ampModelKeys.tone3000 !== modelRef
        ) {
          return { ok: false, reason: 'tone-unavailable', message: '当前箱头 Tone 已改变' };
        }
        result = await switchModelVariant({
          key: 'amp',
          toneId,
          modelRef,
          modelId,
          uid: 'amp',
          isCandidateStillCurrent: () => {
            const latest = rig.getState();
            return (
              latest.ampCategoryId === 'tone3000' &&
              latest.ampModelKeys.tone3000 === modelRef &&
              (latest.ampTone3000ModelId ?? undefined) === previousModelId
            );
          },
          commit: () => rig.reloadTone3000Amp(modelRef, modelId),
          staleMessage: '箱头采样切换请求已被更新',
        });
      } else if (intent?.kind === 'switch-pedal-model-variant') {
        if (!modelId) {
          return { ok: false, reason: 'tone-unavailable', message: '切换采样需要精确 model id' };
        }
        const modelRef = buildTone3000Key(toneId);
        const currentItem = rig
          .getState()
          .chain.find((candidate) => candidate.uid === intent.uid);
        if (!currentItem || currentItem.modelRef !== modelRef) {
          return { ok: false, reason: 'tone-unavailable', message: '目标单块 Tone 已改变' };
        }
        const previousModelId = currentItem.modelId;
        const key = `pedal:${intent.uid}`;
        result = await switchModelVariant({
          key,
          toneId,
          modelRef,
          modelId,
          uid: intent.uid,
          isCandidateStillCurrent: () => {
            const latest = rig
              .getState()
              .chain.find((candidate) => candidate.uid === intent.uid);
            return latest?.modelRef === modelRef && latest.modelId === previousModelId;
          },
          commit: () => rig.replaceTone3000Pedal(intent.uid, modelRef, modelId),
          staleMessage: '单块采样切换请求已被更新',
        });
      } else if (intent?.kind === 'add-pedal') {
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
      clearModelListSessions();
      setModelListProgress(undefined);
      setSelection(undefined);
    },
  };
  return integration;
}
