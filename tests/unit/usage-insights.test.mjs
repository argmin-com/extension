// tests/unit/usage-insights.test.mjs
// Regression coverage for aggregate-only Insights. The browser.storage mock
// exercises the same StoredMap implementation used by the extension.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const storageData = {};
const listeners = new Set();

function clone(value) {
	return value == null ? value : JSON.parse(JSON.stringify(value));
}

async function storageGet(keys) {
	if (keys == null) return clone(storageData);
	if (typeof keys === 'string') return { [keys]: clone(storageData[keys]) };
	if (Array.isArray(keys)) {
		const out = {};
		for (const key of keys) out[key] = clone(storageData[key]);
		return out;
	}
	const out = {};
	for (const [key, defaultValue] of Object.entries(keys || {})) {
		out[key] = Object.prototype.hasOwnProperty.call(storageData, key) ? clone(storageData[key]) : defaultValue;
	}
	return out;
}

async function storageSet(items) {
	const changes = {};
	for (const [key, value] of Object.entries(items)) {
		changes[key] = { oldValue: clone(storageData[key]), newValue: clone(value) };
		storageData[key] = clone(value);
	}
	for (const listener of listeners) listener(changes, 'local');
}

async function storageRemove(keys) {
	const list = Array.isArray(keys) ? keys : [keys];
	const changes = {};
	for (const key of list) {
		changes[key] = { oldValue: clone(storageData[key]), newValue: undefined };
		delete storageData[key];
	}
	for (const listener of listeners) listener(changes, 'local');
}

async function storageClear() {
	const changes = {};
	for (const key of Object.keys(storageData)) {
		changes[key] = { oldValue: clone(storageData[key]), newValue: undefined };
		delete storageData[key];
	}
	for (const listener of listeners) listener(changes, 'local');
}

globalThis.chrome = {
	action: {},
	storage: {
		local: { get: storageGet, set: storageSet, remove: storageRemove, clear: storageClear }
	}
};
globalThis.browser = {
	storage: {
		local: globalThis.chrome.storage.local,
		onChanged: {
			addListener(listener) { listeners.add(listener); },
			removeListener(listener) { listeners.delete(listener); }
		}
	}
};

const insightsModule = await import('../../bg-components/usage-insights.js');
const platformModule = await import('../../bg-components/platforms/platform-base.js');
const sessionModule = await import('../../bg-components/session-tracker.js');

const { buildUsageInsights, cleanupLocalUsage, setRetentionDays } = insightsModule;
const { platformUsageStore } = platformModule;
const { sessionTracker } = sessionModule;

after(() => {
	platformUsageStore.store.destroy();
	platformUsageStore.velocityStore.destroy();
	platformUsageStore.rateLimitStore.destroy();
	sessionTracker.turns.destroy();
	sessionTracker.sessionMeta.destroy();
});

async function resetStorage() {
	await storageClear();
}

test('buildUsageInsights aggregates provider, model, capture, privacy, and warning signals', async () => {
	await resetStorage();
	const today = new Date().toISOString().slice(0, 10);
	await storageSet({
		userBudgets: { dailyCostLimit: 0.02, dailyCarbonLimit: 5 },
		platformUsage: [
			[`chatgpt:${today}`, {
				requests: 2,
				inputTokens: 1000,
				outputTokens: 400,
				models: { 'gpt-4o': { requests: 2, inputTokens: 1000, outputTokens: 400 } },
				estimatedCostUSD: 0.02,
				totalEnergyWh: 1,
				totalCarbonGco2e: 2,
				firstRequestAt: Date.now(),
				lastRequestAt: Date.now(),
				captureSources: { pageContext: 2, outputStream: 1 }
			}],
			[`claude:${today}`, {
				requests: 1,
				inputTokens: 500,
				outputTokens: 0,
				models: { unknown: { requests: 1, inputTokens: 500, outputTokens: 0 } },
				estimatedCostUSD: 0.01,
				totalEnergyWh: 0,
				totalCarbonGco2e: 0,
				firstRequestAt: Date.now(),
				lastRequestAt: Date.now(),
				captureSources: { fallback: 1 }
			}]
		]
	});

	const insights = await buildUsageInsights();

	assert.equal(insights.dailyDigest.totalRequests, 3);
	assert.equal(insights.dailyDigest.topProvider.platform, 'chatgpt');
	assert.ok(insights.modelLeaderboard.some(row => row.model === 'gpt-4o'));
	assert.equal(insights.captureReliability.sources.pageContext, 2);
	assert.equal(insights.captureReliability.sources.fallback, 1);
	assert.equal(insights.privacySnapshot.rawContentStored, false);
	assert.equal(insights.privacySnapshot.telemetryEnabled, false);
	assert.ok(insights.budgetStatus.alerts.some(alert => alert.type === 'cost'));
	assert.ok(insights.dataQualityWarnings.some(warning => warning.code === 'fallback_capture'));
	assert.ok(insights.dataQualityWarnings.some(warning => warning.code === 'unknown_model'));
	assert.ok(insights.dataQualityWarnings.some(warning => warning.code === 'claude_missing_output_tokens'));
});

test('retention cleanup removes stale platform, session, and decision records', async () => {
	await resetStorage();
	await setRetentionDays(7);
	const now = Date.now();
	const oldTs = now - 12 * 24 * 60 * 60 * 1000;
	const recentTs = now - 2 * 24 * 60 * 60 * 1000;
	const oldDay = new Date(oldTs).toISOString().slice(0, 10);
	const recentDay = new Date(recentTs).toISOString().slice(0, 10);

	await storageSet({
		platformUsage: [
			[`chatgpt:${oldDay}`, { requests: 1, inputTokens: 10, outputTokens: 0, models: {}, estimatedCostUSD: 0.001 }],
			[`chatgpt:${recentDay}`, { requests: 1, inputTokens: 20, outputTokens: 0, models: {}, estimatedCostUSD: 0.002 }]
		],
		sessionTurns: [
			['sess_old:1', { ts: oldTs, sessionId: 'sess_old' }],
			['sess_recent:1', { ts: recentTs, sessionId: 'sess_recent' }]
		],
		sessionMeta: [
			['sess_old', { sessionId: 'sess_old', lastSeenAt: oldTs }],
			['sess_recent', { sessionId: 'sess_recent', lastSeenAt: recentTs }]
		],
		'decision:events': [
			{ timestamp: oldTs, type: 'old' },
			{ timestamp: recentTs, type: 'recent' }
		]
	});

	const result = await cleanupLocalUsage();

	assert.equal(result.retentionDays, 7);
	assert.equal(result.removed.platformDays, 1);
	assert.equal(result.removed.turns, 1);
	assert.equal(result.removed.sessions, 1);
	assert.equal(result.removed.decisionEvents, 1);

	const all = await storageGet(null);
	assert.equal(all.platformUsage.length, 1);
	assert.equal(all.platformUsage[0][0], `chatgpt:${recentDay}`);
	assert.equal(all.sessionTurns.length, 1);
	assert.equal(all.sessionMeta.length, 1);
	assert.deepEqual(all['decision:events'].map(event => event.type), ['recent']);
});
