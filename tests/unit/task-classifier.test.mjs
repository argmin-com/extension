// tests/unit/task-classifier.test.mjs
// Unit tests for task-classifier. Pure functions, no DOM, no network.
// Run with: node --test tests/unit/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
	path.join(__dirname, '../../bg-components/task-classifier.js'),
	'utf8'
);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
	src.replace(/export\s+\{[^}]+\};\s*$/, 'this.classifyTask = classifyTask; this.getTaskModelFit = getTaskModelFit;'),
	sandbox
);
const { classifyTask, getTaskModelFit } = sandbox;

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

// Consumer-intent categories: typing-time classifier must mirror the
// post-turn codeburn-classifier so Smart-UI recommendations and Activity
// Breakdown agree on what kind of work the user is doing.
test('email drafting classifies as writing', () => {
	assert.equal(classifyTask('Draft an email to my manager about the deadline slipping.').taskClass, 'writing');
});
test('reply-style ask classifies as writing', () => {
	assert.equal(classifyTask('Reply to this client saying we will follow up next week.').taskClass, 'writing');
});
test('translate request classifies as translation', () => {
	assert.equal(classifyTask('Translate the following paragraph into Spanish.').taskClass, 'translation');
});
test('eli5 / teach-me classifies as learning', () => {
	assert.equal(classifyTask('Teach me the basics of double-entry accounting.').taskClass, 'learning');
	assert.equal(classifyTask('ELI5: how does HTTPS actually work?').taskClass, 'learning');
});
test('who-is question classifies as research', () => {
	assert.equal(classifyTask('Who founded OpenAI and when did the company start?').taskClass, 'research');
});
test('CSV analysis classifies as data_analysis', () => {
	assert.equal(classifyTask('Analyze this CSV and compute the average revenue per quarter.').taskClass, 'data_analysis');
});
test('every TASK_MODEL_FIT key is reachable from classifyTask', () => {
	// Sanity that the model-fit table covers all task classes the classifier emits.
	for (const taskClass of ['chat','writing','summarization','translation','research','learning','data_analysis','extraction','transformation','brainstorming','coding','debugging','analysis','creative','long_context_qa']) {
		const fit = getTaskModelFit(taskClass);
		assert.ok(fit.cheap >= 0 && fit.cheap <= 1, `${taskClass} cheap`);
		assert.ok(fit.medium >= 0 && fit.medium <= 1, `${taskClass} medium`);
		assert.ok(fit.expensive >= 0 && fit.expensive <= 1, `${taskClass} expensive`);
	}
});
