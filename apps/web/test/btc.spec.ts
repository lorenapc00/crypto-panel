import { test, expect } from '@playwright/test';

test('BTC charts render, synchronize zoom, export and retain range and scale after reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#btc');
  await expect(page.getByRole('heading', { name: 'Trend and cycle evidence' })).toBeVisible();
  await expect(page.locator('.uplot')).toHaveCount(5);
  await page.getByRole('button', { name: '90D', exact: true }).click();
  await expect(page.getByRole('button', { name: '90D', exact: true })).toHaveClass('active');
  const saved = page.waitForResponse(r => r.url().includes('/research/preferences/btc-chart') && r.request().method() === 'PUT');
  await page.getByLabel('Log price scale').uncheck(); await saved;
  await page.reload(); await expect(page.getByRole('button', { name: '90D', exact: true })).toHaveClass('active');
  await expect(page.getByLabel('Log price scale')).not.toBeChecked();
  const price = page.getByRole('region', { name: 'BTC price and long-term averages', exact: true });
  const beforeZoom = await price.getByLabel('Visible chart range').textContent();
  const box = await price.locator('.u-over').boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.2, box!.y + box!.height / 2);
  await page.mouse.down(); await page.mouse.move(box!.x + box!.width * 0.8, box!.y + box!.height / 2, { steps: 10 }); await page.mouse.up();
  await expect(price.locator('.u-select')).not.toBeVisible();
  await expect(price.getByLabel('Visible chart range')).not.toHaveText(beforeZoom!);
  await expect(page.getByRole('region', { name: 'Drawdown from observed ATH (%)', exact: true }).getByLabel('Visible chart range')).toHaveText((await price.getByLabel('Visible chart range').textContent())!);
  await price.getByRole('button', { name: 'Reset zoom' }).click();
  const pending = page.waitForEvent('download'); await price.getByRole('button', { name: 'Export PNG' }).click();
  expect((await pending).suggestedFilename()).toMatch(/\.png$/);
  await page.getByText('Formulas, sources and coverage', { exact: true }).click();
  await expect(page.getByText('CapMVRVCur', { exact: true })).toBeVisible();
  await page.screenshot({ path: '../../.reports/btc-cycles-stage2.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(price).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

test('signal studies show coverage counts, survive reload by saved ID and export frozen evidence', async ({ page }) => {
  await page.goto('/#btc'); await page.getByLabel('Signal', { exact: true }).selectOption('custom');
  await page.getByLabel('Event dates', { exact: true }).fill('2020-05-11, 2024-04-20');
  await page.getByRole('button', { name: 'Run study', exact: true }).click();
  await expect(page.getByText('Immutable inputs and results', { exact: false })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Samples / events' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Overlapping pairs' })).toBeVisible();
  const id = await page.getByLabel('Saved study ID').inputValue(); expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await page.reload(); await expect(page.getByText(`Saved study ${id}`, { exact: false })).toBeVisible();
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export study JSON' }).click();
  expect((await pending).suggestedFilename()).toBe(`btc-study-${id}.json`);
  await page.getByText('Individual event outcomes and limitations', { exact: true }).click();
  await expect(page.getByRole('cell', { name: '2020-05-11', exact: true })).toBeVisible();
});
