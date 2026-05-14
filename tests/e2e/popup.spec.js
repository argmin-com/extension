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

// ──────────────────────────────────────────────────────────────────────────
// v9.7.0: Findings provenance on the Optimize tab
//
// Optimize cards now carry two new visual elements when the finding
// has provenance:
//   - .platform-pill         -- one per finding, single or multi-platform
//   - <details.finding-sources> with N <li> rows matching conversationUrls
//
// The optimize scanners only emit certain finding ids when their
// thresholds trip. To make this test deterministic we seed 6+ turns
// with an identical (categoryLabel + promptHash) across 5 sessions on
// two platforms; that is enough to fire the "duplicate prompts" scanner
// reliably without depending on usage data anywhere else.
// ──────────────────────────────────────────────────────────────────────────

test('optimize tab renders platform-pill and finding-sources for findings with provenance', async ({ extensionPage, storage }) => {
	const now = Date.now();
	const turns = [];
	const urls = [];
	for (let i = 0; i < 6; i++) {
		const platform = i % 2 === 0 ? 'claude' : 'chatgpt';
		const conversationUrl = platform === 'claude'
			? 'https://claude.ai/chat/conv-' + i
			: 'https://chatgpt.com/c/conv-' + i;
		urls.push(conversationUrl);
		const ts = now - 1000 * 60 * (i + 1);
		turns.push([
			'sess-prov-' + i + ':' + ts,
			{
				ts,
				sessionId: 'sess-prov-' + i,
				platform,
				model: 'Sonnet',
				category: 'coding',
				categoryLabel: 'Coding',
				confidence: 0.9,
				promptHash: 'prov-hash',
				promptLength: 500,
				inputTokens: 200,
				outputTokens: 100,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUSD: 0.02,
				hadError: false,
				retryOf: null,
				similarity: 0,
				dayKey: new Date(ts).toISOString().slice(0, 10),
				conversationUrl
			}
		]);
	}
	await storage.set({ sessionTurns: turns });

	const page = await extensionPage('popup.html');
	await page.getByRole('tab', { name: 'Optimize' }).click();

	// Wait for the scanner to finish and render at least one finding card.
	await expect(page.locator('#optimizeContent .finding').first()).toBeVisible({ timeout: 15000 });

	// At least one finding card must carry the multi-platform pill
	// (claude + chatgpt) AND a finding-sources disclosure with N rows.
	const cards = page.locator('#optimizeContent .finding');
	const count = await cards.count();
	let sawPlatformPill = false;
	let sawSources = false;
	for (let i = 0; i < count; i++) {
		const card = cards.nth(i);
		const pill = card.locator('.platform-pill');
		const sources = card.locator('details.finding-sources');
		if (await pill.count() > 0) sawPlatformPill = true;
		if (await sources.count() > 0) {
			sawSources = true;
			// Disclosure should list at least one of the seeded URLs.
			const items = await sources.locator('.finding-sources-list li').count();
			expect(items).toBeGreaterThan(0);
			expect(items).toBeLessThanOrEqual(10); // MAX_URLS_PER_FINDING
		}
	}
	expect(sawPlatformPill).toBe(true);
	expect(sawSources).toBe(true);

	// At least one multi-platform pill is expected because we seeded
	// turns on both claude and chatgpt under the same prompt hash.
	const multiPill = page.locator('#optimizeContent .finding .platform-pill.platform-pill-multi').first();
	await expect(multiPill).toBeVisible();
	const multiText = await multiPill.textContent();
	expect(multiText || '').toMatch(/Multi:/);
	expect(multiText || '').toMatch(/Claude/);
	expect(multiText || '').toMatch(/ChatGPT/);

	await page.close();
});

// ──────────────────────────────────────────────────────────────────────────
// v9.7.0: Reports panel under Tools
//
// Tools tab now hosts a "Reports" card with:
//   - two date inputs (#reportStartDate, #reportEndDate)
//   - a platform select (#reportPlatform)
//   - four download buttons: Usage CSV, Findings CSV, Full JSON,
//     This-month summary
//
// The first three trigger a Blob download via downloadFile(); the
// fourth populates an in-popup <details> summary. We assert the UI
// surface exists and the three CSV/JSON buttons actually fire a
// browser-level download event (i.e. the export pipeline produced a
// payload and the popup wired it through to <a download>).
// ──────────────────────────────────────────────────────────────────────────

test('tools tab exposes Reports panel with date pickers, platform select, and download buttons', async ({ extensionPage, storage }) => {
	// Seed one row so the usage CSV is not empty -- the export must
	// still produce a valid Blob either way, but a populated row makes
	// the assertion more meaningful.
	const dateKey = new Date().toISOString().slice(0, 10);
	await storage.set({
		platformUsage: [[`chatgpt:${dateKey}`, {
			requests: 1,
			inputTokens: 100,
			outputTokens: 50,
			models: { 'gpt-4o': { requests: 1, inputTokens: 100, outputTokens: 50 } },
			estimatedCostUSD: 0.01,
			totalEnergyWh: 0,
			totalCarbonGco2e: 0,
			firstRequestAt: Date.now(),
			lastRequestAt: Date.now()
		}]]
	});

	const page = await extensionPage('popup.html');
	await page.getByRole('tab', { name: 'Tools' }).click();

	// Surface: date pickers + platform select + four buttons.
	await expect(page.locator('#reportStartDate')).toBeVisible();
	await expect(page.locator('#reportEndDate')).toBeVisible();
	await expect(page.locator('#reportPlatform')).toBeVisible();
	await expect(page.locator('#reportUsageCSV')).toBeVisible();
	await expect(page.locator('#reportFindingsCSV')).toBeVisible();
	await expect(page.locator('#reportJSON')).toBeVisible();
	await expect(page.locator('#reportSummary')).toBeVisible();
	await expect(page.locator('#reportUsageCSV')).toHaveText('Usage CSV');
	await expect(page.locator('#reportFindingsCSV')).toHaveText('Findings CSV');
	await expect(page.locator('#reportJSON')).toHaveText('Full JSON');
	// "This-month summary" is the visible label in popup.js.
	await expect(page.locator('#reportSummary')).toContainText('summary');

	// Click each of the three file-download buttons and assert a
	// browser-level download fires. We capture the download event via
	// page.waitForEvent('download'), filter by a sensible filename
	// prefix, and verify a non-empty filename was suggested.
	async function clickAndAwaitDownload(selector, expectedPrefix) {
		const [download] = await Promise.all([
			page.waitForEvent('download', { timeout: 15000 }),
			page.click(selector)
		]);
		const suggested = download.suggestedFilename();
		expect(suggested).toBeTruthy();
		expect(suggested.startsWith(expectedPrefix)).toBe(true);
	}

	await clickAndAwaitDownload('#reportUsageCSV', 'ai-cost-usage-');
	await clickAndAwaitDownload('#reportFindingsCSV', 'ai-cost-findings-');
	await clickAndAwaitDownload('#reportJSON', 'ai-cost-export-');

	// The "summary" button does not download; it expands a <details>
	// preview. Verify it opens.
	await page.click('#reportSummary');
	await expect(page.locator('#reportSummaryDetails')).toHaveAttribute('open', '');

	await page.close();
});
