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

test('popup insights renders local leaderboards and runs retention cleanup', async ({ extensionPage, storage }) => {
	const now = Date.now();
	const todayKey = new Date(now).toISOString().slice(0, 10);
	const oldDate = new Date(now - 12 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	await storage.set({
		platformUsage: [
			[`chatgpt:${todayKey}`, {
				requests: 3,
				inputTokens: 1200,
				outputTokens: 600,
				models: { 'gpt-4o': { requests: 3, inputTokens: 1200, outputTokens: 600 } },
				estimatedCostUSD: 0.2345,
				totalEnergyWh: 1,
				totalCarbonGco2e: 2,
				firstRequestAt: now,
				lastRequestAt: now,
				captureSources: { pageContext: 3, outputStream: 2 }
			}],
			[`claude:${oldDate}`, {
				requests: 1,
				inputTokens: 100,
				outputTokens: 0,
				models: { Sonnet: { requests: 1, inputTokens: 100, outputTokens: 0 } },
				estimatedCostUSD: 0.001,
				totalEnergyWh: 0,
				totalCarbonGco2e: 0,
				firstRequestAt: now - 12 * 24 * 60 * 60 * 1000,
				lastRequestAt: now - 12 * 24 * 60 * 60 * 1000,
				captureSources: { fallback: 1 }
			}]
		],
		sessionTurns: [
			['old-session:1', { ts: now - 12 * 24 * 60 * 60 * 1000, sessionId: 'old-session' }],
			['recent-session:1', { ts: now, sessionId: 'recent-session' }]
		],
		sessionMeta: [
			['old-session', { sessionId: 'old-session', lastSeenAt: now - 12 * 24 * 60 * 60 * 1000 }],
			['recent-session', { sessionId: 'recent-session', lastSeenAt: now }]
		]
	});

	const page = await extensionPage('popup.html');
	await page.getByRole('tab', { name: 'Insights' }).click();

	await expect(page.getByText('Daily Digest')).toBeVisible();
	await expect(page.getByText('Model Leaderboard')).toBeVisible();
	await expect(page.getByText('gpt-4o', { exact: true })).toBeVisible();
	await expect(page.locator('.insight-pill').filter({ hasText: 'pageContext' })).toBeVisible();

	await page.fill('#retentionDays', '7');
	await page.click('#saveRetention');
	await expect(page.locator('#retentionStatus')).toHaveText('Retention set to 7 days.');
	await page.click('#cleanupRetention');
	await expect(page.locator('#retentionStatus')).toContainText('Cleaned 1 platform days');

	await expect.poll(async () => {
		const values = await storage.get(['platformUsage', 'sessionTurns', 'sessionMeta']);
		return {
			platformDays: values.platformUsage.map(([key]) => key),
			turns: values.sessionTurns.map(([key]) => key),
			sessions: values.sessionMeta.map(([key]) => key)
		};
	}).toEqual({
		platformDays: [`chatgpt:${todayKey}`],
		turns: ['recent-session:1'],
		sessions: ['recent-session']
	});

	await page.close();
});
