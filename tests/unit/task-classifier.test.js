// tests/unit/task-classifier.test.js
// Unit tests for task-classifier. Pure functions, no DOM, no network.
// Run with: node --test tests/unit/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, getTaskModelFit } from '../../bg-components/task-classifier.js';

test('empty / very short prompts classify as chat', () => {
	assert.equal(classifyTask('').taskClass, 'chat');
	assert.equal(classifyTask('hi').taskClass, 'chat');
});

test('code fences strongly imply coding', () => {
	const result = classifyTask('Help me with this:\n```js\nfunction foo() { return 1; }\n```');
	assert.equal(result.taskClass, 'coding');
	assert.ok(result.confidence > 0.5, `confidence ${result.confidence} should be > 0.5`);
});

test('summarization keywords classify as summarization', () => {
	assert.equal(classifyTask('Please summarize the key points of this document').taskClass, 'summarization');
});

test('debugging keywords classify as debugging or coding', () => {
	const r = classifyTask('I have a TypeError: undefined is not a function. Help me fix this bug.');
	assert.ok(r.taskClass === 'debugging' || r.taskClass === 'coding', `got ${r.taskClass}`);
});

test('analysis keywords classify as analysis', () => {
	assert.equal(classifyTask('Analyze the tradeoff between these two designs').taskClass, 'analysis');
});

test('long quoted content boosts long_context_qa or summarization', () => {
	const longText = 'Q: What does this say?\n```' + 'lorem ipsum '.repeat(300) + '```';
	const r = classifyTask(longText);
	assert.ok(['long_context_qa', 'summarization', 'coding'].includes(r.taskClass), `got ${r.taskClass}`);
});

test('confidence is between 0 and 1', () => {
	for (const prompt of ['', 'hello', 'summarize this', 'function foo() {}', 'analyze the tradeoffs']) {
		const r = classifyTask(prompt);
		assert.ok(r.confidence >= 0 && r.confidence <= 1, `${prompt} -> ${r.confidence}`);
	}
});

test('signals array is bounded to <= 8 entries', () => {
	const r = classifyTask('summarize analyze compare evaluate review extract identify list all find pull');
	assert.ok(r.signals.length <= 8);
});

test('getTaskModelFit returns chat fit for unknown task class', () => {
	const fit = getTaskModelFit('does_not_exist');
	assert.deepEqual(fit, getTaskModelFit('chat'));
});

test('getTaskModelFit values sum reasonably for each tier', () => {
	for (const taskClass of Object.keys({chat:1, summarization:1, coding:1, analysis:1})) {
		const fit = getTaskModelFit(taskClass);
		assert.ok(fit.cheap >= 0 && fit.cheap <= 1);
		assert.ok(fit.medium >= 0 && fit.medium <= 1);
		assert.ok(fit.expensive >= 0 && fit.expensive <= 1);
	}
});
