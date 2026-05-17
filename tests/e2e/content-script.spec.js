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
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);

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
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerNonceReady));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => document.documentElement.dataset.aiTrackerNonce || '');
	}).toBe('');

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
		return await page.evaluate(() => window.__testInferenceEvents?.[0]?.__nonce || '');
	}).not.toBe('');

	// StoredMap wraps values as { value, expires } when a lifetime is set
	// (see bg-components/utils.js). Production reads always go through
	// platformUsageStore.get(), which unwraps. Tests that peek at raw storage
	// have to unwrap themselves.
	await expect.poll(async () => (await readPlatformUsage(storage, 'chatgpt'))?.requests || 0, { timeout: 20000 }).toBe(1);
	await expect.poll(async () => (await readPlatformUsage(storage, 'chatgpt'))?.inputTokens || 0, { timeout: 20000 }).toBeGreaterThan(0);

	// handleGenericBeforeRequest also writes to sessionTracker's StoredMaps via
	// a 100ms debounce. Let them drain before fixture teardown clears storage,
	// otherwise a late write can leak into the next test.
	await page.waitForTimeout(250);

	await page.close();
});

test('page-originated tracker events cannot switch platforms after observing a real nonce', async ({ extensionContext, storage }) => {
	const page = await extensionContext.newPage();
	await page.route('https://chatgpt.com/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (request.method() === 'POST' && url.pathname === '/backend-api/f/conversation') {
			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: 'data: {"o":"append","p":"/message/content/parts/0","v":"Legitimate response"}\n\ndata: [DONE]\n\n'
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
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerNonceReady));
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
					content: { content_type: 'text', parts: ['Legitimate prompt'] }
				}]
			})
		});
	});

	await expect.poll(async () => {
		return await page.evaluate(() => window.__testInferenceEvents?.[0]?.__nonce || '');
	}).not.toBe('');
	const observedNonce = await page.evaluate(() => window.__testInferenceEvents[0].__nonce);

	await page.evaluate(() => {
		const nonce = window.__testInferenceEvents[0].__nonce;
		window.dispatchEvent(new CustomEvent('platformInferenceRequest', {
			detail: {
				__nonce: nonce,
				platform: 'claude',
				url: 'https://claude.ai/api/organizations/org_123/chat_conversations/conv_123/completion',
				method: 'POST',
				bodyText: JSON.stringify({
					model: 'claude-sonnet-4-20250514',
					prompt: 'forged cross-platform prompt'
				})
			}
		}));
	});
	expect(observedNonce).not.toBe('');

	await page.waitForTimeout(500);
	expect((await readPlatformUsage(storage, 'claude'))?.requests || 0).toBe(0);

	await page.waitForTimeout(250);
	await page.close();
});

test('claude browser fetch records usage through page-context capture', async ({ extensionContext, storage }) => {
	// Seed tier as MANUAL so auto-detection is sticky-overridden and the
	// SW isn't racing with the explicit fetch. Without this, the SW is
	// busy writing tier/tierSource/tierSetAt from auto-detection at the
	// same moment recordPlatformRequest arrives, which was the residual
	// flake source even after per-test isolation.
	await storage.set({
		'tier:claude': 'claude_pro',
		'tierSource:claude': 'manual',
		'tierSetAt:claude': Date.now()
	});
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
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerNonceReady));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => document.documentElement.dataset.aiTrackerNonce || '');
	}).toBe('');

	await expect.poll(async () => {
		const values = await storage.get('tier:claude');
		return values['tier:claude'];
	}).toBe('claude_pro');

	// Force the SW to settle any in-flight writes from tier detection
	// (setSubscriptionTier writes three keys: tier, tierSource, tierSetAt)
	// before we fire the inference request. Without this beat, the next
	// recordPlatformRequest message can queue behind those writes and
	// occasionally exceed the storage poll window.
	await page.waitForTimeout(150);

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
		return await page.evaluate(() => window.__testInferenceEvents?.[0]?.__nonce || '');
	}).not.toBe('');

	await expect.poll(async () => (await readPlatformUsage(storage, 'claude'))?.requests || 0, { timeout: 20000 }).toBe(1);
	await expect.poll(async () => (await readPlatformUsage(storage, 'claude'))?.inputTokens || 0, { timeout: 20000 }).toBeGreaterThan(0);

	await page.waitForTimeout(250);
	await page.close();
});

test('perplexity browser fetch records usage through page-context capture', async ({ extensionContext, storage }) => {
	await storage.set({
		'tier:perplexity': 'pro',
		'tierSource:perplexity': 'manual',
		'tierSetAt:perplexity': Date.now()
	});
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
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerNonceReady));
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

	await expect.poll(async () => (await readPlatformUsage(storage, 'perplexity'))?.requests || 0, { timeout: 20000 }).toBe(1);
	await expect.poll(async () => (await readPlatformUsage(storage, 'perplexity'))?.inputTokens || 0, { timeout: 20000 }).toBeGreaterThan(0);

	await page.waitForTimeout(250);
	await page.close();
});

test('grok browser fetch records usage through page-context capture', async ({ extensionContext, storage }) => {
	await storage.set({
		'tier:grok': 'supergrok',
		'tierSource:grok': 'manual',
		'tierSetAt:grok': Date.now()
	});
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
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerNonceReady));
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

	await expect.poll(async () => (await readPlatformUsage(storage, 'grok'))?.requests || 0, { timeout: 20000 }).toBe(1);
	await expect.poll(async () => (await readPlatformUsage(storage, 'grok'))?.inputTokens || 0, { timeout: 20000 }).toBeGreaterThan(0);

	await page.waitForTimeout(250);
	await page.close();
});

// ──────────────────────────────────────────────────────────────────────────
// v9.7.0: Microsoft Copilot (copilot.microsoft.com)
//
// Smoke-level Playwright case asserting the floating badge injects on
// copilot.microsoft.com. We do NOT exercise a full SSE inference round
// trip here -- the unit suite (tests/unit/copilot-platform.test.mjs)
// already covers intercept-pattern and pricing shape, and the content
// surface for Copilot's streaming response changes frequently. The
// badge injection is the load-bearing assertion: if it does not appear,
// the platform is invisible to the user.
// ──────────────────────────────────────────────────────────────────────────

test('copilot page injects floating badge', async ({ extensionContext }) => {
	const page = await extensionContext.newPage();
	await page.route('https://copilot.microsoft.com/**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><body><main>Mock Copilot</main></body></html>'
		});
	});

	await page.goto('https://copilot.microsoft.com/');

	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerNonceReady));
	}).toBe(true);

	const badge = page.locator('#ut-platform-badge');
	await expect(badge).toBeVisible({ timeout: 15000 });
	await expect(badge.locator('.ut-platform-badge-title')).toHaveText('Microsoft Copilot Usage');

	await page.close();
});

// ──────────────────────────────────────────────────────────────────────────
// v9.7.0: Meta AI (meta.ai)
//
// Same shape as the Copilot smoke. Meta AI is a free consumer surface
// (zero pricing across the board) and its API path lives behind
// /api/graphql, /api/conversations, etc. The badge title pulls from
// CONFIG.PLATFORMS.meta.name so this also guards that registration.
// ──────────────────────────────────────────────────────────────────────────

test('meta.ai page injects floating badge', async ({ extensionContext }) => {
	const page = await extensionContext.newPage();
	await page.route('https://www.meta.ai/**', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><body><main>Mock Meta AI</main></body></html>'
		});
	});

	await page.goto('https://www.meta.ai/');

	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);

	const badge = page.locator('#ut-platform-badge');
	await expect(badge).toBeVisible({ timeout: 15000 });
	await expect(badge.locator('.ut-platform-badge-title')).toHaveText('Meta AI Usage');

	await page.close();
});

// ──────────────────────────────────────────────────────────────────────────
// v9.7.0: Gemini phantom-output regression
//
// Regression: a settings-style PATCH to /_/SomeService/data used to be
// (mis-)detected as inference by the page-context wrapper because the
// path lived under /_/ and the wrapper relied on a substring match.
// stream-token-counter.js was tightened to require an exact endpoint
// hit (BardChatUi/data/assistant.lamda, ...batchexecute, or
// StreamGenerate / GenerateContent). This test:
//
//   1. Mocks a non-inference PATCH under /_/SettingsService/data and
//      asserts platformUsage.gemini.outputTokens stays at zero.
//   2. Mocks a real /_/BardChatUi/data/assistant.lamda SSE stream and
//      asserts platformUsage.gemini.outputTokens goes UP.
//
// If a future refactor loosens shouldIntercept() to a /_/ catch-all,
// step 1 will tip the output count above zero and this test will fail.
// ──────────────────────────────────────────────────────────────────────────

test('gemini settings PATCH does not phantom-inflate output tokens; real lamda stream does', async ({ extensionContext, storage }) => {
	await storage.set({
		'tier:gemini': 'advanced',
		'tierSource:gemini': 'manual',
		'tierSetAt:gemini': Date.now()
	});

	const page = await extensionContext.newPage();
	await page.route('https://gemini.google.com/**', async (route) => {
		const request = route.request();
		const url = new URL(request.url());

		// 1) Settings/preferences-style PATCH: must NOT count as inference.
		if (url.pathname === '/_/SettingsService/data') {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ ok: true, settings: { dark_mode: true } })
			});
			return;
		}

		// 2) Real assistant SSE: MUST count as inference. The Gemini parser
		//    accepts loosely-quoted text; we feed a plain-text body large
		//    enough to register more than the small-output noise floor.
		if (url.pathname.startsWith('/_/BardChatUi/data/assistant.lamda')) {
			await route.fulfill({
				status: 200,
				contentType: 'text/event-stream',
				body: 'data: ["wrb.fr",null,"[[\\"Hello from Gemini, this is a real streamed answer.\\"]]"]\n\ndata: [DONE]\n\n'
			});
			return;
		}

		await route.fulfill({
			status: 200,
			contentType: 'text/html',
			body: '<!doctype html><html><body><main>Mock Gemini</main></body></html>'
		});
	});

	await page.goto('https://gemini.google.com/app');

	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerStreamWrapped));
	}).toBe(true);
	await expect.poll(async () => {
		return await page.evaluate(() => Boolean(window.__aiTrackerNonceReady));
	}).toBe(true);

	// Fire the settings PATCH first. If the phantom-output regression
	// returns, this would silently boost outputTokens.
	await page.evaluate(async () => {
		await fetch('/_/SettingsService/data', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pref: { theme: 'dark' } })
		});
	});

	// Give the SW a moment to NOT record anything. Polling on absence
	// is unreliable -- a fixed beat is the conservative choice.
	await page.waitForTimeout(500);

	const phantomOutputs = await readPlatformUsage(storage, 'gemini');
	// Either nothing was recorded (preferred) or a record exists with
	// zero output tokens. Both are acceptable; what fails the test is
	// outputTokens > 0 from a settings PATCH.
	const phantomOutputTokens = phantomOutputs?.outputTokens || 0;
	expect(phantomOutputTokens).toBe(0);

	// Now fire the real assistant.lamda call. This MUST register output.
	await page.evaluate(async () => {
		await fetch('/_/BardChatUi/data/assistant.lamda', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'f.req=' + encodeURIComponent('[[\"hello gemini\"]]')
		});
	});

	await expect.poll(
		async () => (await readPlatformUsage(storage, 'gemini'))?.outputTokens || 0,
		{ timeout: 20000 }
	).toBeGreaterThan(0);

	await page.waitForTimeout(250);
	await page.close();
});
