const { test, expect } = require('./fixtures/extension-fixture');
const { makeUsageRecord, makeVelocityRecord } = require('./helpers/extension-state');

test('popup renders seeded usage and saves tier changes', async ({ extensionPage, storage }) => {
	await storage.set({
		platformUsage: [
			makeUsageRecord('chatgpt', 0, {
				requests: 3,
				inputTokens: 1200,
				outputTokens: 3400,
				models: {
					'gpt-4o': {
						requests: 3,
						inputTokens: 1200,
						outputTokens: 3400
					}
				},
				estimatedCostUSD: 0.005,
				totalEnergyWh: 1.25,
				totalCarbonGco2e: 0.49
			})
		],
		platformVelocity: [
			makeVelocityRecord('chatgpt', {
				tokensPerHour: 4600,
				requestsPerHour: 3,
				inputTokensPerHour: 1200,
				outputTokensPerHour: 3400,
				costPerHour: 0.005,
				samplePeriodMs: 3600000
			})
		],
		'tier:chatgpt': 'plus'
	});

	const page = await extensionPage('popup.html');

	await expect(page.getByText('Today Overview')).toBeVisible();
	await expect(page.getByText('ChatGPT')).toBeVisible();
	await expect(page.locator('.overview-total')).toHaveText('$0.0050');
	await expect(page.locator('select[data-platform="chatgpt"]')).toHaveValue('plus');

	await page.selectOption('select[data-platform="chatgpt"]', 'team');

	await expect.poll(async () => {
		const values = await storage.get('tier:chatgpt');
		return values['tier:chatgpt'];
	}).toBe('team');

	await page.close();
});

test('popup history tab renders stored daily history', async ({ extensionPage, storage }) => {
	await storage.set({
		platformUsage: [
			makeUsageRecord('chatgpt', 0, {
				requests: 2,
				inputTokens: 900,
				outputTokens: 1200,
				estimatedCostUSD: 0.0032
			}),
			makeUsageRecord('chatgpt', -1, {
				requests: 5,
				inputTokens: 2000,
				outputTokens: 4000,
				estimatedCostUSD: 0.0125
			})
		]
	});

	const page = await extensionPage('popup.html');

	await page.getByRole('tab', { name: 'History' }).click();

	await expect(page.getByText('Yesterday')).toBeVisible();
	await expect(page.getByText('5')).toBeVisible();
	await expect(page.getByText('$0.01')).toBeVisible();

	await page.close();
});
