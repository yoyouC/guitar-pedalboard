/**
 * Tone3000 API v1 客户端(ADR-0007):OAuth 2.0 + PKCE、令牌轮转、模型获取。
 * 零依赖(WebCrypto + fetch);fetch/storage 经构造注入,node 下可测
 * (见 tests/tone3000-client.test.ts)。协议参照官方 tone3000-client.ts
 * (github.com/tone-3000/api)与 https://www.tone3000.com/api。
 *
 * 合规要点(API Terms):不缓存目录、模型仅在用户请求时按用户身份下载;
 * publishable key(t3k_pub_…)官方明确可公开,作为静态常量随仓提交。
 */

const API_BASE = 'https://www.tone3000.com';

/** 令牌/临时值的持久化面(生产:localStorage;测试:内存 stub) */
export interface Tone3000Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Tone3000ClientConfig {
  /** publishable key(= OAuth client_id,官方明确浏览器可公开) */
  clientId: string;
  redirectUri: string;
  fetchFn: typeof fetch;
  storage: Tone3000Storage;
  /** 测试用:覆盖 API 域名 */
  apiBase?: string;
}

export interface T3KTokens {
  access_token: string;
  refresh_token: string;
  /** Unix ms,access token 过期时刻 */
  expires_at: number;
}

export type OAuthPrompt = 'select_tone' | 'load_tone';

export type OAuthCallbackResult =
  | { ok: true; tokens: T3KTokens; toneId?: string; modelId?: string }
  | { ok: false; error: string };

/** tone 失效(被删/转私有/无权限)与未登录等客户端错误的分类 */
export type Tone3000ErrorReason = 'not-authenticated' | 'tone-unavailable' | 'http';

export class Tone3000Error extends Error {
  readonly reason: Tone3000ErrorReason;
  readonly status?: number;

  constructor(reason: Tone3000ErrorReason, message: string, status?: number) {
    super(message);
    this.name = 'Tone3000Error';
    this.reason = reason;
    this.status = status;
  }
}

export interface Tone3000Client {
  buildAuthorizeUrl(options?: {
    prompt?: OAuthPrompt;
    toneId?: string;
    format?: 'nam';
    gears?: string;
  }): Promise<{ url: string; state: string }>;
  handleCallback(callbackUrl: string): Promise<OAuthCallbackResult>;
  isAuthenticated(): boolean;
  logout(): void;
  /**
   * 获取 tone 的 NAM 模型文本:listModels(tone_id)→ 选 A1/Custom 架构模型
   * → Bearer 下载。未登录抛 not-authenticated;tone 失效抛 tone-unavailable。
   */
  getModelText(toneId: string): Promise<string>;
  /** 获取 tone 元数据(归属展示:标题/作者/许可/链接,ToS 要求展示) */
  getTone(toneId: string): Promise<ToneInfo>;
}

/** tone 元数据(归属展示用) */
export interface ToneInfo {
  id: number;
  title: string;
  username: string;
  license: string;
  url: string;
}

// ---------- PKCE ----------

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomBase64url(bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return base64url(new Uint8Array(digest));
}

const TOKENS_KEY = 't3k_tokens';
const VERIFIER_KEY = 't3k_code_verifier';
const STATE_KEY = 't3k_state';
/** 提前 60s 刷新,避免请求中途过期(与官方客户端一致) */
const REFRESH_SKEW_MS = 60_000;

export function createTone3000Client(config: Tone3000ClientConfig): Tone3000Client {
  const apiBase = (config.apiBase ?? API_BASE).replace(/\/+$/, '');
  const { fetchFn, storage } = config;

  // ---------- 令牌 ----------

  function getTokens(): T3KTokens | null {
    const raw = storage.getItem(TOKENS_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T3KTokens;
    } catch {
      return null;
    }
  }

  function setTokens(tokens: T3KTokens): void {
    storage.setItem(TOKENS_KEY, JSON.stringify(tokens));
  }

  function clearTokens(): void {
    storage.removeItem(TOKENS_KEY);
  }

  let refreshPromise: Promise<T3KTokens> | null = null;

  async function refreshTokens(refreshToken: string): Promise<T3KTokens> {
    const res = await fetchFn(`${apiBase}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: config.clientId,
      }),
    });
    if (!res.ok) throw new Tone3000Error('not-authenticated', '令牌刷新失败', res.status);
    const data = await res.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
  }

  /** 有效 access token;过期自动轮转;未登录/轮转失败抛 not-authenticated */
  async function getAccessToken(): Promise<string> {
    const tokens = getTokens();
    if (!tokens) throw new Tone3000Error('not-authenticated', '未登录 TONE3000');
    if (Date.now() > tokens.expires_at - REFRESH_SKEW_MS) {
      if (!refreshPromise) {
        refreshPromise = refreshTokens(tokens.refresh_token)
          .then((t) => {
            setTokens(t);
            refreshPromise = null;
            return t;
          })
          .catch((err) => {
            clearTokens();
            refreshPromise = null;
            throw err;
          });
      }
      return (await refreshPromise).access_token;
    }
    return tokens.access_token;
  }

  /** 带 Bearer 的 API 请求;401 时强制轮转重放一次(官方客户端同款语义) */
  async function apiFetch(path: string): Promise<Response> {
    const token = await getAccessToken();
    let res = await fetchFn(`${apiBase}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 && getTokens()) {
      const stored = getTokens()!;
      setTokens({ ...stored, expires_at: 0 });
      const retryToken = await getAccessToken();
      res = await fetchFn(`${apiBase}${path}`, {
        headers: { Authorization: `Bearer ${retryToken}` },
      });
    }
    return res;
  }

  // ---------- OAuth ----------

  async function buildAuthorizeUrl(
    options: { prompt?: OAuthPrompt; toneId?: string; format?: 'nam'; gears?: string } = {},
  ): Promise<{ url: string; state: string }> {
    const codeVerifier = randomBase64url(32);
    const [codeChallenge, state] = await Promise.all([
      sha256Base64url(codeVerifier),
      Promise.resolve(randomBase64url(16)),
    ]);
    storage.setItem(VERIFIER_KEY, codeVerifier);
    storage.setItem(STATE_KEY, state);

    const url = new URL(`${apiBase}/api/v1/oauth/authorize`);
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    if (options.prompt) url.searchParams.set('prompt', options.prompt);
    if (options.toneId) url.searchParams.set('tone_id', options.toneId);
    if (options.format) url.searchParams.set('format', options.format);
    if (options.gears) url.searchParams.set('gears', options.gears);
    return { url: url.toString(), state };
  }

  async function handleCallback(callbackUrl: string): Promise<OAuthCallbackResult> {
    const params = new URL(callbackUrl).searchParams;
    const code = params.get('code');
    const error = params.get('error');
    const returnedState = params.get('state');
    const toneId = params.get('tone_id') ?? undefined;
    const modelId = params.get('model_id') ?? undefined;
    const canceled = params.get('canceled') === 'true';

    const storedState = storage.getItem(STATE_KEY);
    const codeVerifier = storage.getItem(VERIFIER_KEY);
    storage.removeItem(STATE_KEY);
    storage.removeItem(VERIFIER_KEY);

    if (returnedState !== storedState) return { ok: false, error: 'state_mismatch' };
    if (canceled && !code) return { ok: false, error: 'canceled' };
    if (error) return { ok: false, error };
    if (!code || !codeVerifier) return { ok: false, error: 'missing_code' };

    const res = await fetchFn(`${apiBase}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: err.error ?? 'token_exchange_failed' };
    }
    const data = await res.json();
    const tokens: T3KTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };
    setTokens(tokens);
    return { ok: true, tokens, toneId, modelId };
  }

  // ---------- 模型获取 ----------

  interface ApiModel {
    id: number;
    model_url: string;
    size: string;
    architecture_version: '1' | '2' | 'custom';
  }

  /** 选装载目标:A1/Custom 架构(首版不支持 A2),优先 standard 尺寸 */
  function pickModel(models: ApiModel[]): ApiModel | null {
    const compatible = models.filter((m) => m.architecture_version !== '2');
    if (compatible.length === 0) return null;
    return compatible.find((m) => m.size === 'standard') ?? compatible[0];
  }

  async function getModelText(toneId: string): Promise<string> {
    const listRes = await apiFetch(`/api/v1/models?tone_id=${encodeURIComponent(toneId)}`);
    if (listRes.status === 404 || listRes.status === 403) {
      throw new Tone3000Error('tone-unavailable', `tone ${toneId} 不可访问(已删除/转私有)`, listRes.status);
    }
    if (!listRes.ok) {
      throw new Tone3000Error('http', `模型列表获取失败 HTTP ${listRes.status}`, listRes.status);
    }
    const list = (await listRes.json()) as { data?: ApiModel[] };
    const model = pickModel(list.data ?? []);
    if (!model) {
      throw new Tone3000Error('tone-unavailable', `tone ${toneId} 没有兼容的 NAM 模型(A1/Custom)`);
    }
    // model_url 必须带 Bearer 下载(官方约定;可能非同源,直连完整 URL)
    const token = await getAccessToken();
    const downloadRes = await fetchFn(model.model_url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!downloadRes.ok) {
      throw new Tone3000Error('http', `模型下载失败 HTTP ${downloadRes.status}`, downloadRes.status);
    }
    return downloadRes.text();
  }

  async function getTone(toneId: string): Promise<ToneInfo> {
    const res = await apiFetch(`/api/v1/tones/${encodeURIComponent(toneId)}`);
    if (res.status === 404 || res.status === 403) {
      throw new Tone3000Error('tone-unavailable', `tone ${toneId} 不可访问(已删除/转私有)`, res.status);
    }
    if (!res.ok) {
      throw new Tone3000Error('http', `tone 获取失败 HTTP ${res.status}`, res.status);
    }
    const t = (await res.json()) as {
      id: number;
      title?: string;
      license?: string;
      url?: string;
      user?: { username?: string };
    };
    return {
      id: t.id,
      title: t.title ?? `Tone #${toneId}`,
      username: t.user?.username ?? '未知作者',
      license: t.license ?? 't3k',
      url: t.url ?? `https://www.tone3000.com/tones/${toneId}`,
    };
  }

  return {
    buildAuthorizeUrl,
    handleCallback,
    isAuthenticated: () => getTokens() !== null,
    logout: clearTokens,
    getModelText,
    getTone,
  };
}
