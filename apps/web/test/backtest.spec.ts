import { test, expect } from '@playwright/test';

test('Backtest Lab runs the BTC regime strategy and shows a reproducible, coverage-labelled result', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#backtest');
  await expect(page.getByRole('heading', { name: 'Would these signals have helped, evaluated at the time?' })).toBeVisible();

  const strategy = page.getByRole('region', { name: 'Strategy test' });
  await expect(strategy.getByText('Only the BTC regime filter is available', { exact: false })).toBeVisible();
  await strategy.getByRole('button', { name: 'Run backtest' }).click();

  await expect(strategy.getByText('btc-regime-strategy:v1', { exact: false })).toBeVisible({ timeout: 20000 });
  await expect(strategy.locator('.uplot')).toHaveCount(1);
  await expect(strategy.getByRole('row', { name: /Max drawdown -/ })).toBeVisible();
  await expect(strategy.getByRole('cell', { name: '25 bps' })).toBeVisible();

  await strategy.getByText('Dataset, reproducibility and limitations').click();
  await expect(strategy.getByText('reproduces this result byte for byte', { exact: false })).toBeVisible();
  await expect(strategy.getByText('No Treasury-bill or money-market yield is credited.', { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Historical replay refuses a cutoff before the archive clock started', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#backtest');
  await page.getByRole('button', { name: 'Historical replay' }).click();

  const replay = page.getByRole('region', { name: 'Historical replay' });
  await expect(replay.getByText('works only for dates after this system began archiving', { exact: false })).toBeVisible();
  await replay.getByLabel('Replay date (UTC)').fill('2019-01-01');
  await replay.getByRole('button', { name: 'Inspect' }).click();

  await expect(replay.getByRole('alert')).toContainText('predates production coverage');
  expect(errors).toEqual([]);
});
