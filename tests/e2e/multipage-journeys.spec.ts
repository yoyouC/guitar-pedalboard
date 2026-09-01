import { expect, test, type Page } from '@playwright/test';

const member = {
  id: 'member-ada',
  handle: 'ada-tones',
  displayName: 'Ada',
  bio: 'Clean rigs.',
  avatarUrl: null,
  handleChangedAt: null,
  nextHandleChangeAt: null,
  termsAcceptedVersion: '2026-08-29',
  readyForPublicAttribution: true,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:00.000Z',
};

async function mockAuthenticatedWorkspace(page: Page, current = member) {
  await page.route('**/api/marketplace/me', (route) => route.fulfill({ json: { member: current } }));
  await page.route('**/api/marketplace/me/tones', (route) => route.fulfill({ json: { tones: [] } }));
  await page.route('**/api/marketplace/me/collections', (route) => route.fulfill({ json: { collections: [] } }));
  await page.route('**/api/marketplace/me/likes', (route) => route.fulfill({
    json: { likes: { presets: [], collections: [] } },
  }));
}

async function startTestAudio(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '🎵 测试音源' }).click();
  await expect(page.getByRole('button', { name: '■ 停止' })).toBeVisible({ timeout: 15_000 });
}

async function applyDemoTone(page: Page) {
  await page.getByRole('link', { name: '音色市场' }).click();
  await page.getByRole('button', { name: 'Demo Crunch' }).click();
  await page.getByRole('button', { name: 'Use in Pedalboard' }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(page.getByLabel('Tone Market session')).toContainText('Demo Crunch');
}

test('persistent shell keeps active audio through Market and Login history until explicit Stop', async ({ page }) => {
  await startTestAudio(page);
  const rigHash = new URL(page.url()).hash;

  await page.getByRole('link', { name: '音色市场' }).click();
  await expect(page.getByRole('status', { name: 'Audio input is active' })).toContainText('Test tone');
  await expect.poll(() => new URL(page.url()).hash).toBe(rigHash);

  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/login\?return=/);
  await expect(page.getByRole('status', { name: 'Audio input is active' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/marketplace/);
  await expect(page.getByRole('status', { name: 'Audio input is active' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/login\?return=/);

  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Audio input is active' })).toHaveCount(0);
  await page.getByRole('link', { name: '效果器' }).click();
  await expect(page.getByRole('button', { name: '🎵 测试音源' })).toBeVisible();
  await expect(page.getByRole('button', { name: '■ 停止' })).toHaveCount(0);
});

test('anonymous Tone apply is reversible, marks edits, and never creates a Local Preset', async ({ page }) => {
  await startTestAudio(page);
  const originalHash = new URL(page.url()).hash;
  await applyDemoTone(page);

  const session = page.getByLabel('Tone Market session');
  await expect(session).toContainText('fixed revision revision-demo-crunch-1');
  await expect(page.getByRole('option', { name: '选择预设…' })).toHaveCount(1);

  await page.getByRole('button', { name: '1x12 Open' }).click();
  await expect(session).toContainText('Modified');
  await session.getByRole('button', { name: 'Back to My Rig' }).click();
  await expect(page.getByLabel('Tone Market session')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).hash).toBe(originalHash);
  await expect(page.getByRole('option', { name: '选择预设…' })).toHaveCount(1);
});

test('Collection starts an explicit browser-session queue and exits without cloud state', async ({ page }) => {
  await startTestAudio(page);
  await page.getByRole('link', { name: '音色市场' }).click();
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await page.getByRole('button', { name: 'Demo Stage Tones' }).click();
  await expect(page.getByRole('radio', { name: 'Start from position 1' })).toBeChecked();
  await page.getByRole('button', { name: 'Use Collection in Pedalboard' }).click();

  const session = page.getByLabel('Tone Market session');
  await expect(session).toContainText('Demo Stage Tones · position 1 / 1');
  await session.getByRole('button', { name: 'View Queue' }).click();
  await expect(session).toContainText('revision revision-demo-crunch-1');
  await session.getByRole('button', { name: 'Exit Session' }).click();
  await expect(page.getByLabel('Tone Market session')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('marketplace.collectionQueue.v1'))).toBeNull();
});

test('authenticated Login return opens private Library without mixing in Local Presets', async ({ page }) => {
  await mockAuthenticatedWorkspace(page);
  await page.goto('/login?return=%2Flibrary');
  await expect(page).toHaveURL(/\/library/);
  await expect(page.getByRole('heading', { name: 'My Library' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'My Likes' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'My Tones' }).click();
  await expect(page.getByText('Local Preset', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: '@ada-tones' }).click();
  await page.getByRole('button', { name: '设置' }).click();
  await expect(page).toHaveURL(/\/settings\?section=account/);
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
});

test('publication UI infers New Tone, Remix, and New Revision from the current Rig provenance', async ({ page }) => {
  let currentMember = member;
  await page.route('**/api/marketplace/me', (route) => route.fulfill({ json: { member: currentMember } }));

  await page.goto('/');
  await page.getByRole('button', { name: '从空白 Rig 开始' }).click();
  await page.getByRole('button', { name: '发布当前 Rig' }).click();
  await expect(page.getByRole('heading', { name: 'New Tone' })).toBeVisible();

  await page.goto('/');
  await page.getByRole('button', { name: '🎵 测试音源' }).click();
  await applyDemoTone(page);
  await page.getByRole('button', { name: '发布当前 Rig' }).click();
  await expect(page.getByRole('heading', { name: 'Publish Remix' })).toBeVisible();

  currentMember = { ...member, id: 'member-system', handle: 'guitar-pedalboard' };
  await page.goto('/');
  await page.getByRole('button', { name: '🎵 测试音源' }).click();
  await applyDemoTone(page);
  await page.getByRole('button', { name: '发布当前 Rig' }).click();
  await expect(page.getByRole('heading', { name: 'Publish New Revision' })).toBeVisible();
});

test('Report preserves details across throttle and verification failures; formal notice stays public', async ({ page }) => {
  await mockAuthenticatedWorkspace(page);
  let reports = 0;
  await page.route('**/api/marketplace/reports', (route) => {
    reports += 1;
    if (reports === 1) {
      return route.fulfill({ status: 429, json: { error: {
        code: 'write_rate_limited', message: 'slow down', retryAt: '2026-08-29T14:01:00.000Z',
      } } });
    }
    return route.fulfill({ status: 403, json: { error: {
      code: 'email_verification_required', message: 'verify',
      verificationUrl: '/login?verify=email&return=%2Fmarketplace',
    } } });
  });

  await page.goto('/marketplace/tones/preset-demo-crunch');
  await page.getByRole('button', { name: 'Report this tone' }).click();
  const details = page.getByLabel('Details');
  await details.fill('The public attribution appears misleading.');
  await page.getByRole('button', { name: 'Submit report' }).click();
  await expect(page.getByText('Retry available after', { exact: false })).toBeVisible();
  await expect(details).toHaveValue('The public attribution appears misleading.');
  await page.getByRole('button', { name: 'Submit report' }).click();
  await expect(page.getByRole('button', { name: 'Verify email' })).toBeVisible();
  await expect(details).toHaveValue('The public attribution appears misleading.');

  await page.route('**/api/marketplace/infringement-notices', (route) => route.fulfill({ status: 201 }));
  await page.getByRole('button', { name: '正式侵权通知（无需登录）' }).click();
  await expect(page).toHaveURL(/\/marketplace\/infringement-notice/);
  await expect(page.getByText('This entry requires no sign-in')).toBeVisible();
  await page.getByLabel('Name').fill('Rights Holder');
  await page.getByLabel('Contact email').fill('rights@example.test');
  await page.getByLabel('Target ID').fill('preset-demo-crunch');
  await page.getByLabel('Rights statement').fill('I own the identified work and request a formal review.');
  await page.getByLabel('I confirm these statements are made in good faith and are accurate.').check();
  await page.getByRole('button', { name: 'Submit formal notice' }).click();
  await expect(page.getByRole('status')).toContainText('Formal infringement notice submitted.');
});

test('Account Settings exports data, logs out on deletion, and requires an explicit restore decision', async ({ page }) => {
  let signedIn = true;
  let deletion: null | { status: 'pending'; requestedAt: string; purgeAfter: string } = null;
  await page.route('**/api/marketplace/me', (route) => signedIn
    ? route.fulfill({ json: { member } })
    : route.fulfill({ status: 401, json: { error: { code: 'authentication_required', message: 'login' } } }));
  await page.route('**/api/marketplace/me/export', (route) => route.fulfill({
    headers: { 'content-disposition': 'attachment; filename="account-export.json"' },
    json: {
      formatVersion: 1, exportedAt: '2026-08-29T12:00:00.000Z',
      account: { email: 'ada@example.test' },
      member: {
        id: member.id, handle: member.handle, displayName: member.displayName,
        bio: member.bio, avatarUrl: null, createdAt: member.createdAt, updatedAt: member.updatedAt,
      },
      presets: [], collections: [], relationships: {
        presetLikes: [], collectionLikes: [], moderationReports: [], moderationAppeals: [],
      },
    },
  }));
  await page.route('**/api/marketplace/me/deletion', (route) => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: { deletion } });
    if (method === 'POST') {
      deletion = {
        status: 'pending', requestedAt: '2026-08-29T12:00:00.000Z',
        purgeAfter: '2026-09-28T12:00:00.000Z',
      };
      signedIn = false;
      return route.fulfill({ status: 202, json: { deletion } });
    }
    deletion = null;
    return route.fulfill({ json: { recovered: true } });
  });

  await page.goto('/settings?section=account');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出我的数据（JSON）' }).click();
  await expect((await download).suggestedFilename()).toBe('account-export.json');

  await page.getByText('注销账户', { exact: true }).click();
  await page.getByLabel('我理解此操作覆盖账户、预设、合集和社区关系。').check();
  await page.getByLabel(/输入 Handle/).fill('ada-tones');
  await page.getByRole('button', { name: '确认注销账户' }).click();
  await expect(page).toHaveURL(/\/login\?return=/);

  signedIn = true;
  await page.goto('/settings?section=account');
  await expect(page.getByText('账户正在等待最终删除')).toBeVisible();
  await expect(page.getByText('我们不会静默恢复', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '恢复账户' }).click();
  await expect(page.getByRole('status')).toContainText('账户已恢复');
  await expect(page.getByText('账户正在等待最终删除')).toHaveCount(0);
});

test('offline discovery is announced as failure while local Rig and reduced-motion Settings remain usable', async ({ page }) => {
  await startTestAudio(page);
  await applyDemoTone(page);
  await page.getByPlaceholder('新预设名称').fill('Offline Rig');
  await page.getByRole('button', { name: '保存整套 Rig' }).click();
  await expect(page.getByRole('option', { name: 'Offline Rig' })).toHaveCount(1);
  await expect(page.locator('select').filter({
    has: page.getByRole('option', { name: 'Offline Rig' }),
  })).toHaveValue('Offline Rig');
  await page.getByRole('button', { name: 'A:空槽,踩下存入当前状态' }).click();
  await expect(page.getByRole('button', { name: /A:踩下恢复/ })).toBeVisible();

  await page.getByRole('button', { name: '🔗 分享' }).click();
  await expect(page.getByRole('button', { name: '✓ 已复制' })).toBeVisible();
  expect(new URL(page.url()).hash.length).toBeGreaterThan(1);

  await page.route('**/api/marketplace/**', (route) => route.fulfill({
    status: 503,
    json: { error: { code: 'marketplace_unavailable', message: 'Tone Market is offline.' } },
  }));
  await page.getByRole('link', { name: '音色市场' }).click();
  await expect(page.getByRole('alert')).toContainText('Tone Market search failed');
  await expect(page.getByText('No matching tones')).toHaveCount(0);
  await expect(page.getByRole('status', { name: 'Audio input is active' })).toContainText('Test tone');

  await page.getByRole('button', { name: 'Back to pedalboard' }).click();
  await expect(page.getByLabel('Tone Market session')).toContainText('Demo Crunch');
  await expect(page.getByRole('button', { name: '■ 停止' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Offline Rig' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /A:踩下恢复/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '🔗 分享' })).toBeEnabled();

  await page.goto('/settings?section=appearance');
  await page.getByLabel('减少动态效果').check();
  await expect(page.locator('html')).toHaveClass(/reduced-motion/);
  await page.keyboard.press('Tab');
  const visualLoad = page.getByLabel('降低视觉负载（同时关闭表头与调音器）');
  await expect(visualLoad).toBeFocused();
  await page.keyboard.press('Space');
  await expect(visualLoad).toBeChecked();
});
