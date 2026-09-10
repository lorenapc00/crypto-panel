import { test, expect } from '@playwright/test';

test('Emerging Projects separates an unknown screen from a failed one and keeps Attention out of prime space', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#altcoin');
  await expect(page.getByRole('heading', { name: 'Which altcoins deserve investigation, and what evidence supports them?' })).toBeVisible();

  const universe = page.getByRole('region', { name: 'Eligible universe' });
  await expect(universe.getByText('rank-selected 100 assets', { exact: false }).first()).toBeVisible();
  await universe.getByText('Ranked by Attention evidence', { exact: false }).click();
  await expect(universe.getByText('unvalidated v0 placeholder', { exact: false }).first()).toBeVisible();

  // BTC is in the tracked page but its fixture market cap sits far below the band: a real fail.
  // ETH has no archived daily history at all: unknown, never a fail, never ranked.
  await page.getByRole('region', { name: 'Emerging Projects' }).getByLabel('Screen').selectOption('all');
  const table = page.getByRole('region', { name: 'Emerging Projects' });
  await expect(table.getByRole('row', { name: /Bitcoin/ })).toContainText('marketCap:fail');
  await expect(table.getByRole('row', { name: /Ethereum/ })).toContainText('history:unknown');
  await expect(table.getByRole('row', { name: /Ethereum/ })).toContainText('unranked');

  const evidence = page.getByRole('region', { name: 'Evidence for Ethereum' });
  await evidence.getByText('why it appeared, contradictions', { exact: false }).click();
  await expect(evidence.getByText('No daily price history is archived', { exact: false })).toBeVisible();
  await expect(evidence.getByText('Event-level tokenomics stays gated', { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Spot Launches deduplicate by token, keep unknown liquidity unknown and label promotion as promotion', async ({ page }) => {
  await page.goto('/#altcoin');
  await page.getByRole('tab', { name: 'Spot Launches' }).click();

  const coverage = page.getByRole('region', { name: 'Sampled launch coverage' });
  await expect(coverage.getByText('sampled radar', { exact: false })).toBeVisible();
  await expect(coverage.getByText('never counted as zero or as passing')).toBeVisible();

  const launches = page.getByRole('region', { name: 'New spot launches' });
  // DEEPWORK has two sampled pools ($180K + $40K) — one token, above the $100K default.
  await expect(launches.getByRole('row', { name: /DEEPWORK/ })).toContainText('$220,000');
  await expect(launches.getByRole('row', { name: /DEEPWORK/ })).toHaveCount(1);
  await expect(launches.getByRole('row', { name: /THINCOIN/ })).toHaveCount(0, { timeout: 5000 });

  await launches.getByLabel('Screen').selectOption('all');
  await expect(launches.getByRole('row', { name: /THINCOIN/ })).toContainText('unknown');
  await expect(launches.getByRole('row', { name: /BASEGEM/ })).toContainText('Unavailable');

  const deepwork = page.getByRole('region', { name: /Evidence for DEEPWORK/ });
  await deepwork.getByText('attention, risk status, liquidity and lifecycle', { exact: false }).click();
  await expect(deepwork.getByText('2 pools', { exact: false }).first()).toBeVisible();
  await expect(deepwork.getByText('no verified contract check exists', { exact: false })).toBeVisible();
  await expect(deepwork.getByText('a pool creation time, not a token launch', { exact: false })).toBeVisible();

  await page.screenshot({ path: '../../.reports/altcoin-launches-stage5.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#altcoin');
  await expect(page.getByRole('heading', { name: 'Which altcoins deserve investigation, and what evidence supports them?' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
