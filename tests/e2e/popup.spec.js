const { test, expect } = require('./fixtures/extension-fixture');

test('popup renders seeded usage and saves tier changes', async ({ extensionPage, storage }) => {
	await storage.set({
		'tier:chatgpt': 'plus'
	});

	const page = await extensionPage('popup.html');

	await expect(page.getByText('Today Overview')).toBeVisible();
	await expect(page.getByText('ChatGPT', { exact: true })).toBeVisible();
	await expect(page.locator('.overview-total')).toHaveText('$0.0000');
	await expect(page.locator('select[data-platform="chatgpt"]')).toHaveValue('plus');

	await page.selectOption('select[data-platform="chatgpt"]', 'team');

	await expect.poll(async () => {
		const values = await storage.get('tier:chatgpt');
		return values['tier:chatgpt'];
	}).toBe('team');

	await page.close();
});

test('popup history and tools tabs handle empty state and budget saves', async ({ extensionPage, storage }) => {
	const page = await extensionPage('popup.html');

	await page.getByRole('tab', { name: 'History' }).click();
	await expect(page.getByText('No history data yet.')).toBeVisible();

	await page.getByRole('tab', { name: 'Tools' }).click();
	await page.fill('#budgetCost', '12.5');
	await page.fill('#budgetCarbon', '40');
	await page.click('#saveBudgets');
	await expect(page.locator('#budgetStatus')).toHaveText('Budgets saved.');

	await expect.poll(async () => {
		const values = await storage.get('userBudgets');
		const budgets = values.userBudgets || {};
		return [budgets.dailyCostLimit, budgets.dailyCarbonLimit];
	}).toEqual([12.5, 40]);

	await page.close();
});

test('popup plan uses the same canonical usage cost as today', async ({ extensionPage, storage }) => {
	const dateKey = new Date().toISOString().slice(0, 10);
	await storage.set({
		plan: { key: 'chatgpt_plus' },
		platformUsage: [[`chatgpt:${dateKey}`, {
			requests: 2,
			inputTokens: 1000,
			outputTokens: 500,
			models: { 'gpt-4o': { requests: 2, inputTokens: 1000, outputTokens: 500 } },
			estimatedCostUSD: 0.1234,
			totalEnergyWh: 0,
			totalCarbonGco2e: 0,
			firstRequestAt: Date.now(),
			lastRequestAt: Date.now()
		}]]
	});

	const page = await extensionPage('popup.html');

	await expect(page.locator('.overview-total')).toHaveText('$0.1234');

	await page.getByRole('tab', { name: 'Plan' }).click();
	await expect(page.locator('#planContent .rollup-card').filter({ hasText: 'API equivalent' }).locator('.value')).toHaveText('$0.1234');

	await page.getByRole('tab', { name: 'History' }).click();
	await expect(page.getByText('2 reqs · $0.1234')).toBeVisible();
	await expect(page.locator('#historyContent .history-day:not(.header)').first().locator('.num').nth(3)).toHaveText('$0.1234');

	await page.close();
});
