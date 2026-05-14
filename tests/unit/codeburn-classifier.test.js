// tests/unit/codeburn-classifier.test.js
// Unit tests for the codeburn-style activity classifier. Pure pattern matching, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	classifyCodeburn,
	CODEBURN_CATEGORIES,
	CATEGORY_LABELS,
	ACTIVITY_MODEL_FIT,
	getActivityModelFit
} from '../../bg-components/codeburn-classifier.js';

test('empty input classifies as conversation', () => {
	assert.equal(classifyCodeburn('').category, 'conversation');
	assert.equal(classifyCodeburn('  ').category, 'conversation');
});

test('non-string input is handled safely', () => {
	assert.equal(classifyCodeburn(null).category, 'conversation');
	assert.equal(classifyCodeburn(undefined).category, 'conversation');
});

test('code fence is a strong coding signal', () => {
	const r = classifyCodeburn('```js\nfunction add(a, b) { return a + b; }\n```');
	assert.equal(r.category, 'coding');
	assert.ok(r.confidence > 0.5);
});

test('debugging keywords beat coding when both present', () => {
	const r = classifyCodeburn('I have an error: TypeError: undefined is not a function. Debug this code.');
	assert.equal(r.category, 'debugging');
});

test('refactoring keywords route to refactoring', () => {
	const r = classifyCodeburn('Refactor this function to be cleaner and simpler');
	assert.equal(r.category, 'refactoring');
});

test('testing keywords route to testing', () => {
	const r = classifyCodeburn('Write unit tests for this function with assertions');
	assert.ok(r.category === 'testing' || r.category === 'coding');
});

test('planning prompts route to planning', () => {
	const r = classifyCodeburn('Help me design the architecture and plan the rollout strategy');
	assert.ok(['planning', 'exploration'].includes(r.category), `got ${r.category}`);
});

test('git ops prompts route to git_ops', () => {
	const r = classifyCodeburn('Help me write a git commit message for this diff');
	assert.ok(['git_ops', 'coding'].includes(r.category), `got ${r.category}`);
});

test('retry signal in context boosts debugging', () => {
	const r = classifyCodeburn('try again', { isRetry: true });
	assert.equal(r.category, 'debugging');
});

test('short prompts with no signal default to conversation, not general', () => {
	const r = classifyCodeburn('hello there');
	assert.equal(r.category, 'conversation');
});

test('longer prompts without coding/debugging signals fall through to general or conversation', () => {
	const r = classifyCodeburn('The weather is nice today and I am sitting on my porch enjoying the breeze and watching the birds fly past.');
	// Either is acceptable: this prompt has no engineering signals, so it
	// should land in the casual-talk side of the taxonomy, not coding/debugging.
	assert.ok(['general', 'conversation', 'brainstorming'].includes(r.category), `got ${r.category}`);
});

test('confidence is bounded between 0 and 1', () => {
	const samples = [
		'',
		'hello',
		'```js\nfn()\n```',
		'fix this bug error throws exception traceback',
		'refactor rename simplify clean up restructure decouple',
		'The quick brown fox jumps over the lazy dog'
	];
	for (const s of samples) {
		const r = classifyCodeburn(s);
		assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence ${r.confidence} out of bounds for "${s}"`);
	}
});

test('every category has a label', () => {
	for (const c of CODEBURN_CATEGORIES) {
		assert.ok(CATEGORY_LABELS[c], `missing label for ${c}`);
	}
});

test('every category has an ACTIVITY_MODEL_FIT row', () => {
	for (const c of CODEBURN_CATEGORIES) {
		const fit = ACTIVITY_MODEL_FIT[c];
		assert.ok(fit, `missing fit for ${c}`);
		assert.ok(typeof fit.cheap === 'number');
		assert.ok(typeof fit.medium === 'number');
		assert.ok(typeof fit.expensive === 'number');
	}
});

test('getActivityModelFit returns general row for unknown category', () => {
	const fit = getActivityModelFit('made_up_category');
	assert.deepEqual(fit, ACTIVITY_MODEL_FIT.general);
});

test('conversation fit prefers cheap models, coding prefers stronger', () => {
	const conv = ACTIVITY_MODEL_FIT.conversation;
	const code = ACTIVITY_MODEL_FIT.coding;
	assert.ok(conv.cheap > conv.expensive, 'conversation should favor cheap models');
	assert.ok(code.expensive > code.cheap, 'coding should favor stronger models');
});
