import assert from 'node:assert/strict';
import test from 'node:test';
import { createTone3000Client, type Tone3000Storage } from '../src/tone3000/client.ts';

/**
 * Tone3000 API 客户端测试:fetch/storage 注入,mock 全部网络。
 * 协议参照官方 tone3000-client.ts(github.com/tone-3000/api)与 API v1 文档。
 */

const CLIENT_ID = 't3k_pub_test';
const REDIRECT_URI = 'http://localhost:5173/tone3000/callback';

function memoryStorage(): Tone3000Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (req: RecordedRequest) => { status: number; body?: unknown }) {
  const requests: RecordedRequest[] = [];
  const fetchFn = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req: RecordedRequest = { url: String(url), init };
    requests.push(req);
    const { status, body } = handler(req);
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchFn: fetchFn as typeof fetch, requests };
}

function makeClient(fetchFn: typeof fetch, storage = memoryStorage()) {
  return createTone3000Client({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    fetchFn,
    storage,
  });
}

// ---------- PKCE 授权 URL ----------

test('buildAuthorizeUrl: PKCE S256 + select_tone prompt + 必填参数齐全', async () => {
  const { fetchFn } = mockFetch(() => ({ status: 500 }));
  const storage = memoryStorage();
  const client = makeClient(fetchFn, storage);

  const { url, state } = await client.buildAuthorizeUrl({ prompt: 'select_tone', format: 'nam' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://www.tone3000.com/api/v1/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('prompt'), 'select_tone');
  assert.equal(u.searchParams.get('format'), 'nam');
  assert.equal(u.searchParams.get('state'), state);
  // code_challenge = base64url(SHA256(verifier));verifier 已存入 storage
  const verifier = storage.getItem('t3k_code_verifier');
  assert.ok(verifier);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(u.searchParams.get('code_challenge'), expected);
});

test('buildAuthorizeUrl: load_tone 携带 tone_id', async () => {
  const { fetchFn } = mockFetch(() => ({ status: 500 }));
  const client = makeClient(fetchFn);
  const { url } = await client.buildAuthorizeUrl({ prompt: 'load_tone', toneId: '79103' });
  const u = new URL(url);
  assert.equal(u.searchParams.get('prompt'), 'load_tone');
  assert.equal(u.searchParams.get('tone_id'), '79103');
});

// ---------- 回调处理 ----------

function callbackUrl(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return `${REDIRECT_URI}?${qs}`;
}

test('handleCallback: 成功交换 code → 令牌入库,返回选中的 toneId', async () => {
  const { fetchFn, requests } = mockFetch((req) => {
    assert.equal(req.url, 'https://www.tone3000.com/api/v1/oauth/token');
    const body = req.init?.body as URLSearchParams;
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'CODE123');
    assert.equal(body.get('client_id'), CLIENT_ID);
    assert.equal(body.get('redirect_uri'), REDIRECT_URI);
    assert.ok(body.get('code_verifier'));
    return {
      status: 200,
      body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
    };
  });
  const storage = memoryStorage();
  const client = makeClient(fetchFn, storage);
  const { state } = await client.buildAuthorizeUrl({ prompt: 'select_tone' });

  const result = await client.handleCallback(callbackUrl({ code: 'CODE123', state, tone_id: '79103' }));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.tokens.access_token, 'AT');
    assert.equal(result.toneId, '79103');
  }
  assert.ok(storage.getItem('t3k_tokens')?.includes('"AT"'));
  // PKCE 临时值已清除
  assert.equal(storage.getItem('t3k_code_verifier'), null);
  assert.equal(requests.length, 1);
});

test('handleCallback: state 不匹配拒绝,不发 token 请求', async () => {
  const { fetchFn, requests } = mockFetch(() => ({ status: 200, body: {} }));
  const client = makeClient(fetchFn);
  await client.buildAuthorizeUrl({ prompt: 'select_tone' });
  const result = await client.handleCallback(callbackUrl({ code: 'X', state: 'forged' }));
  assert.deepEqual(result, { ok: false, error: 'state_mismatch' });
  assert.equal(requests.length, 0);
});

test('handleCallback: access_denied(模型私有)透传错误', async () => {
  const { fetchFn } = mockFetch(() => ({ status: 200, body: {} }));
  const client = makeClient(fetchFn);
  const { state } = await client.buildAuthorizeUrl({ prompt: 'load_tone', toneId: '1' });
  const result = await client.handleCallback(callbackUrl({ error: 'access_denied', state }));
  assert.deepEqual(result, { ok: false, error: 'access_denied' });
});

// ---------- 令牌轮转与 401 重放 ----------

function seedTokens(storage: ReturnType<typeof memoryStorage>, expiresInMs: number) {
  storage.setItem(
    't3k_tokens',
    JSON.stringify({ access_token: 'OLD_AT', refresh_token: 'OLD_RT', expires_at: Date.now() + expiresInMs }),
  );
}

test('getModelText: 过期令牌自动轮转后用新令牌下载', async () => {
  const { fetchFn, requests } = mockFetch((req) => {
    if (req.url.endsWith('/oauth/token')) {
      const body = req.init?.body as URLSearchParams;
      assert.equal(body.get('grant_type'), 'refresh_token');
      assert.equal(body.get('refresh_token'), 'OLD_RT');
      return { status: 200, body: { access_token: 'NEW_AT', refresh_token: 'NEW_RT', expires_in: 3600 } };
    }
    if (req.url.includes('/api/v1/models?tone_id=')) {
      assert.equal(req.init?.headers?.Authorization, 'Bearer NEW_AT');
      return {
        status: 200,
        body: { data: [{ id: 1, model_url: 'https://cdn.example.com/m.nam', size: 'standard', architecture_version: '1' }] },
      };
    }
    if (req.url === 'https://cdn.example.com/m.nam') {
      assert.equal(req.init?.headers?.Authorization, 'Bearer NEW_AT');
      return { status: 200, body: '{"metadata":{"name":"X"}}' };
    }
    return { status: 500 };
  });
  const storage = memoryStorage();
  seedTokens(storage, -1000); // 已过期
  const client = makeClient(fetchFn, storage);

  const text = await client.getModelText('79103');
  assert.equal(text, '{"metadata":{"name":"X"}}');
  // 新令牌已持久化
  assert.ok(storage.getItem('t3k_tokens')!.includes('"NEW_RT"'));
  assert.equal(requests.length, 3);
});

test('getModelText: 401 强制轮转并重放一次', async () => {
  let modelCalls = 0;
  const { fetchFn } = mockFetch((req) => {
    if (req.url.endsWith('/oauth/token')) {
      return { status: 200, body: { access_token: 'FRESH_AT', refresh_token: 'FRESH_RT', expires_in: 3600 } };
    }
    if (req.url.includes('/api/v1/models?tone_id=')) {
      modelCalls += 1;
      if (modelCalls === 1) return { status: 401 };
      assert.equal(req.init?.headers?.Authorization, 'Bearer FRESH_AT');
      return {
        status: 200,
        body: { data: [{ id: 1, model_url: 'https://cdn.example.com/m.nam', size: 'lite', architecture_version: 'custom' }] },
      };
    }
    return { status: 200, body: '{}' };
  });
  const storage = memoryStorage();
  seedTokens(storage, 3600_000); // 未过期
  const client = makeClient(fetchFn, storage);
  await client.getModelText('79103');
  assert.equal(modelCalls, 2);
});

test('getModelText: refresh 失败 → 登出态,抛 not-authenticated', async () => {
  const { fetchFn } = mockFetch(() => ({ status: 401 }));
  const storage = memoryStorage();
  seedTokens(storage, -1000);
  const client = makeClient(fetchFn, storage);
  await assert.rejects(client.getModelText('79103'), (err: unknown) => {
    assert.equal((err as { reason?: string }).reason, 'not-authenticated');
    return true;
  });
  assert.equal(client.isAuthenticated(), false);
  assert.equal(storage.getItem('t3k_tokens'), null);
});

test('getModelText: 未登录直接抛 not-authenticated,不发请求', async () => {
  const { fetchFn, requests } = mockFetch(() => ({ status: 200, body: {} }));
  const client = makeClient(fetchFn);
  await assert.rejects(client.getModelText('79103'), (err: unknown) => {
    assert.equal((err as { reason?: string }).reason, 'not-authenticated');
    return true;
  });
  assert.equal(requests.length, 0);
});

// ---------- 模型选取与失效语义 ----------

test('getModelText: 优先 standard 尺寸的 A1 模型,跳过 A2', async () => {
  const { fetchFn } = mockFetch((req) => {
    if (req.url.includes('/api/v1/models?tone_id=')) {
      return {
        status: 200,
        body: {
          data: [
            { id: 1, model_url: 'https://cdn.example.com/a2.nam', size: 'standard', architecture_version: '2' },
            { id: 2, model_url: 'https://cdn.example.com/lite.nam', size: 'lite', architecture_version: '1' },
            { id: 3, model_url: 'https://cdn.example.com/std.nam', size: 'standard', architecture_version: '1' },
          ],
        },
      };
    }
    assert.equal(req.url, 'https://cdn.example.com/std.nam');
    return { status: 200, body: '{}' };
  });
  const storage = memoryStorage();
  seedTokens(storage, 3600_000);
  const client = makeClient(fetchFn, storage);
  await client.getModelText('79103');
});

test('getModelText: 只有 A2 模型 → tone-unavailable', async () => {
  const { fetchFn } = mockFetch((req) => {
    if (req.url.includes('/api/v1/models?tone_id=')) {
      return {
        status: 200,
        body: { data: [{ id: 1, model_url: 'https://cdn.example.com/a2.nam', size: 'standard', architecture_version: '2' }] },
      };
    }
    return { status: 200, body: '{}' };
  });
  const storage = memoryStorage();
  seedTokens(storage, 3600_000);
  const client = makeClient(fetchFn, storage);
  await assert.rejects(client.getModelText('79103'), (err: unknown) => {
    assert.equal((err as { reason?: string }).reason, 'tone-unavailable');
    return true;
  });
});

test('getModelText: tone 404/403 → tone-unavailable(失效/转私有)', async () => {
  for (const status of [404, 403]) {
    const { fetchFn } = mockFetch(() => ({ status }));
    const storage = memoryStorage();
    seedTokens(storage, 3600_000);
    const client = makeClient(fetchFn, storage);
    await assert.rejects(client.getModelText('99999'), (err: unknown) => {
      assert.equal((err as { reason?: string }).reason, 'tone-unavailable');
      return true;
    });
  }
});

test('logout: 清除令牌,isAuthenticated 变 false', async () => {
  const { fetchFn } = mockFetch(() => ({ status: 200, body: {} }));
  const storage = memoryStorage();
  seedTokens(storage, 3600_000);
  const client = makeClient(fetchFn, storage);
  assert.equal(client.isAuthenticated(), true);
  client.logout();
  assert.equal(client.isAuthenticated(), false);
});

// ---------- getTone(归属展示元数据) ----------

test('getTone: 返回标题/作者/许可/链接', async () => {
  const { fetchFn, requests } = mockFetch((req) => {
    assert.equal(req.url, 'https://www.tone3000.com/api/v1/tones/79103');
    assert.equal(req.init?.headers?.Authorization, 'Bearer OLD_AT');
    return {
      status: 200,
      body: {
        id: 79103,
        title: 'Dual Rectifier Rev G',
        license: 't3k',
        url: 'https://www.tone3000.com/tones/mesa-boogie-dual-rectifier-79103',
        user: { username: 'someone', url: 'https://www.tone3000.com/users/someone' },
      },
    };
  });
  const storage = memoryStorage();
  seedTokens(storage, 3600_000);
  const client = makeClient(fetchFn, storage);
  const tone = await client.getTone('79103');
  assert.equal(tone.title, 'Dual Rectifier Rev G');
  assert.equal(tone.username, 'someone');
  assert.equal(tone.license, 't3k');
  assert.ok(tone.url.includes('79103'));
  assert.equal(requests.length, 1);
});

test('getTone: 404/403 → tone-unavailable', async () => {
  for (const status of [404, 403]) {
    const { fetchFn } = mockFetch(() => ({ status }));
    const storage = memoryStorage();
    seedTokens(storage, 3600_000);
    const client = makeClient(fetchFn, storage);
    await assert.rejects(client.getTone('99999'), (err: unknown) => {
      assert.equal((err as { reason?: string }).reason, 'tone-unavailable');
      return true;
    });
  }
});

// ---------- listTones(trending/latest 列表,issue #15) ----------

test('listTones: 解析分页响应为 ToneInfo 列表(含作者/许可/链接)', async () => {
  const { fetchFn, requests } = mockFetch((req) => {
    assert.equal(req.url, 'https://www.tone3000.com/api/v1/tones/trending');
    return {
      status: 200,
      body: {
        data: [
          {
            id: 1,
            title: 'Hot Amp',
            license: 'cc-by',
            url: 'https://www.tone3000.com/tones/hot-amp-1',
            user: { username: 'alice' },
          },
          {
            id: 2,
            title: 'Other Amp',
            license: 't3k',
            url: 'https://www.tone3000.com/tones/other-2',
            user: { username: 'bob' },
          },
        ],
        page: 1,
        total: 2,
      },
    };
  });
  const storage = memoryStorage();
  seedTokens(storage, 3600_000);
  const client = makeClient(fetchFn, storage);
  const tones = await client.listTones('trending');
  assert.equal(tones.length, 2);
  assert.deepEqual(tones[0], {
    id: 1,
    title: 'Hot Amp',
    username: 'alice',
    license: 'cc-by',
    url: 'https://www.tone3000.com/tones/hot-amp-1',
  });
  assert.equal(requests.length, 1);
});

test('listTones: latest 端点;未登录抛 not-authenticated', async () => {
  const { fetchFn, requests } = mockFetch((req) => {
    assert.equal(req.url, 'https://www.tone3000.com/api/v1/tones/latest');
    return { status: 200, body: { data: [] } };
  });
  const storage = memoryStorage();
  seedTokens(storage, 3600_000);
  const client = makeClient(fetchFn, storage);
  assert.deepEqual(await client.listTones('latest'), []);
  assert.equal(requests.length, 1);

  const anon = makeClient(fetchFn, memoryStorage());
  await assert.rejects(anon.listTones('trending'), (err: unknown) => {
    assert.equal((err as { reason?: string }).reason, 'not-authenticated');
    return true;
  });
});

// ---------- parseToneUrl(粘贴链接 → toneId,issue #15) ----------

test('parseToneUrl: 合法各形态解析出 toneId', async () => {
  const { parseToneUrl } = await import('../src/tone3000/client.ts');
  // 完整 slug 链接
  assert.equal(
    parseToneUrl('https://www.tone3000.com/tones/mesa-boogie-dual-rectifier-revision-g-6l6-community-pack-79103'),
    '79103',
  );
  // 无 slug
  assert.equal(parseToneUrl('https://www.tone3000.com/tones/79103'), '79103');
  // 无协议 / 尾斜杠 / 查询参数
  assert.equal(parseToneUrl('tone3000.com/tones/some-amp-42/?x=1'), '42');
  // 裸数字 id
  assert.equal(parseToneUrl('  79103 '), '79103');
});

test('parseToneUrl: 非法输入返回 null(不改变当前状态的前提)', async () => {
  const { parseToneUrl } = await import('../src/tone3000/client.ts');
  assert.equal(parseToneUrl(''), null);
  assert.equal(parseToneUrl('hello world'), null);
  assert.equal(parseToneUrl('https://example.com/tones/amp-123'), null); // 非 tone3000 域
  assert.equal(parseToneUrl('https://www.tone3000.com/tones/'), null);
  assert.equal(parseToneUrl('https://www.tone3000.com/users/alice'), null);
});
