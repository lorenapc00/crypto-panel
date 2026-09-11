import { test, expect } from '@playwright/test';

test('Backtest Lab runs the BTC regime strategy and shows a reproducible, coverage-labelled result', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#backtest');
  await expect(page.getByRole('heading', { name: 'Would these signals have helped, evaluated at the time?' })).toBeVisible();

  const strategy = page.getByRole('region', { name: 'Strategy test' });
  await expect(strategy.getByText('Two engines run over the full Coin Metrics BTC price history', { exact: false })).toBeVisible();
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

test('Custom strategy: a monthly-DCA-with-ATH-exit preset runs and reports a money-weighted return, ledger and benchmarks', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#backtest');
  const strategy = page.getByRole('region', { name: 'Strategy test' });
  await strategy.getByLabel('Template').selectOption({ label: 'Custom strategy (portfolio engine)' });
  await strategy.getByLabel('Preset').selectOption('dca-ath');
  await expect(strategy.getByRole('group', { name: 'Exit trigger (sell when this becomes true)' }).getByLabel('Exit trigger (sell when this becomes true) type')).toHaveValue('new-ath');
  await strategy.getByRole('button', { name: 'Run backtest' }).click();

  await expect(strategy.getByText('portfolio-strategy:v1', { exact: false })).toBeVisible({ timeout: 20000 });
  await expect(strategy.locator('.btc-kpis').getByText('Money-weighted return (IRR)')).toBeVisible();
  await expect(strategy.locator('.btc-kpis').getByText('Total contributed')).toBeVisible();
  await expect(strategy.getByRole('row', { name: /Lump sum \(hindsight\)/ })).toBeVisible();
  await strategy.getByRole('button', { name: /Show trade ledger/ }).click();
  await expect(strategy.getByRole('cell', { name: 'buy' }).first()).toBeVisible();
  expect(errors).toEqual([]);
});
