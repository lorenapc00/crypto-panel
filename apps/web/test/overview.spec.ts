import { test, expect } from '@playwright/test';

test('market overview composes scoped aggregates, breadth coverage and evidence', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#overview');
  await expect(page.getByRole('heading', { name: 'What environment are we in?' })).toBeVisible();

  const conditions = page.getByRole('region', { name: 'Market conditions summary' });
  await expect(conditions.getByText('$1,000', { exact: true })).toBeVisible();
  await expect(conditions.getByText('60.0%', { exact: true })).toBeVisible();
  await conditions.getByText('Provider global market cap evidence').click();
  await expect(conditions.getByText('CoinGecko provider-global coverage; USD').first()).toBeVisible();

  const breadth = page.getByRole('region', { name: 'Market breadth' });
  await expect(breadth.getByText('CoinGecko rank-selected first page, up to 100 assets; not a global universe')).toBeVisible();
  await expect(breadth.getByText('1 of 1 covered')).toBeVisible();
  await expect(breadth.getByText('0 of 0 covered')).toBeVisible();
  await expect(breadth.getByRole('row', { name: /BTC Bitcoin/ })).toContainText('Above / Uncovered');

  const performance = page.getByRole('region', { name: 'Relative performance' });
  await expect(performance.getByRole('row', { name: /BTC Bitcoin/ })).toContainText('+0.00%');
  await expect(performance.getByText('1 tracked asset has no archived daily history and is absent here: ethereum.')).toBeVisible();

  const sectors = page.getByRole('region', { name: 'Sector leadership' });
  await expect(sectors.getByText('Status: gated')).toBeVisible();
  await expect(sectors.getByText('2 of 2 tracked assets carry a curated classification; 0 remain unclassified.', { exact: false })).toBeVisible();

  await expect(page.locator('.uplot')).toHaveCount(3);
  const changes = page.getByRole('region', { name: 'Notable signal changes' });
  await expect(changes.getByRole('listitem').first()).toContainText('BTC regime confirmed');
  await expect(changes.getByText('first observed on the tracked page')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('overview keeps unavailable comparisons unavailable and links into deeper research', async ({ page }) => {
  await page.goto('/#overview');
  const conditions = page.getByRole('region', { name: 'Market conditions summary' });
  await conditions.getByText('Provider global 24h volume evidence').click();
  await expect(conditions.getByText('24h change: Unavailable; 7D change: Unavailable.', { exact: false })).toBeVisible();

  const btc = page.getByRole('region', { name: 'BTC regime evidence' });
  await expect(btc.getByText('Completed close')).toBeVisible();
  await page.screenshot({ path: '../../.reports/market-overview-stage3.png', fullPage: true });
  await btc.getByRole('link', { name: 'Open BTC Cycles →' }).click();
  await expect(page.getByRole('heading', { name: 'Trend and cycle evidence' })).toBeVisible();

  await page.goto('/#overview');
  await page.getByRole('region', { name: 'Relative performance' }).getByRole('button', { name: 'BTC' }).click();
  await expect(page.getByRole('heading', { name: 'Bitcoin BTC' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#overview');
  await expect(page.getByRole('heading', { name: 'What environment are we in?' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
