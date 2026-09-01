import { expect, test } from '@playwright/test';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}

test.use({ viewport: { width: 390, height: 844 } });

test('unsupported narrow browser keeps Tone shareable without claiming Rig transfer', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'webkitAudioContext', { configurable: true, value: undefined });
    Object.defineProperty(window, 'AudioWorkletNode', { configurable: true, value: undefined });
  });
  await page.goto('/marketplace/tones/preset-demo-crunch');

  await expect(page.getByText('Fully compatible', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use in Pedalboard' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Copy Tone Link' })).toBeVisible();
  await expect(page.getByAltText('Tone link QR code')).toBeVisible();
  await expect(page.getByText('The link opens the same public revision only — it does not transfer your local Rig or audio state across devices.')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('Market, Like, Collection, and account surfaces remain usable at phone width', async ({ page }) => {
  await page.goto('/marketplace/search');
  await expect(page.getByRole('button', { name: 'Presets', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collections', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Creators', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/marketplace/tones/preset-demo-crunch');
  await expect(page.getByRole('button', { name: /Like/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/marketplace/collections/collection-demo-stage-tones');
  await expect(page.getByRole('heading', { name: 'Demo Stage Tones' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use Collection in Pedalboard' })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.goto('/settings?section=account');
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  await expect(page.getByRole('button', { name: /登录以管理账户|Sign in to manage account/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
