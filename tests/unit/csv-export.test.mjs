// tests/unit/csv-export.test.mjs
//
// Coverage for bg-components/reports-export.js. The module imports
// platforms/platform-base.js which talks to browser.storage, so we
// install a tiny in-memory shim before importing.

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

const reportsModuleUrl = new URL('../../bg-components/reports-export.js', import.meta.url);
const {
	csvEscape,
	serializeUsageCSV,
	serializeFindingsCSV,
	rowsFromDailyRollups,
	sortKeys,
	usageFilename,
	findingsFilename,
	fullJsonFilename,
	buildMonthlySummaryFromData,
	USAGE_CSV_HEADERS,
	FINDINGS_CSV_HEADERS
} = await import(reportsModuleUrl.href);

test('csvEscape leaves plain values untouched', () => {
	assert.equal(csvEscape('hello'), 'hello');
	assert.equal(csvEscape(42), '42');
	assert.equal(csvEscape(0), '0');
});

test('csvEscape handles null and undefined as empty strings', () => {
	assert.equal(csvEscape(null), '');
	assert.equal(csvEscape(undefined), '');
});

test('csvEscape wraps values with commas', () => {
	assert.equal(csvEscape('hello, world'), '"hello, world"');
});

test('csvEscape wraps values with newlines', () => {
	assert.equal(csvEscape('line one\nline two'), '"line one\nline two"');
	assert.equal(csvEscape('line one\r\nline two'), '"line one\r\nline two"');
});

test('csvEscape doubles embedded quotes and wraps the value', () => {
	assert.equal(csvEscape('she said "hi"'), '"she said ""hi"""');
});

test('serializeUsageCSV with no rows still emits a valid header-only CSV', () => {
	const out = serializeUsageCSV([]);
	assert.equal(out, USAGE_CSV_HEADERS.join(','));
	const lines = out.split('\n');
	assert.equal(lines.length, 1);
	assert.equal(lines[0].split(',').length, USAGE_CSV_HEADERS.length);
});

test('serializeUsageCSV escapes commas, newlines, and quotes in model names', () => {
	const rows = [
		{
			date: '2026-05-01',
			platform: 'claude',
			model: 'weird, "name"\nfoo',
			requests: 1,
			input_tokens: 100,
			output_tokens: 50,
			cost_usd: 0.0123,
			energy_wh: 0.5,
			carbon_gco2e: 0.25
		}
	];
	const out = serializeUsageCSV(rows);
	const lines = out.split('\n');
	assert.equal(lines.length, 2);
	assert.equal(lines[0], USAGE_CSV_HEADERS.join(','));
	assert.ok(lines[1].includes('"weird, ""name""\nfoo"'),
		`expected escaped model name, got: ${lines[1]}`);
});

test('rowsFromDailyRollups explodes per-model rows and falls back to (unknown)', () => {
	const daily = [
		{
			date: '2026-05-01',
			platform: 'claude',
			requests: 4,
			inputTokens: 1000,
			outputTokens: 500,
			estimatedCostUSD: 0.05,
			totalEnergyWh: 0.6,
			totalCarbonGco2e: 0.3,
			models: {
				'claude-3-5-sonnet': { requests: 3, inputTokens: 800, outputTokens: 400 },
				'claude-3-haiku': { requests: 1, inputTokens: 200, outputTokens: 100 }
			}
		},
		{
			date: '2026-05-02',
			platform: 'chatgpt',
			requests: 2,
			inputTokens: 500,
			outputTokens: 250,
			estimatedCostUSD: 0.01,
			models: {}
		}
	];
	const rows = rowsFromDailyRollups(daily);
	assert.equal(rows.length, 3, 'two models + one unknown row');
	const unknown = rows.find(r => r.model === '(unknown)');
	assert.ok(unknown);
	assert.equal(unknown.platform, 'chatgpt');
});

test('exportAllJSON serializer round-trips deterministically with sortKeys', () => {
	const a = {
		zeta: [3, 1, 2],
		alpha: { gamma: 1, beta: { delta: 'd', alpha: 'a' } }
	};
	const b = {
		alpha: { beta: { alpha: 'a', delta: 'd' }, gamma: 1 },
		zeta: [3, 1, 2]
	};
	const aSerialized = JSON.stringify(sortKeys(a), null, 2);
	const bSerialized = JSON.stringify(sortKeys(b), null, 2);
	assert.equal(aSerialized, bSerialized,
		'objects with the same data in a different key order must serialize identically');
	const parsed = JSON.parse(aSerialized);
	const reSerialized = JSON.stringify(sortKeys(parsed), null, 2);
	assert.equal(reSerialized, aSerialized,
		'parsing and re-serializing must yield the same text (round-trip stability)');
});

test('serializeFindingsCSV falls back gracefully when platforms / conversationUrls are missing', () => {
	const findings = [
		{
			severity: 'high',
			title: 'Overpowered model',
			detail: 'detail, with comma',
			fix: 'fix\nwith newline',
			estSavingsUSD: 1.2345,
			tag: 'model',
			status: 'new'
			// no platforms[], no conversationUrls[]
		}
	];
	const csv = serializeFindingsCSV(findings);
	const lines = csv.split('\n');
	assert.equal(lines[0], FINDINGS_CSV_HEADERS.join(','));
	assert.equal(lines.length, 2);
	// Last two cells (platforms, source_conversations) must be empty.
	assert.ok(lines[1].endsWith(','),
		'last cell should be empty when conversationUrls is missing');
});

test('serializeFindingsCSV joins platforms with + and trims conversations to first 3', () => {
	const findings = [
		{
			severity: 'medium',
			title: 'Re-asking prompts',
			detail: 'noted',
			fix: 'pin context',
			estSavingsUSD: 0.5,
			tag: 'dup',
			status: 'ongoing',
			platforms: ['claude', 'chatgpt'],
			conversationUrls: ['u1', 'u2', 'u3', 'u4']
		}
	];
	const csv = serializeFindingsCSV(findings);
	const lines = csv.split('\n');
	assert.ok(lines[1].includes('claude+chatgpt'),
		`expected platforms joined by +, got: ${lines[1]}`);
	assert.ok(lines[1].includes('u1; u2; u3') && !lines[1].includes('u4'),
		`expected first-3 conversation URLs only, got: ${lines[1]}`);
});

test('serializeFindingsCSV with empty input emits header-only output', () => {
	const csv = serializeFindingsCSV([]);
	assert.equal(csv, FINDINGS_CSV_HEADERS.join(','));
});

test('usageFilename packs both dates as YYYYMMDD', () => {
	const start = new Date(Date.UTC(2026, 4, 1));
	const end = new Date(Date.UTC(2026, 4, 14));
	assert.equal(usageFilename(start, end), 'ai-cost-usage-20260501-20260514.csv');
});

test('findingsFilename uses YYYY-MM-DD', () => {
	const d = new Date(Date.UTC(2026, 4, 14));
	assert.equal(findingsFilename(d), 'ai-cost-findings-2026-05-14.csv');
});

test('fullJsonFilename uses YYYY-MM-DD', () => {
	const d = new Date(Date.UTC(2026, 4, 14));
	assert.equal(fullJsonFilename(d), 'ai-cost-export-2026-05-14.json');
});

test('buildMonthlySummaryFromData picks top 3 models and reports findings count', () => {
	// We can't depend on CONFIG.PRICING here -- the test seeds the
	// platform-base module via storage, but PRICING comes from utils.js.
	// Use platforms with known pricing keys; if pricing is missing, model
	// rows yield zero cost (the summary still works, just with zeros).
	const dailyRollups = [
		{
			date: '2026-05-01',
			platform: 'claude',
			estimatedCostUSD: 0.5,
			models: {
				'claude-3-5-sonnet': { inputTokens: 1_000_000, outputTokens: 500_000 },
				'claude-3-haiku':   { inputTokens: 1_000_000, outputTokens: 500_000 }
			}
		}
	];
	const findings = [
		{ title: 'Low cache hit', estSavingsUSD: 2.5, severity: 'medium' },
		{ title: 'Overpowered model', estSavingsUSD: 10.0, severity: 'high' }
	];
	const summary = buildMonthlySummaryFromData({ dailyRollups, findings });
	assert.equal(summary.totalCostMTD, 0.5);
	assert.equal(summary.findingsCount, 2);
	assert.equal(summary.topFinding.title, 'Overpowered model');
	assert.ok(Array.isArray(summary.topModels));
	assert.ok(summary.topModels.length <= 3);
});

test('buildMonthlySummaryFromData handles empty input', () => {
	const summary = buildMonthlySummaryFromData({ dailyRollups: [], findings: [] });
	assert.equal(summary.totalCostMTD, 0);
	assert.equal(summary.findingsCount, 0);
	assert.equal(summary.topFinding, null);
	assert.deepEqual(summary.topModels, []);
});
