// tests/unit/platform-usage-store.test.mjs
// Regression coverage for platform usage accounting against older stored
// shapes. These tests use a tiny browser.storage mock so the real StoredMap
// implementation is exercised.

import { test } from 'node:test';
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

globalThis.chrome = {
	action: {},
	storage: {
		local: { get: storageGet, set: storageSet, remove: storageRemove }
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

const moduleUrl = new URL('../../bg-components/platforms/platform-base.js', import.meta.url);
const { PlatformUsageStore, platformUsageStore } = await import(moduleUrl.href);
destroyUsageStore(platformUsageStore);

function resetStorage() {
	for (const key of Object.keys(storageData)) delete storageData[key];
	listeners.clear();
}

function destroyUsageStore(usageStore) {
	usageStore.store.destroy();
	usageStore.velocityStore.destroy();
	usageStore.rateLimitStore.destroy();
}

test('recordRequest tolerates legacy day records without models', async () => {
	resetStorage();
	const usageStore = new PlatformUsageStore();
	const dateKey = new Date().toISOString().slice(0, 10);
	await storageSet({
		platformUsage: [[`chatgpt:${dateKey}`, {
			requests: 1,
			inputTokens: 100,
			outputTokens: 0,
			estimatedCostUSD: 0.00025,
			firstRequestAt: Date.now(),
			lastRequestAt: Date.now()
		}]]
	});

	const updated = await usageStore.recordRequest('chatgpt', 'gpt-4o', 25, 0);

	assert.equal(updated.requests, 2);
	assert.equal(updated.inputTokens, 125);
	assert.equal(updated.models['gpt-4o'].requests, 1);
	assert.equal(updated.models['gpt-4o'].inputTokens, 25);
	destroyUsageStore(usageStore);
});

test('recordOutputTokens creates missing per-model buckets', async () => {
	resetStorage();
	const usageStore = new PlatformUsageStore();
	const dateKey = new Date().toISOString().slice(0, 10);
	await storageSet({
		platformUsage: [[`gemini:${dateKey}`, {
			requests: 1,
			inputTokens: 100,
			outputTokens: 0,
			models: {},
			estimatedCostUSD: 0,
			firstRequestAt: Date.now(),
			lastRequestAt: Date.now()
		}]]
	});

	const updated = await usageStore.recordOutputTokens('gemini', 'gemini-2.5-pro', 10);

	assert.equal(updated.outputTokens, 11);
	assert.equal(updated.models['gemini-2.5-pro'].requests, 0);
	assert.equal(updated.models['gemini-2.5-pro'].outputTokens, 11);
	assert.ok(updated.estimatedCostUSD > 0);
	destroyUsageStore(usageStore);
});

test('getSubscriptionTier uses platform-specific free defaults', async () => {
	resetStorage();
	const usageStore = new PlatformUsageStore();

	assert.equal(await usageStore.getSubscriptionTier('claude'), 'claude_free');
	assert.equal(await usageStore.getSubscriptionTier('chatgpt'), 'free');
	destroyUsageStore(usageStore);
});

test('recordOutputTokens can create output-only day record without counting a request', async () => {
	resetStorage();
	const usageStore = new PlatformUsageStore();

	const updated = await usageStore.recordOutputTokens('chatgpt', 'gpt-4o', 20);

	assert.equal(updated.requests, 0);
	assert.equal(updated.inputTokens, 0);
	assert.equal(updated.outputTokens, 20);
	assert.equal(updated.models['gpt-4o'].requests, 0);
	assert.equal(updated.models['gpt-4o'].outputTokens, 20);
	assert.equal(updated.captureSources.outputStream, 1);
	assert.ok(updated.estimatedCostUSD > 0);
	destroyUsageStore(usageStore);
});

test('recordRequest records capture source and honors local retention setting', async () => {
	resetStorage();
	await storageSet({ 'usageInsights:retentionDays': 2 });
	const usageStore = new PlatformUsageStore();
	const before = Date.now();

	const updated = await usageStore.recordRequest('chatgpt', 'gpt-4o', 25, 0, { source: 'pageContext' });
	await usageStore.store.flush();

	assert.equal(updated.captureSources.pageContext, 1);
	const raw = storageData.platformUsage?.[0]?.[1];
	assert.ok(raw?.expires > before + 24 * 60 * 60 * 1000, `expires too early: ${raw?.expires}`);
	assert.ok(raw?.expires <= before + 2 * 24 * 60 * 60 * 1000 + 5000, `expires too late: ${raw?.expires}`);
	destroyUsageStore(usageStore);
});

test('perplexity request pricing includes per-request Sonar fee', async () => {
	resetStorage();
	const usageStore = new PlatformUsageStore();

	const updated = await usageStore.recordRequest('perplexity', 'sonar-pro', 1000, 0, { source: 'pageContext' });

	// Sonar Pro input for 1K tokens is $0.003; the documented low-context
	// request fee is $0.006, so the total should include both components.
	assert.equal(updated.requests, 1);
	assert.ok(updated.estimatedCostUSD >= 0.0089, `estimated cost too low: ${updated.estimatedCostUSD}`);
	assert.ok(updated.estimatedCostUSD <= 0.0091, `estimated cost too high: ${updated.estimatedCostUSD}`);
	destroyUsageStore(usageStore);
});
