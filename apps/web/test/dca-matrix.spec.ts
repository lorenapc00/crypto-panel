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

test('DCA Matrix shows both threshold-sensitivity sweeps, the robustness check and the adaptive comparison', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#dca-matrix');

  const mayerSens = page.getByRole('region', { name: 'Mayer exit sensitivity' });
  await expect(mayerSens.getByRole('heading', { name: 'Is 2.4 special? Mayer exit-threshold sensitivity' })).toBeVisible();
  await expect(mayerSens.getByText(/MVRV ≤ 1.0.*entry, IRR peaks at/)).toBeVisible({ timeout: 15000 });

  const mvrvSens = page.getByRole('region', { name: 'MVRV entry sensitivity' });
  await expect(mvrvSens.getByRole('heading', { name: 'Is 1.0 special? MVRV entry-threshold sensitivity' })).toBeVisible();
  await expect(mvrvSens.getByText(/Mayer ≥ 2.4.*exit, IRR peaks at/)).toBeVisible();

  const robustness = page.getByRole('region', { name: 'Robustness check' });
  await expect(robustness.getByRole('heading', { name: /Robustness check/ })).toBeVisible();
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
