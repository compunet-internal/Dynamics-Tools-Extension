import { test, expect } from '@playwright/test';

test('runs in Edge and opens a page', async ({ page, browserName }) => {
  await page.goto('about:blank');

  await expect(page).toHaveURL('about:blank');
  expect(browserName).toBe('chromium');
});
