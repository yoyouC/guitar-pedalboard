import { expect, test } from '@playwright/test';

function canonicalUrl(baseURL: string | undefined, pathname: string): string {
  if (!baseURL) {
    throw new Error('Playwright baseURL is required');
  }

  return new URL(pathname, baseURL).href;
}

test('unified discovery exposes three tabs with canonical creator navigation', async ({
  page,
  baseURL,
}) => {
  await page.goto('/marketplace/search');

  await expect(page.getByRole('button', { name: 'Presets', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Demo Crunch' })).toBeVisible();
  await page.getByRole('button', { name: 'Demo Crunch' }).click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    canonicalUrl(baseURL, '/marketplace/tones/preset-demo-crunch'),
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'A reproducible built-in crunch Rig.',
  );

  await page.goto('/marketplace/search');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Demo Stage Tones' })).toBeVisible();
  await page.getByRole('button', { name: 'Demo Stage Tones' }).click();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    canonicalUrl(baseURL, '/marketplace/collections/collection-demo-stage-tones'),
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'A fixed-revision collection for local development.',
  );

  await page.goto('/marketplace/search');
  await page.getByRole('button', { name: 'Creators', exact: true }).click();
  await page.getByRole('button', { name: 'Guitar Pedalboard', exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe('/creators/id/member-system');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    canonicalUrl(baseURL, '/creators/id/member-system'),
  );
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    'Official Guitar Pedalboard demo tones.',
  );
});

test('legacy handle resolves to the id canonical page and Unlisted stays out of discovery', async ({
  page,
  baseURL,
}) => {
  await page.goto('/creators/guitar-pedalboard-old');
  await expect(page).toHaveURL('/creators/id/member-system');
  await expect(page.getByRole('heading', { name: 'Guitar Pedalboard', exact: true })).toBeVisible();

  await page.goto('/marketplace/tones/preset-demo-unlisted');
  await expect(page.getByRole('heading', { name: 'Secret Demo Tone' })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    canonicalUrl(baseURL, '/marketplace/tones/preset-demo-unlisted'),
  );

  await page.goto('/marketplace/search');
  await page.getByLabel('Search tones, creators, or tags').fill('Secret Demo Tone');
  await page.getByRole('button', { name: 'Search Tones' }).click();
  await expect(page.getByText('No matching tones')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Secret Demo Tone' })).toHaveCount(0);
});
