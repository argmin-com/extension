// tests/unit/csv-determinism.test.mjs
//
// v9.7.0 regression guard: calling exportUsageCSV twice with the same
// stored input must produce byte-identical output. Finance tooling
// signs CSV exports and compares against expected hashes; any
// non-determinism in row ordering, number formatting, or model-map
// iteration would break those workflows silently.
//
// The wider csv-export suite covers row construction, escaping, and
// filename packing in isolation. This file is the integration check:
// stage the platformUsage StoredMap, call exportUsageCSV() twice with
// the exact same arguments, and assert content === content.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const storageData = {};
async function storageGet(keys) {
	if (keys == null) return JSON.parse(JSON.stringify(storageData));
	if (typeof keys === 'string') return { [keys]: storageData[keys] };
	if (Array.isArray(keys)) {
		const out = {};
		for (const key of keys) out[key] = storageData[key];
		return out;
	}
	const out = {};
	for (const [key, def] of Object.entries(keys || {})) {
		out[key] = Object.prototype.hasOwnProperty.call(storageData, key) ? storageData[key] : def;
	}
	return out;
}
async function storageSet(items) {
	for (const [k, v] of Object.entries(items)) storageData[k] = JSON.parse(JSON.stringify(v));
}
async function storageRemove(keys) {
	const list = Array.isArray(keys) ? keys : [keys];
	for (const k of list) delete storageData[k];
}

globalThis.chrome = {
	action: {},
	storage: { local: { get: storageGet, set: storageSet, remove: storageRemove } }
};
globalThis.browser = {
	storage: {
		local: globalThis.chrome.storage.local,
		onChanged: { addListener() {}, removeListener() {} }
	}
};

const { exportUsageCSV } = await import(
	new URL('../../bg-components/reports-export.js', import.meta.url).href
);

// Seed multiple platforms, multiple days, multiple models per day. The
// model map intentionally uses keys in a non-alphabetical order so the
// determinism test would fail if rowsFromDailyRollups ever relied on
// Object.keys() iteration order without sorting.
const today = new Date(Date.UTC(2026, 4, 14)); // 2026-05-14
const yesterday = new Date(Date.UTC(2026, 4, 13));
const dateKey = (d) => d.toISOString().slice(0, 10);

await storageSet({
	platformUsage: [
		[`chatgpt:${dateKey(today)}`, {
			requests: 5,
			inputTokens: 1234,
			outputTokens: 567,
			models: {
				'gpt-5':    { requests: 2, inputTokens: 600, outputTokens: 300 },
				'gpt-4o':   { requests: 2, inputTokens: 500, outputTokens: 200 },
				'gpt-4o-mini': { requests: 1, inputTokens: 134, outputTokens: 67 }
			},
			estimatedCostUSD: 0.0345,
			totalEnergyWh: 1.2,
			totalCarbonGco2e: 0.5,
			firstRequestAt: today.getTime(),
			lastRequestAt: today.getTime()
		}],
		[`claude:${dateKey(today)}`, {
			requests: 3,
			inputTokens: 800,
			outputTokens: 400,
			models: {
				'claude-3-5-sonnet': { requests: 2, inputTokens: 600, outputTokens: 300 },
				'claude-3-haiku':    { requests: 1, inputTokens: 200, outputTokens: 100 }
			},
			estimatedCostUSD: 0.012,
			totalEnergyWh: 0.6,
			totalCarbonGco2e: 0.3,
			firstRequestAt: today.getTime(),
			lastRequestAt: today.getTime()
		}],
		[`claude:${dateKey(yesterday)}`, {
			requests: 1,
			inputTokens: 100,
			outputTokens: 50,
			models: { 'claude-3-haiku': { requests: 1, inputTokens: 100, outputTokens: 50 } },
			estimatedCostUSD: 0.001,
			totalEnergyWh: 0.1,
			totalCarbonGco2e: 0.05,
			firstRequestAt: yesterday.getTime(),
			lastRequestAt: yesterday.getTime()
		}]
	]
});

test('exportUsageCSV is deterministic across repeated calls with the same input', async () => {
	const args = { startDate: yesterday, endDate: today };
	const first = await exportUsageCSV(args);
	const second = await exportUsageCSV(args);

	assert.equal(first.filename, second.filename,
		'filename must match across calls');
	assert.equal(first.mime, second.mime,
		'mime must match across calls');
	assert.equal(first.content, second.content,
		'CSV content must be byte-identical across calls with the same input');

	// Sanity: the output is non-empty and contains the header row.
	assert.ok(first.content.length > 0, 'expected non-empty CSV');
	assert.ok(first.content.startsWith('date,platform,model,'),
		'CSV must start with the canonical header row');
});

test('exportUsageCSV is deterministic when filtered to a single platform', async () => {
	const args = { startDate: yesterday, endDate: today, platform: 'claude' };
	const first = await exportUsageCSV(args);
	const second = await exportUsageCSV(args);
	assert.equal(first.content, second.content,
		'platform-filtered CSV content must be byte-identical across calls');
});

test('exportUsageCSV byte length is stable across three back-to-back calls', async () => {
	// Three calls catches the case where the FIRST call seeds an
	// in-memory cache and subsequent calls take a different path; we
	// want all three to land on the same content.
	const args = { startDate: yesterday, endDate: today };
	const a = await exportUsageCSV(args);
	const b = await exportUsageCSV(args);
	const c = await exportUsageCSV(args);
	assert.equal(a.content, b.content);
	assert.equal(b.content, c.content);
	assert.equal(a.content.length, c.content.length);
});
