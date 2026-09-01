import { expect, test } from '@playwright/test';

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

test('email verification keeps a publication draft across the dedicated verification page', async ({ page }) => {
  await page.route('**/api/marketplace/me', (route) => route.fulfill({ json: { member } }));
  await page.route('**/api/marketplace/tags', (route) => route.fulfill({
    json: { tags: [{
      id: 'tone-clean', dimension: 'tone', nameZh: '清音', nameEn: 'Clean',
    }] },
  }));
  await page.route('**/api/marketplace/presets', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({
      status: 403,
      json: { error: {
        code: 'email_verification_required',
        message: 'Verify your email before this community write',
        verificationUrl: '/login?verify=email&return=%2Fpublish',
      } },
    });
  });
  await page.route('**/api/auth/send-verification-email', (route) => route.fulfill({ status: 204 }));

  await page.goto('/');
  await page.getByRole('button', { name: '发布当前 Rig' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Title').fill('My clean draft');
  await page.getByLabel('Plain-text description').fill('Keep these words while verifying.');
  await page.getByLabel('Clean').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Public · discoverable').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('I confirm the current preview, source attribution, visibility, and community terms').check();
  await page.getByRole('button', { name: 'New Tone' }).click();
  await page.getByRole('button', { name: 'Verify email' }).click();

  await expect(page.getByRole('heading', { name: '验证邮箱' })).toBeVisible();
  await expect(page.getByLabel('邮箱')).toHaveCount(0);
  await page.getByRole('button', { name: '发送邮箱验证链接' }).click();
  await expect(page.getByRole('status')).toContainText('验证链接已发送');
  await page.getByRole('button', { name: '返回原操作' }).click();

  await expect(page).toHaveURL(/\/publish/);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Title')).toHaveValue('My clean draft');
  await expect(page.getByLabel('Plain-text description')).toHaveValue('Keep these words while verifying.');
  await expect(page.getByLabel('Clean')).toBeChecked();
});

test('account recovery opens its returned email verification entry', async ({ page }) => {
  const now = '2026-08-29T10:00:00.000Z';
  await page.route('**/api/marketplace/me', (route) => route.fulfill({ json: { member } }));
  await page.route('**/api/marketplace/me/deletion', (route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({
        status: 403,
        json: { error: {
          code: 'email_verification_required',
          message: 'Verify your email before recovering this account',
          verificationUrl: '/login?verify=email&return=%2Fsettings%3Fsection%3Daccount',
        } },
      });
    }
    return route.fulfill({ json: { deletion: {
      status: 'pending', requestedAt: now, purgeAfter: '2026-09-28T10:00:00.000Z',
    } } });
  });

  await page.goto('/settings?section=account');
  await page.getByRole('button', { name: '恢复账户' }).click();

  await expect(page.getByRole('heading', { name: '验证邮箱' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送邮箱验证链接' })).toBeVisible();
  await expect(page.getByLabel('邮箱')).toHaveCount(0);
});
