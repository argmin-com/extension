// tests/unit/daily-digest.test.mjs
// Verifies the digest's gating logic: enablement, hour-of-day, dedup by
// dayKey, and "no activity → no notification" behaviour. We import the
// module under an in-memory chrome/browser shim so storage round-trips
// work without a real extension context.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const storageData = {};
async function storageGet(keys) {
	if (keys == null) return JSON.parse(JSON.stringify(storageData));
	if (typeof keys === 'string') return { [keys]: storageData[keys] };
	if (Array.isArray(keys)) {
		const out = {};
		for (const k of keys) out[k] = storageData[k];
		return out;
	}
	const out = {};
	for (const [k, def] of Object.entries(keys || {})) {
		out[k] = Object.prototype.hasOwnProperty.call(storageData, k) ? storageData[k] : def;
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

const { evaluateDailyDigest, markDigestFired, dayKey } = await import('../../bg-components/daily-digest.js');

function reset() {
	for (const k of Object.keys(storageData)) delete storageData[k];
}

test('dayKey produces stable yyyy-mm-dd', () => {
	const k = dayKey(new Date('2026-05-18T15:00:00Z'));
	// dayKey uses local time; assert format only.
	assert.match(k, /^\d{4}-\d{2}-\d{2}$/);
});

test('skips when disabled', async () => {
	reset();
	const r = await evaluateDailyDigest(new Date());
	assert.equal(r.fire, false);
	assert.equal(r.reason, 'disabled');
});

test('skips when too early (before configured hour)', async () => {
	reset();
	await storageSet({ dailyDigestEnabled: true, dailyDigestHour: 23 });
	const morning = new Date();
	morning.setHours(8);
	const r = await evaluateDailyDigest(morning);
	assert.equal(r.fire, false);
	assert.equal(r.reason, 'too_early');
});

test('skips when already fired today (idempotent)', async () => {
	reset();
	const now = new Date();
	now.setHours(20);
	await storageSet({
		dailyDigestEnabled: true,
		dailyDigestHour: 18,
		'dailyDigest:lastFiredDayKey': dayKey(now)
	});
	const r = await evaluateDailyDigest(now);
	assert.equal(r.fire, false);
	assert.equal(r.reason, 'already_fired_today');
});

test('skips when no activity today (avoids empty notifications)', async () => {
	reset();
	const now = new Date();
	now.setHours(20);
	await storageSet({ dailyDigestEnabled: true, dailyDigestHour: 18 });
	// No platformUsageToday:* keys -> evaluator returns no_activity_today.
	const r = await evaluateDailyDigest(now);
	assert.equal(r.fire, false);
	assert.equal(r.reason, 'no_activity_today');
});

test('markDigestFired records the dayKey for dedup', async () => {
	reset();
	const today = dayKey();
	await markDigestFired(today);
	const stored = (await storageGet('dailyDigest:lastFiredDayKey'))['dailyDigest:lastFiredDayKey'];
	assert.equal(stored, today);
});
