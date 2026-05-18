// tests/unit/context-bloat.test.mjs
// Pure-function analyser: a session is "bloated" when the running input-
// token max is over a threshold AND recent per-turn deltas are tiny
// relative to that max. Both conditions are needed -- a long session
// where the user is still adding substantial new content is fine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyseContextBloat } from '../../bg-components/context-bloat.js';

test('returns not-bloated when no turns', () => {
	const r = analyseContextBloat([]);
	assert.equal(r.bloated, false);
	assert.equal(r.reason, null);
});

test('returns not-bloated when fewer than minTurns', () => {
	const r = analyseContextBloat([
		{ ts: 1, inputTokens: 50000 },
		{ ts: 2, inputTokens: 51000 }
	]);
	assert.equal(r.bloated, false);
});

test('returns not-bloated when sessionTokens below threshold even with low deltas', () => {
	const turns = [
		{ ts: 1, inputTokens: 1000 },
		{ ts: 2, inputTokens: 1010 },
		{ ts: 3, inputTokens: 1020 },
		{ ts: 4, inputTokens: 1030 }
	];
	const r = analyseContextBloat(turns);
	assert.equal(r.bloated, false);
	assert.equal(r.sessionTokens, 1030);
});

test('flags bloat when sessionTokens over threshold AND deltas tiny', () => {
	// 35k context with last 3 turns each adding <500 tokens (<2%).
	const turns = [
		{ ts: 1, inputTokens: 30000 },
		{ ts: 2, inputTokens: 35000 },
		{ ts: 3, inputTokens: 35200 },
		{ ts: 4, inputTokens: 35400 },
		{ ts: 5, inputTokens: 35600 }
	];
	const r = analyseContextBloat(turns);
	assert.equal(r.bloated, true);
	assert.ok(r.reason && r.reason.includes('new chat'));
	assert.ok(r.sessionTokens >= 35000);
	assert.ok(r.recentDeltaRatio < 0.05);
});

test('NOT bloated when context is large but user is still adding substance', () => {
	// Large session AND user is doubling the prompt each turn -- not bloat.
	const turns = [
		{ ts: 1, inputTokens: 30000 },
		{ ts: 2, inputTokens: 32000 },
		{ ts: 3, inputTokens: 38000 },
		{ ts: 4, inputTokens: 48000 },
		{ ts: 5, inputTokens: 60000 }
	];
	const r = analyseContextBloat(turns);
	assert.equal(r.bloated, false, `unexpected bloat; ratio=${r.recentDeltaRatio}`);
});

test('handles unsorted input', () => {
	const turns = [
		{ ts: 5, inputTokens: 35600 },
		{ ts: 1, inputTokens: 30000 },
		{ ts: 3, inputTokens: 35200 },
		{ ts: 2, inputTokens: 35000 },
		{ ts: 4, inputTokens: 35400 }
	];
	const r = analyseContextBloat(turns);
	assert.equal(r.bloated, true);
});

test('skips malformed turn rows', () => {
	const turns = [
		null,
		{ ts: 1, inputTokens: 35000 },
		{ ts: 2 },               // missing inputTokens
		{ ts: 3, inputTokens: 35100 },
		{ ts: 4, inputTokens: 35200 },
		{ ts: 5, inputTokens: 35300 }
	];
	const r = analyseContextBloat(turns);
	// Valid rows are 35000/35100/35200/35300 -- four turns, max 35300,
	// deltas ~100 each (0.3% of total). Bloat threshold met.
	assert.equal(r.bloated, true);
});

test('respects custom threshold and lookback', () => {
	const turns = [
		{ ts: 1, inputTokens: 5000 },
		{ ts: 2, inputTokens: 5100 },
		{ ts: 3, inputTokens: 5200 },
		{ ts: 4, inputTokens: 5300 }
	];
	// Default 30k threshold -> not bloated. Override to 4k -> bloated.
	assert.equal(analyseContextBloat(turns).bloated, false);
	assert.equal(analyseContextBloat(turns, { thresholdTokens: 4000 }).bloated, true);
});
