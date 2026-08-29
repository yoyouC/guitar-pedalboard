import { expect, test } from '@playwright/test';

test('unified discovery exposes three tabs with canonical creator navigation', async ({ page }) => {
  await page.goto('/marketplace/search');

  await expect(page.getByRole('button', { name: '预设', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Demo Crunch' })).toBeVisible();
  await page.getByRole('button', { name: 'Demo Crunch' }).click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'http://127.0.0.1:4174/marketplace/presets/preset-demo-crunch',
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'A reproducible built-in crunch Rig.',
  );

  await page.goto('/marketplace/search');
  await page.getByRole('button', { name: '合集', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Demo Stage Tones' })).toBeVisible();
  await page.getByRole('button', { name: 'Demo Stage Tones' }).click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'http://127.0.0.1:4174/marketplace/collections/collection-demo-stage-tones',
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'A fixed-revision collection for local development.',
  );

  await page.goto('/marketplace/search');
  await page.getByRole('button', { name: '创作者', exact: true }).click();
  await page.getByRole('button', { name: 'Guitar Pedalboard', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/creators/id/member-system');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'http://127.0.0.1:4174/creators/id/member-system',
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Official Guitar Pedalboard demo tones.',
  );
});

test('legacy handle resolves to the id canonical page and Unlisted stays out of discovery', async ({ page }) => {
  await page.goto('/creators/guitar-pedalboard-old');
  await expect(page).toHaveURL('/creators/id/member-system');
  await expect(page.getByRole('heading', { name: 'Guitar Pedalboard', exact: true })).toBeVisible();

  await page.goto('/marketplace/presets/preset-demo-unlisted');
  await expect(page.getByRole('heading', { name: 'Secret Demo Tone' })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    'http://127.0.0.1:4174/marketplace/presets/preset-demo-unlisted',
  );

  await page.goto('/marketplace/search');
  await page.getByLabel('搜索预设标题、介绍、创作者或标签').fill('Secret Demo Tone');
  await page.getByRole('button', { name: '搜索公开内容' }).click();
  await expect(page.getByText('没有匹配的公开预设。')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Secret Demo Tone' })).toHaveCount(0);
});
