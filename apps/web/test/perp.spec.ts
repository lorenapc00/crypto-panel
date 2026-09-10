import { test, expect } from '@playwright/test';

test('perp DEX projects show covered open interest, keep volume gated and expose evidence', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#perp');
  await expect(page.getByRole('heading', { name: 'Which perp venues and markets deserve research?' })).toBeVisible();

  const covered = page.getByRole('region', { name: 'Covered perp open interest' });
  await expect(covered.getByText('$13.9B', { exact: true })).toBeVisible();
  await covered.getByText('Reported perp volume evidence').click();
  await expect(covered.getByText('HTTP 402', { exact: false }).first()).toBeVisible();
  await covered.getByText('Verified launch milestones evidence').click();
  await expect(covered.getByText('verified protocol or token launch dates', { exact: false }).first()).toBeVisible();

  const projects = page.getByRole('region', { name: 'Perp DEX projects' });
  await expect(projects.getByRole('row', { name: /Hyperliquid Perps/ })).toContainText('100.00%');
  await expect(projects.getByRole('row', { name: /Hyperliquid Perps/ })).toContainText('hyperliquid native');
  await expect(projects.getByRole('row', { name: /Emerging Perps/ })).toContainText('live token');
  await expect(projects.getByRole('row', { name: /A Lender/ })).toHaveCount(0);
  await expect(projects.getByText('Derivatives` category', { exact: false })).toBeVisible();

  const evidence = page.getByRole('region', { name: 'Evidence for Hyperliquid Perps' });
  await evidence.getByText('why watch, contradictions, risks and milestones', { exact: false }).click();
  await expect(evidence.getByText('Launch dates are unverified', { exact: false })).toBeVisible();
  await expect(evidence.getByText('counts both sides of each contract', { exact: false }).first()).toBeVisible();
  await expect(evidence.getByText('No verified tradable token', { exact: false }).first()).toBeVisible();
  await expect(page.locator('.uplot')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('new perp listings separate the archive baseline from a real listing event', async ({ page }) => {
  await page.goto('/#perp');
  await page.getByRole('tab', { name: 'New Perp Listings' }).click();

  const lifecycle = page.getByRole('region', { name: 'Listing lifecycle' });
  await expect(lifecycle.getByText('existed before archiving began')).toBeVisible();
  await expect(lifecycle.getByText('first observed after the baseline')).toBeVisible();
  await expect(lifecycle.getByText('never raise listing alerts', { exact: false })).toBeVisible();

  const listings = page.getByRole('region', { name: 'New perp listings' });
  await expect(listings.getByRole('row', { name: /NEWPERP/ })).toContainText('venue new to archive');
  await expect(listings.getByRole('row', { name: /^BTC/ })).toHaveCount(0, { timeout: 5000 });
  await expect(listings.getByText('1 baseline', { exact: false })).toBeVisible();

  const evidence = page.getByRole('region', { name: 'Evidence for NEWPERP' });
  await evidence.getByText('market, liquidity, funding and underlying evidence', { exact: false }).click();
  await expect(evidence.getByText('underlying units', { exact: true })).toBeVisible();
  await expect(evidence.getByText('24H Unavailable', { exact: false })).toBeVisible();
  await expect(evidence.getByText('impact prices only', { exact: false }).first()).toBeVisible();
  await expect(evidence.getByText('class unknown', { exact: false })).toBeVisible();

  await listings.getByLabel('Screen').selectOption('all');
  await expect(listings.getByRole('row', { name: /^BTC/ })).toBeVisible();
  const btc = page.getByRole('region', { name: 'Evidence for BTC' });
  await btc.getByText('market, liquidity, funding and underlying evidence', { exact: false }).click();
  await expect(btc.getByText('archived order book', { exact: false }).first()).toBeVisible();
  await expect(btc.getByText('Spot versus BTC', { exact: false })).toBeVisible();

  const venues = page.getByRole('region', { name: 'Venue namespace coverage' });
  await expect(venues.getByRole('row', { name: /mkts/ })).toContainText('Uncovered');
  await page.screenshot({ path: '../../.reports/perp-listings-stage4.png', fullPage: true });
});

test('lifecycle alerts read from immutable events and acknowledge without changing evidence', async ({ page }) => {
  await page.goto('/#perp');
  await page.getByRole('tab', { name: 'Lifecycle alerts' }).click();
  const alerts = page.getByRole('region', { name: 'Perp lifecycle alerts' });
  await expect(alerts.getByRole('listitem')).toHaveCount(1);
  await expect(alerts.getByRole('listitem').first()).toContainText('NEWPERP first observed');
  await expect(alerts.getByRole('listitem').first()).toContainText('unread');
  await alerts.getByRole('button', { name: 'Mark as read' }).click();
  await expect(alerts.getByRole('listitem').first()).toContainText('read ');
  await expect(alerts.getByRole('listitem').first()).toContainText('NEWPERP first observed');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#perp');
  await expect(page.getByRole('heading', { name: 'Which perp venues and markets deserve research?' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
