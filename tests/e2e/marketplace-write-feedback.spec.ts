import { expect, test } from '@playwright/test';

test('email verification keeps a publication draft in place', async ({ page }) => {
  const now = '2026-08-29T10:00:00.000Z';
  await page.route('**/api/marketplace/me', async (route) => route.fulfill({
    json: { member: {
      id: 'member-ada', handle: 'ada', displayName: 'Ada', bio: '', avatarUrl: null,
      handleChangedAt: null, nextHandleChangeAt: null, createdAt: now, updatedAt: now,
    } },
  }));
  await page.route('**/api/marketplace/tags', async (route) => route.fulfill({
    json: { tags: [{
      id: 'tone-clean', dimension: 'tone', nameZh: '清音', nameEn: 'Clean',
    }] },
  }));
  await page.route('**/api/marketplace/presets', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return route.fulfill({
      status: 403,
      json: { error: {
        code: 'email_verification_required',
        message: 'Verify your email before this community write',
        verificationUrl: '/login?verify=email&return=%2Fmarketplace%2Fpublish',
      } },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '发布当前 Rig' }).click();
  const dialog = page.getByRole('dialog', { name: '发布预览' });
  await dialog.getByLabel('标题').fill('My clean draft');
  await dialog.getByLabel('介绍').fill('Keep these words while verifying.');
  await dialog.getByLabel('清音 / Clean').check();
  await dialog.getByRole('button', { name: '确认发布' }).click();
  await expect(dialog.getByRole('button', { name: '验证邮箱' })).toBeVisible();

  await dialog.getByRole('button', { name: '验证邮箱' }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('标题')).toHaveValue('My clean draft');
  await expect(dialog.getByLabel('介绍')).toHaveValue('Keep these words while verifying.');
  await expect(dialog.getByLabel('清音 / Clean')).toBeChecked();
  await expect(page.getByRole('heading', { name: '验证邮箱' })).toBeVisible();
});

test('account recovery opens its returned email verification entry', async ({ page }) => {
  const now = '2026-08-29T10:00:00.000Z';
  await page.route('**/api/marketplace/me', async (route) => route.fulfill({
    json: { member: {
      id: 'member-ada', handle: 'ada', displayName: 'Ada', bio: '', avatarUrl: null,
      handleChangedAt: null, nextHandleChangeAt: null, createdAt: now, updatedAt: now,
    } },
  }));
  await page.route('**/api/marketplace/me/deletion', async (route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({
        status: 403,
        json: { error: {
          code: 'email_verification_required',
          message: 'Verify your email before recovering this account',
          verificationUrl: '/login?verify=email&return=%2Fmarketplace%2Faccount',
        } },
      });
    }
    return route.fulfill({ json: { deletion: {
      status: 'pending', requestedAt: now, purgeAfter: '2026-09-28T10:00:00.000Z',
    } } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '登录 / 创作者' }).click();
  await page.getByRole('button', { name: '取消注销并恢复账户' }).click();

  await expect(page.getByRole('heading', { name: '验证邮箱' })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送邮箱验证链接' })).toBeVisible();
  await expect(page.getByLabel('邮箱')).toHaveCount(0);
});
