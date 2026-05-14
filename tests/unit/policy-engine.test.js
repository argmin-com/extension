// tests/unit/policy-engine.test.js
// Unit tests for the policy engine. Pure function, no DOM, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePolicy, ACTION_CLASSES } from '../../bg-components/policy-engine.js';

test('typing phase with low cost yields silent pass', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.001, inputTokens: 50 },
		phase: 'typing'
	});
	assert.equal(r.action, ACTION_CLASSES.SILENT_PASS);
	assert.equal(r.priority, 'none');
});

test('typing phase with savings + budget pressure shows passive hint', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.05, inputTokens: 500 },
		recommendations: [{ savingsPct: 50, qualityRisk: 'low' }],
		budgetState: { dailyConsumedPct: 60 },
		phase: 'typing'
	});
	assert.equal(r.action, ACTION_CLASSES.PASSIVE_HINT);
});

test('pre_send: long prompt + savings + budget pressure suggests rewrite-first', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.15, inputTokens: 5000 },
		recommendations: [{ savingsPct: 35, qualityRisk: 'low' }],
		budgetState: { dailyConsumedPct: 65 },
		taskClass: { taskClass: 'analysis' },
		phase: 'pre_send'
	});
	assert.equal(r.action, ACTION_CLASSES.REWRITE_FIRST);
	assert.equal(r.priority, 'medium');
});

test('rewrite-first is not triggered for coding tasks (code is not redundant)', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.15, inputTokens: 5000 },
		recommendations: [{ savingsPct: 35, qualityRisk: 'low' }],
		budgetState: { dailyConsumedPct: 65 },
		taskClass: { taskClass: 'coding' },
		phase: 'pre_send'
	});
	assert.notEqual(r.action, ACTION_CLASSES.REWRITE_FIRST);
});

test('budget nearly exhausted + expensive request gates with confirmation', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.10, inputTokens: 1000 },
		recommendations: [],
		budgetState: { dailyConsumedPct: 95 },
		phase: 'pre_send'
	});
	assert.equal(r.action, ACTION_CLASSES.CONFIRMATION_GATE);
	assert.equal(r.reasonCode, 'budget_nearly_exhausted');
});

test('high rate-limit risk gates with confirmation', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.02, inputTokens: 500 },
		rateLimitState: { risk: 'high' },
		phase: 'pre_send'
	});
	assert.equal(r.action, ACTION_CLASSES.CONFIRMATION_GATE);
	assert.equal(r.reasonCode, 'rate_limit_danger');
});

test('user fatigue downshifts inline recommendation to passive hint', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.03, inputTokens: 500 },
		recommendations: [{ savingsPct: 50, qualityRisk: 'low' }],
		userProfile: { suggestionFatigueScore: 0.7, recentDismissals: 4 },
		phase: 'pre_send'
	});
	assert.equal(r.action, ACTION_CLASSES.PASSIVE_HINT);
	assert.equal(r.reasonCode, 'savings_available_but_user_fatigued');
});

test('large savings with budget pressure produces medium-priority inline recommendation', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.08, inputTokens: 1000 },
		recommendations: [{ savingsPct: 50, qualityRisk: 'low' }],
		budgetState: { dailyConsumedPct: 75 },
		phase: 'pre_send'
	});
	assert.equal(r.action, ACTION_CLASSES.INLINE_RECOMMENDATION);
	assert.equal(r.priority, 'medium');
});

test('moderate savings produces passive hint at low priority', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.03, inputTokens: 500 },
		recommendations: [{ savingsPct: 25, qualityRisk: 'low' }],
		phase: 'pre_send'
	});
	assert.equal(r.action, ACTION_CLASSES.PASSIVE_HINT);
	assert.equal(r.priority, 'low');
});

test('no signals defaults to silent pass at pre_send', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.005, inputTokens: 100 },
		phase: 'pre_send'
	});
	assert.equal(r.action, ACTION_CLASSES.SILENT_PASS);
});

test('every result includes action, reasonCode, priority', () => {
	const cases = [
		{ phase: 'typing', estimates: {} },
		{ phase: 'pre_send', estimates: { costEstimateUSD: 0.05 }, recommendations: [{ savingsPct: 60, qualityRisk: 'low' }] },
		{ phase: 'pre_send', rateLimitState: { risk: 'high' } }
	];
	for (const c of cases) {
		const r = resolvePolicy(c);
		assert.ok(r.action);
		assert.ok(r.reasonCode);
		assert.ok(r.priority);
	}
});

test('high quality risk on the only recommendation does not produce inline recommendation', () => {
	const r = resolvePolicy({
		estimates: { costEstimateUSD: 0.10, inputTokens: 500 },
		recommendations: [{ savingsPct: 60, qualityRisk: 'high' }],
		budgetState: { dailyConsumedPct: 75 },
		phase: 'pre_send'
	});
	assert.notEqual(r.action, ACTION_CLASSES.INLINE_RECOMMENDATION);
});
