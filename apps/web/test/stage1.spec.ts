import { test,expect } from '@playwright/test';

test('watchlist, saved filters, chart preferences and dated notes survive page reloads',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/#watchlist');await page.getByRole('button',{name:'Add',exact:true}).first().click();
  await expect(page.locator('section').first()).toContainText('BTC');
  await page.reload();await expect(page.locator('section').first()).toContainText('BTC');
  await page.goto('/#assets');await page.getByPlaceholder('Search assets').fill('Bitcoin');
  await page.getByLabel('New screen name').fill('Bitcoin screen');await page.getByRole('button',{name:'Save screen',exact:true}).click();
  await expect(page.getByLabel('Saved screen')).toContainText('Bitcoin screen');
  await page.waitForTimeout(800);await page.reload();await expect(page.getByPlaceholder('Search assets')).toHaveValue('Bitcoin');
  await page.goto('/#asset/bitcoin');
  const saved=page.waitForResponse(response=>response.url().includes('/research/preferences/price-chart')&&response.request().method()==='PUT');
  await page.getByRole('button',{name:'1Y',exact:true}).click();await saved;
  await page.reload();await expect(page.getByRole('button',{name:'1Y',exact:true})).toHaveClass('active');
  await page.getByRole('button',{name:'notes',exact:true}).click();
  await page.getByLabel('New note').fill('Evidence and invalidation conditions');await page.getByRole('button',{name:'Save note',exact:true}).click();
  await expect(page.locator('.note')).toContainText('Evidence and invalidation conditions');
  await page.reload();await page.getByRole('button',{name:'notes',exact:true}).click();await expect(page.locator('.note')).toContainText('revision 1');
  await page.getByRole('button',{name:'Edit',exact:true}).click();await page.getByLabel('Edit note').fill('Updated evidence');await page.getByRole('button',{name:'Save revision',exact:true}).click();
  await expect(page.locator('.note')).toContainText('revision 2');
  expect(errors).toEqual([]);
});

test('Data Health explains coverage, quota usage, missing heartbeat and backup status',async({page})=>{
  await page.goto('/#data-health');await expect(page.getByRole('heading',{name:'Individual series',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Provider quotas and errors'})).toBeVisible();
  await expect(page.getByText('No recent heartbeat', {exact:true})).toBeVisible();
  await expect(page.getByText('Not recorded',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Historical acquisition gaps'})).toBeVisible();
  await page.screenshot({path:'../../.reports/data-health-stage1.png',fullPage:true});
});

test('condition rules persist and can be paused without inventing alert events',async({page})=>{
  await page.goto('/#research');await page.getByLabel('Condition name').fill('BTC thesis threshold');
  await page.getByLabel('Threshold',{exact:true}).fill('200');await page.getByRole('button',{name:'Create condition'}).click();
  await expect(page.getByText('BTC thesis threshold',{exact:true})).toBeVisible();await page.reload();
  await expect(page.getByText('awaiting baseline',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Pause',exact:true}).click();
  await expect(page.getByRole('button',{name:'Enable',exact:true})).toBeVisible();await expect(page.getByText('No condition crossings recorded yet.')).toBeVisible();
});
