const { test, expect } = require('./fixtures/extension-fixture');

test('chatgpt page injects badge and persists settings updates', async ({ extensionContext, storage }) => {
	await storage.set({
		'tier:chatgpt': 'plus'
	});

	const page = await extensionContext.newPage();
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
		const custom = values['userLimits:chatgpt']?.custom;
		return [custom?.windowHours, custom?.type, custom?.messageLimit, custom?.tokenLimit];
	}).toEqual([48, 'messages', 120, null]);

	await page.close();
});

test('chatgpt browser fetch records usage through page-context capture', async ({ extensionContext, storage }) => {
	const page = await extensionContext.newPage();
	await page.route('https://chatgpt.com/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'POST' && url.pathname === '/backend-api/f/conversation') {
			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: 'data: {"o":"append","p":"/message/content/parts/0","v":"Hello from model"}\n\ndata: [DONE]\n\n'
			});
			return;
		}
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

	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);

	await page.evaluate(() => {
		window.__testInferenceEvents = [];
		window.addEventListener('platformInferenceRequest', (event) => {
			window.__testInferenceEvents.push(event.detail);
		});
	});

	await page.evaluate(async () => {
		await fetch('/backend-api/f/conversation', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				action: 'next',
				model: 'gpt-4o',
				messages: [{
					author: { role: 'user' },
					content: { content_type: 'text', parts: ['Explain the harness status'] }
				}]
			})
		});
	});

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.length || 0);
	}).toBe(1);

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.[0]?.__nonce === document.documentElement.dataset.aiTrackerNonce);
	}).toBe(true);

	// StoredMap wraps values as { value, expires } when a lifetime is set
	// (see bg-components/utils.js). Production reads always go through
	// platformUsageStore.get(), which unwraps. Tests that peek at raw storage
	// have to unwrap themselves.
	const readChatgptUsage = async () => {
		const values = await storage.get('platformUsage');
		const entries = values.platformUsage || [];
		const chatgptEntry = entries.find(([key]) => key.startsWith('chatgpt:'));
		return chatgptEntry?.[1]?.value ?? chatgptEntry?.[1];
	};

	await expect.poll(async () => (await readChatgptUsage())?.requests || 0).toBe(1);
	await expect.poll(async () => (await readChatgptUsage())?.inputTokens || 0).toBeGreaterThan(0);

	// handleGenericBeforeRequest also writes to sessionTracker's StoredMaps via
	// a 100ms debounce. Let them drain before fixture teardown clears storage,
	// otherwise a late write can leak into the next test.
	await page.waitForTimeout(250);

	await page.close();
});
