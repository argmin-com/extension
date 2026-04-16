const { test, expect } = require('./fixtures/extension-fixture');

test('chatgpt page injects badge and persists settings updates', async ({ context, storage }) => {
	await storage.set({
		'tier:chatgpt': 'plus'
	});

	const page = await context.newPage();
	await page.route('https://chatgpt.com/**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><body><main>Mock ChatGPT</main></body></html>'
		});
	});

	await page.goto('https://chatgpt.com/');

	await expect.poll(async () => {
		return await page.evaluate(() => document.documentElement.dataset.aiTrackerNonce || '');
	}).not.toBe('');

	const badge = page.locator('#ut-platform-badge');
	await expect(badge).toBeVisible({ timeout: 15000 });
	await expect(badge.locator('.ut-platform-badge-title')).toHaveText('ChatGPT Usage');

	await page.click('#ut-platform-badge .ut-platform-badge-toggle');
	await expect(page.locator('.ut-badge-tier-select')).toHaveValue('plus');

	await page.selectOption('.ut-badge-tier-select', 'team');

	await expect.poll(async () => {
		const values = await storage.get('tier:chatgpt');
		return values['tier:chatgpt'];
	}).toBe('team');

	await page.fill('.ut-badge-limit-window', '48');
	await page.fill('.ut-badge-limit-value', '120');
	await page.click('.ut-badge-limit-save');

	await expect.poll(async () => {
		const values = await storage.get('userLimits:chatgpt');
		return JSON.stringify(values['userLimits:chatgpt']);
	}).toBe(JSON.stringify({
		custom: {
			windowHours: 48,
			type: 'messages',
			messageLimit: 120,
			tokenLimit: null
		}
	}));

	await page.close();
});
