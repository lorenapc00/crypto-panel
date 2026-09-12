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
