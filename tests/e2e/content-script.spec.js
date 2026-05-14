const { test, expect } = require('./fixtures/extension-fixture');

async function readPlatformUsage(storage, platform) {
	const values = await storage.get('platformUsage');
	const entries = values.platformUsage || [];
	const platformEntry = entries.find(([key]) => key.startsWith(`${platform}:`));
	return platformEntry?.[1]?.value ?? platformEntry?.[1];
}

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
	// >= 1 rather than === 1 because some platforms make their own
	// page-hydration fetch before our explicit test fetch lands. The
	// storage-side requests assertion below is the real correctness
	// check (background-side dedupe collapses redundant events).
	}).toBeGreaterThanOrEqual(1);

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.[0]?.__nonce === document.documentElement.dataset.aiTrackerNonce);
	}).toBe(true);

	// StoredMap wraps values as { value, expires } when a lifetime is set
	// (see bg-components/utils.js). Production reads always go through
	// platformUsageStore.get(), which unwraps. Tests that peek at raw storage
	// have to unwrap themselves.
	await expect.poll(async () => (await readPlatformUsage(storage, 'chatgpt'))?.requests || 0, { timeout: 15000 }).toBe(1);
	await expect.poll(async () => (await readPlatformUsage(storage, 'chatgpt'))?.inputTokens || 0, { timeout: 15000 }).toBeGreaterThan(0);

	// handleGenericBeforeRequest also writes to sessionTracker's StoredMaps via
	// a 100ms debounce. Let them drain before fixture teardown clears storage,
	// otherwise a late write can leak into the next test.
	await page.waitForTimeout(250);

	await page.close();
});

test('claude browser fetch records usage through page-context capture', async ({ extensionContext, storage }) => {
	const page = await extensionContext.newPage();
	await page.route('https://claude.ai/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'POST' && url.pathname === '/api/organizations/org_123/chat_conversations/conv_123/completion') {
			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello from Claude"}}\n\ndata: [DONE]\n\n'
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><body><button data-testid="user-menu-button">Claude Pro</button><main>Mock Claude</main></body></html>'
		});
	});

	await page.goto('https://claude.ai/chat/conv_123');

	await expect.poll(async () => {
		return await page.evaluate(() => document.documentElement.dataset.aiTrackerNonce || '');
	}).not.toBe('');

	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);

	await expect.poll(async () => {
		const values = await storage.get('tier:claude');
		return values['tier:claude'];
	}).toBe('claude_pro');

	await page.evaluate(() => {
		window.__testInferenceEvents = [];
		window.addEventListener('platformInferenceRequest', (event) => {
			window.__testInferenceEvents.push(event.detail);
		});
	});

	await page.evaluate(async () => {
		await fetch('/api/organizations/org_123/chat_conversations/conv_123/completion', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-sonnet-4-20250514',
				prompt: 'Explain the platform status',
				timezone: 'America/Los_Angeles'
			})
		});
	});

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.length || 0);
	// >= 1 rather than === 1 because some platforms make their own
	// page-hydration fetch before our explicit test fetch lands. The
	// storage-side requests assertion below is the real correctness
	// check (background-side dedupe collapses redundant events).
	}).toBeGreaterThanOrEqual(1);

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.[0]?.__nonce === document.documentElement.dataset.aiTrackerNonce);
	}).toBe(true);

	await expect.poll(async () => (await readPlatformUsage(storage, 'claude'))?.requests || 0, { timeout: 15000 }).toBe(1);
	await expect.poll(async () => (await readPlatformUsage(storage, 'claude'))?.inputTokens || 0, { timeout: 15000 }).toBeGreaterThan(0);

	await page.waitForTimeout(250);
	await page.close();
});

test('perplexity browser fetch records usage through page-context capture', async ({ extensionContext, storage }) => {
	const page = await extensionContext.newPage();
	await page.route('https://www.perplexity.ai/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'POST' && url.pathname === '/rest/sse/perplexity_ask') {
			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: 'data: {"choices":[{"delta":{"content":"Perplexity answer"}}]}\n\ndata: [DONE]\n\n'
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><body><main>Mock Perplexity</main></body></html>'
		});
	});

	await page.goto('https://www.perplexity.ai/');

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
		await fetch('/rest/sse/perplexity_ask', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				model: 'sonar-pro',
				query: 'Explain the product analytics state'
			})
		});
	});

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.length || 0);
	// >= 1 rather than === 1 because some platforms make their own
	// page-hydration fetch before our explicit test fetch lands. The
	// storage-side requests assertion below is the real correctness
	// check (background-side dedupe collapses redundant events).
	}).toBeGreaterThanOrEqual(1);

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.[0]?.platform);
	}).toBe('perplexity');

	await expect.poll(async () => (await readPlatformUsage(storage, 'perplexity'))?.requests || 0, { timeout: 15000 }).toBe(1);
	await expect.poll(async () => (await readPlatformUsage(storage, 'perplexity'))?.inputTokens || 0, { timeout: 15000 }).toBeGreaterThan(0);

	await page.waitForTimeout(250);
	await page.close();
});

test('grok browser fetch records usage through page-context capture', async ({ extensionContext, storage }) => {
	const page = await extensionContext.newPage();
	await page.route('https://grok.com/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'POST' && url.pathname === '/rest/app-chat/conversations/new') {
			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: 'data: {"result":{"response":{"text":"Grok answer"}}}\n\ndata: [DONE]\n\n'
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><body><main>Mock Grok</main></body></html>'
		});
	});

	await page.goto('https://grok.com/');

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
		await fetch('/rest/app-chat/conversations/new', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				modelName: 'grok-4.3',
				messages: [{ role: 'user', content: 'Explain the cost dashboard state' }]
			})
		});
	});

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.length || 0);
	// >= 1 rather than === 1 because some platforms make their own
	// page-hydration fetch before our explicit test fetch lands. The
	// storage-side requests assertion below is the real correctness
	// check (background-side dedupe collapses redundant events).
	}).toBeGreaterThanOrEqual(1);

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.[0]?.platform);
	}).toBe('grok');

	await expect.poll(async () => (await readPlatformUsage(storage, 'grok'))?.requests || 0, { timeout: 15000 }).toBe(1);
	await expect.poll(async () => (await readPlatformUsage(storage, 'grok'))?.inputTokens || 0, { timeout: 15000 }).toBeGreaterThan(0);

	await page.waitForTimeout(250);
	await page.close();
});
