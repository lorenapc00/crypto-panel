import { test, expect } from '@playwright/test';

test('the Macro tab renders Brazil, US Macro (gated) and Calendar sections', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#macro');

  const brazil = page.getByRole('region', { name: 'Brazil' });
  await expect(brazil.getByRole('heading', { name: 'Brazil' })).toBeVisible();
  await expect(brazil.getByText('Latest CDI (daily)')).toBeVisible();
  await expect(brazil.getByText('Latest CDI (annualized)')).toBeVisible();
  await expect(page.getByRole('region', { name: 'CDI daily rate' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'CDI annualized' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'USD/BRL PTAX (sell)' })).toBeVisible();

  // The browser fixture never sets FRED_API_KEY, so US Macro and the FRED-backed
  // calendar sources must show the honest gated state, not a broken panel.
  const usMacro = page.getByRole('region', { name: 'US Macro' });
  await expect(usMacro.getByRole('heading', { name: 'US Macro' })).toBeVisible();
  await expect(usMacro.getByText('Real 10Y yield (DFII10): unavailable.')).toBeVisible();
  await expect(usMacro.getByText('Broad USD index (DTWEXBGS): unavailable.')).toBeVisible();
  await expect(usMacro.getByText(/S&P 500 .* unavailable\./)).toBeVisible();
  await expect(usMacro.getByText('NASDAQ Composite: unavailable.')).toBeVisible();

  const calendar = page.getByRole('region', { name: 'Macro Calendar' });
  await expect(calendar.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await expect(calendar.getByText('FOMC meetings')).toBeVisible();
  await expect(calendar.getByText('(SEP)').first()).toBeVisible();
  await expect(calendar.getByRole('link', { name: 'source' }).first()).toBeVisible();
  await expect(calendar.getByText('Gated: FRED key not configured.').first()).toBeVisible();
  await expect(calendar.getByText('Copom meetings')).toBeVisible();
  await expect(calendar.getByText('Not yet sourced.')).toBeVisible();

  expect(errors).toEqual([]);
});

test('the Macro tab is reachable from the nav and shows no refused blocks by default', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'Macro' }).click();
  await expect(page).toHaveURL(/#macro$/);
  await expect(page.getByRole('heading', { name: 'CDI, USD/BRL and US macro context' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Refused blocks' })).toHaveCount(0);
});
