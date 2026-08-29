import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryAdapter } from 'better-auth/adapters/memory';
import {
  createAuthenticationApi,
  createSessionBoundAuthenticationHandler,
} from '../server/auth/api.ts';
import { createPlatformAuth, createPlatformAuthOptions } from '../server/auth/betterAuth.ts';
import {
  createResendEmailVerificationSender,
  createResendMagicLinkSender,
} from '../server/auth/resend.ts';
import { createBetterAuthSessionVerifier } from '../server/auth/betterAuthSession.ts';
import { createMemberApi } from '../server/members/api.ts';
import { createMemoryMemberRepository } from '../server/members/memoryRepository.ts';

const baseURL = 'https://pedalboard.test';
const secret = 'test-only-secret-at-least-thirty-two-characters';

function testDatabase() {
  return memoryAdapter({
    marketplace_auth_users: [],
    marketplace_auth_sessions: [],
    marketplace_auth_accounts: [],
    marketplace_auth_verifications: [],
  });
}

function cookies(response: Response): string {
  return response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
}

test('authentication API rejects an untrusted request origin before auth handles it', async () => {
  const handled: string[] = [];
  const api = createAuthenticationApi(new URL(baseURL), {
    async handler(request) {
      handled.push(request.url);
      return Response.json({ ok: true });
    },
  });

  const hostile = await api.fetch(new Request(
    'https://attacker.example/api/auth/get-session?path=get-session',
  ));
  assert.equal(hostile.status, 403);
  assert.deepEqual(handled, []);

  const trusted = await api.fetch(new Request(
    `${baseURL}/api/auth/get-session?path=get-session&returnTo=%2Fsettings`,
  ));
  assert.equal(trusted.status, 200);
  assert.deepEqual(handled, [`${baseURL}/api/auth/get-session?returnTo=%2Fsettings`]);
});

test('magic link signs in without exposing a password endpoint', async () => {
  const deliveries: Array<{ email: string; url: string }> = [];
  const auth = createPlatformAuth({
    baseURL,
    secret,
    database: testDatabase(),
    sendMagicLink: async ({ email, url }) => { deliveries.push({ email, url }); },
    sendEmailVerification: async () => {},
  });

  const request = await auth.handler(new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify({ email: 'ada@example.test', name: 'Ada', callbackURL: '/' }),
  }));

  assert.equal(request.status, 200);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].email, 'ada@example.test');
  assert.match(deliveries[0].url, /\/api\/auth\/magic-link\/verify\?token=/);

  const verification = await auth.handler(new Request(deliveries[0].url, {
    headers: { origin: baseURL },
    redirect: 'manual',
  }));
  assert.equal(verification.status, 302);
  const cookie = verification.headers.get('set-cookie');
  assert.ok(cookie);
  const session = await auth.handler(new Request(`${baseURL}/api/auth/get-session`, {
    headers: { cookie },
  }));
  assert.equal(session.status, 200);
  assert.equal((await session.json()).user.email, 'ada@example.test');

  const password = await auth.handler(new Request(`${baseURL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify({ email: 'ada@example.test', password: 'not-stored' }),
  }));
  assert.equal(password.status, 400);
  assert.equal((await password.json()).code, 'EMAIL_PASSWORD_DISABLED');
});

test('email verification is bound to the current session identity', async () => {
  const database = {
    marketplace_auth_users: [] as Array<Record<string, unknown>>,
    marketplace_auth_sessions: [] as Array<Record<string, unknown>>,
    marketplace_auth_accounts: [] as Array<Record<string, unknown>>,
    marketplace_auth_verifications: [] as Array<Record<string, unknown>>,
  };
  const deliveries: Array<{ email: string; url: string }> = [];
  const auth = createPlatformAuth({
    baseURL,
    secret,
    database: memoryAdapter(database),
    sendMagicLink: async ({ email, url }) => { deliveries.push({ email, url }); },
    sendEmailVerification: async ({ user, url }) => {
      deliveries.push({ email: user.email, url });
    },
  });
  const sessionBoundAuth = createSessionBoundAuthenticationHandler(auth);

  await auth.handler(new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify({ email: 'ada@example.test', callbackURL: '/' }),
  }));
  const signIn = await auth.handler(new Request(deliveries[0].url, {
    headers: { origin: baseURL },
    redirect: 'manual',
  }));
  const cookie = cookies(signIn);
  database.marketplace_auth_users[0].emailVerified = false;

  const anonymous = await sessionBoundAuth.handler(new Request(
    `${baseURL}/api/auth/send-verification-email`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ callbackURL: '/marketplace' }),
    },
  ));
  assert.equal(anonymous.status, 401);
  assert.equal(deliveries.length, 1);

  const mismatch = await sessionBoundAuth.handler(new Request(`${baseURL}/api/auth/send-verification-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: baseURL },
    body: JSON.stringify({ email: 'grace@example.test', callbackURL: '/marketplace' }),
  }));
  assert.equal(mismatch.status, 200);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[1].email, 'ada@example.test');

  const request = await sessionBoundAuth.handler(new Request(`${baseURL}/api/auth/send-verification-email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: baseURL },
    body: JSON.stringify({ callbackURL: '/marketplace' }),
  }));
  assert.equal(request.status, 200);
  assert.equal(deliveries.length, 3);
  assert.equal(deliveries[2].email, 'ada@example.test');
  assert.match(deliveries[2].url, /\/api\/auth\/verify-email\?token=/);

  const verification = await auth.handler(new Request(deliveries[2].url, {
    headers: { cookie, origin: baseURL },
    redirect: 'manual',
  }));
  assert.equal(verification.status, 302);
  assert.equal(database.marketplace_auth_users[0].emailVerified, true);
});

test('account linking policy requires an authenticated explicit Google link', async () => {
  const options = createPlatformAuthOptions({
    baseURL,
    secret,
    database: testDatabase(),
    sendMagicLink: async () => {},
    sendEmailVerification: async () => {},
    google: { clientId: 'google-client', clientSecret: 'google-secret' },
  });

  assert.equal(options.account?.accountLinking?.disableImplicitLinking, true);
  assert.deepEqual(Object.keys(options.socialProviders ?? {}), ['google']);
  assert.equal(options.account?.encryptOAuthTokens, true);

  const auth = createPlatformAuth({
    baseURL,
    secret,
    database: testDatabase(),
    sendMagicLink: async () => {},
    sendEmailVerification: async () => {},
    google: { clientId: 'google-client', clientSecret: 'google-secret' },
  });
  const response = await auth.handler(new Request(`${baseURL}/api/auth/link-social`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify({ provider: 'google', callbackURL: '/' }),
  }));
  assert.equal(response.status, 401);
});

test('same-email Google sign-in is rejected, then explicit verified linking preserves member id', async () => {
  const database = {
    marketplace_auth_users: [] as Array<Record<string, unknown>>,
    marketplace_auth_sessions: [] as Array<Record<string, unknown>>,
    marketplace_auth_accounts: [] as Array<Record<string, unknown>>,
    marketplace_auth_verifications: [] as Array<Record<string, unknown>>,
  };
  const deliveries: string[] = [];
  const auth = createPlatformAuth({
    baseURL,
    secret,
    database: memoryAdapter(database),
    sendMagicLink: async ({ url }) => { deliveries.push(url); },
    sendEmailVerification: async () => {},
    google: {
      clientId: 'google-client',
      clientSecret: 'google-secret',
      getUserInfo: async () => ({
        user: {
          name: 'Ada Google',
          email: 'ada@example.test',
          image: 'https://images.example.test/google-ada.png',
          emailVerified: true,
        },
        data: {
          sub: 'google-ada-subject',
          aud: 'google-client',
          azp: 'google-client',
          email: 'ada@example.test',
          email_verified: true,
          exp: Math.floor(Date.now() / 1000) + 3600,
          family_name: 'Lovelace',
          given_name: 'Ada',
          iat: Math.floor(Date.now() / 1000),
          iss: 'https://accounts.google.com',
          locale: 'en',
          name: 'Ada Google',
          picture: 'https://images.example.test/google-ada.png',
        },
      }),
    },
  });

  await auth.handler(new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseURL },
    body: JSON.stringify({ email: 'ada@example.test', name: 'Ada' }),
  }));
  const magicVerification = await auth.handler(new Request(deliveries[0], {
    headers: { origin: baseURL },
  }));
  const sessionCookie = cookies(magicVerification);

  const members = createMemoryMemberRepository();
  const memberApi = createMemberApi({
    members,
    sessions: createBetterAuthSessionVerifier(auth.api),
    now: () => new Date('2026-08-29T00:00:00.000Z'),
    createId: () => 'member-ada',
    createHandleSuffix: () => '4f82a1',
  });
  const before = await memberApi.fetch(new Request(`${baseURL}/api/marketplace/me`, {
    headers: { cookie: sessionCookie },
  }));
  const memberId = (await before.json()).member.id;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return Response.json({
        access_token: 'google-access-token',
        refresh_token: 'google-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }
    return originalFetch(input, init);
  };

  try {
    const implicitStart = await auth.handler(new Request(`${baseURL}/api/auth/sign-in/social`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ provider: 'google', callbackURL: '/', disableRedirect: true }),
    }));
    const implicitUrl = new URL((await implicitStart.json()).url);
    const implicitCallback = await auth.handler(new Request(
      `${baseURL}/api/auth/callback/google?code=implicit-code&state=${encodeURIComponent(implicitUrl.searchParams.get('state') ?? '')}`,
      { headers: { cookie: cookies(implicitStart), origin: baseURL } },
    ));
    assert.equal(implicitCallback.status, 302);
    assert.match(implicitCallback.headers.get('location') ?? '', /account_not_linked/i);
    assert.equal(
      database.marketplace_auth_accounts.some((account) => account.providerId === 'google'),
      false,
    );

    const explicitStart = await auth.handler(new Request(`${baseURL}/api/auth/link-social`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseURL,
        cookie: sessionCookie,
      },
      body: JSON.stringify({ provider: 'google', callbackURL: '/', disableRedirect: true }),
    }));
    assert.equal(explicitStart.status, 200);
    const explicitUrl = new URL((await explicitStart.json()).url);
    const explicitCallback = await auth.handler(new Request(
      `${baseURL}/api/auth/callback/google?code=explicit-code&state=${encodeURIComponent(explicitUrl.searchParams.get('state') ?? '')}`,
      {
        headers: {
          cookie: `${sessionCookie}; ${cookies(explicitStart)}`,
          origin: baseURL,
        },
      },
    ));
    assert.equal(explicitCallback.status, 302);
    assert.equal(
      database.marketplace_auth_accounts.filter((account) => account.providerId === 'google').length,
      1,
    );

    const after = await memberApi.fetch(new Request(`${baseURL}/api/marketplace/me`, {
      headers: { cookie: sessionCookie },
    }));
    assert.equal((await after.json()).member.id, memberId);
    assert.equal(await members.count(), 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Resend sender delivers only the magic link through its narrow adapter', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const sender = createResendMagicLinkSender({
    apiKey: 'resend-test-key',
    from: 'Guitar Pedalboard <login@example.test>',
    fetch: async (input, init) => {
      calls.push({ input: String(input), init });
      return Response.json({ id: 'email-1' }, { status: 200 });
    },
  });

  await sender({
    email: 'ada@example.test',
    url: 'https://pedalboard.test/api/auth/magic-link/verify?token=secret-token',
    token: 'secret-token',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, 'https://api.resend.com/emails');
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer resend-test-key');
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.to[0], 'ada@example.test');
  assert.match(body.text, /magic-link\/verify\?token=secret-token/);
  assert.equal(JSON.stringify(body).includes('resend-test-key'), false);
});

test('Resend verification sender describes verification rather than sign-in', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const sender = createResendEmailVerificationSender({
    apiKey: 'resend-test-key',
    from: 'Guitar Pedalboard <login@example.test>',
    fetch: async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'email-verify' }, { status: 200 });
    },
  });

  await sender({
    user: {
      id: 'auth-ada',
      email: 'ada@example.test',
      emailVerified: false,
      name: 'Ada',
      image: null,
      createdAt: new Date('2026-08-29T00:00:00.000Z'),
      updatedAt: new Date('2026-08-29T00:00:00.000Z'),
    },
    url: 'https://pedalboard.test/api/auth/verify-email?token=verification-token',
    token: 'verification-token',
  });

  assert.match(String(bodies[0].subject), /Verify your email/i);
  assert.match(String(bodies[0].text), /verify your email/i);
  assert.doesNotMatch(String(bodies[0].text), /sign in/i);
});

test('Resend failure is surfaced so auth does not claim an undelivered link', async () => {
  const sender = createResendMagicLinkSender({
    apiKey: 'resend-test-key',
    from: 'login@example.test',
    fetch: async () => Response.json({ message: 'rejected' }, { status: 422 }),
  });

  await assert.rejects(
    sender({ email: 'ada@example.test', url: 'https://example.test/link', token: 'token' }),
    /Magic link delivery failed/,
  );
});

test('verified sessions become independent identities with a non-empty automatic display name', async () => {
  const verifier = createBetterAuthSessionVerifier({
    async getSession() {
      return {
        user: {
          id: 'auth-user',
          email: 'player@example.test',
          emailVerified: true,
          name: '',
          image: null,
        },
      };
    },
  });

  assert.deepEqual(await verifier.verify(new Request('https://pedalboard.test')), {
    authUserId: 'auth-user',
    email: 'player@example.test',
    emailVerified: true,
    displayName: 'Guitar Player',
    avatarUrl: null,
  });
});
