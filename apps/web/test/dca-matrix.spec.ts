import { test, expect } from '@playwright/test';

test('the DCA Matrix tab is reachable from the nav and renders a full entry x exit grid', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('link', { name: 'DCA Matrix' }).click();
  await expect(page).toHaveURL(/#dca-matrix$/);

  const matrix = page.getByRole('region', { name: 'DCA Matrix' });
  await expect(matrix.getByRole('heading', { name: 'BTC DCA Matrix' })).toBeVisible();
  await expect(matrix.getByRole('row', { name: /No guard \(pure monthly DCA\)/ })).toBeVisible();
  await expect(matrix.getByRole('columnheader', { name: 'Never sell (hold)' })).toBeVisible();
  await expect(matrix.getByRole('columnheader', { name: 'MVRV >= 3.0' })).toBeVisible();
  await expect(matrix.getByRole('row', { name: /Fear & Greed <= 25/ })).toBeVisible();

  expect(errors).toEqual([]);
});

test('clicking a DCA Matrix cell shows the full backtest breakdown for that entry x exit pair', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#dca-matrix');

  const matrix = page.getByRole('region', { name: 'DCA Matrix' });
  const row = matrix.getByRole('row', { name: /No guard \(pure monthly DCA\)/ });
  const cell = row.getByRole('button').first();
  await expect(cell).toBeVisible();
  await cell.click();

  const detail = page.getByRole('region', { name: 'Cell detail' });
  await expect(detail.getByRole('heading', { name: /No guard \(pure monthly DCA\) →/ })).toBeVisible();
  await expect(detail.getByText('Strategy IRR')).toBeVisible();
  await expect(detail.getByText('DCA-hold benchmark IRR')).toBeVisible();
  await expect(detail.getByText(/Out-of-sample IRR/)).toBeVisible();

  expect(errors).toEqual([]);
});

test('clicking the MVRV<=1.0/Mayer>=2.4 cell stress-tests it: both sensitivity sweeps, robustness and adaptive comparison', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#dca-matrix');

  const matrix = page.getByRole('region', { name: 'DCA Matrix' });
  const row = matrix.getByRole('row', { name: /MVRV <= 1.0/ });
  await row.getByRole('button').nth(4).click(); // exit column: Mayer >= 2.4

  const mvrvSens = page.getByRole('region', { name: 'MVRV entry sensitivity' });
  await expect(mvrvSens.getByRole('heading', { name: 'MVRV entry sensitivity' })).toBeVisible({ timeout: 15000 });
  await expect(mvrvSens.getByText(/IRR peaks at/)).toBeVisible();

  const mayerSens = page.getByRole('region', { name: 'Mayer exit sensitivity' });
  await expect(mayerSens.getByRole('heading', { name: 'Mayer exit sensitivity' })).toBeVisible();

  const robustness = page.getByRole('region', { name: 'Robustness check' });
  await expect(robustness.getByRole('heading', { name: /Robustness check: is MVRV <= 1\.0 → Mayer >= 2\.4/ })).toBeVisible();
  await expect(robustness.getByText('Pre-2020 halving', { exact: true })).toBeVisible();
  await expect(robustness.getByText('2020 halving cycle', { exact: true })).toBeVisible();
  await expect(robustness.getByText('2024 halving cycle (current, incomplete)', { exact: true })).toBeVisible();
  // The browser-server fixture's synthetic MVRV rarely dips to <=1.0, so the winning
  // combo's ledger may legitimately be empty here -- assert the table structure exists,
  // not that a trade happened to fire against this particular synthetic series.
  await expect(robustness.getByRole('columnheader', { name: 'BTC price' })).toBeVisible();

  const adaptive = page.getByRole('region', { name: 'Adaptive comparison' });
  await expect(adaptive.getByRole('heading', { name: 'Does making the thresholds cycle-relative actually help?' })).toBeVisible();
  await expect(adaptive.getByRole('columnheader', { name: /Adaptive \(own trailing-\d+d/ })).toBeVisible();
  await expect(adaptive.getByRole('row', { name: /Full window/ })).toBeVisible();

  expect(errors).toEqual([]);
});

test('clicking a non-Mayer/MVRV cell shows its own sensitivity sweeps but no adaptive section', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#dca-matrix');

  const matrix = page.getByRole('region', { name: 'DCA Matrix' });
  const row = matrix.getByRole('row', { name: /Drawdown from ATH >= 20%/ });
  await row.getByRole('button').nth(6).click(); // exit column: Weekly RSI >= 70

  const ddSens = page.getByRole('region', { name: 'Drawdown from ATH entry sensitivity' });
  await expect(ddSens.getByRole('heading', { name: 'Drawdown from ATH entry sensitivity' })).toBeVisible({ timeout: 15000 });
  const rsiSens = page.getByRole('region', { name: 'Weekly RSI exit sensitivity' });
  await expect(rsiSens.getByRole('heading', { name: 'Weekly RSI exit sensitivity' })).toBeVisible();

  await expect(page.getByRole('region', { name: 'Robustness check' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Adaptive comparison' })).toHaveCount(0);

  expect(errors).toEqual([]);
});
