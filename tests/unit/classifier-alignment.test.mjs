// tests/unit/classifier-alignment.test.mjs
// task-classifier (typing-time) and codeburn-classifier (post-turn)
// both classify user prompts into activity categories. They have
// independent scoring schemes but are expected to AGREE on the primary
// category for a representative set of consumer + developer prompts.
// When they diverge, the Smart-UI cost-preview and the Activity
// Breakdown contradict each other -- the user sees one category at
// type-time and a different one in the after-turn rollup. This test
// is a regression guard that catches drift between the two without
// forcing a refactor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadTaskClassifier() {
	const src = fs.readFileSync(
		path.join(__dirname, '../../bg-components/task-classifier.js'),
		'utf8'
	);
	const sandbox = {};
	vm.createContext(sandbox);
	vm.runInContext(
		src.replace(/export\s+\{[^}]+\};\s*$/, 'this.classifyTask = classifyTask;'),
		sandbox
	);
	return sandbox.classifyTask;
}

function loadCodeburnClassifier() {
	const src = fs.readFileSync(
		path.join(__dirname, '../../bg-components/codeburn-classifier.js'),
		'utf8'
	);
	const sandbox = {};
	vm.createContext(sandbox);
	vm.runInContext(
		src.replace(/export\s+\{[\s\S]+?\};\s*$/, 'this.classifyCodeburn = classifyCodeburn;'),
		sandbox
	);
	return sandbox.classifyCodeburn;
}

const classifyTask = loadTaskClassifier();
const classifyCodeburn = loadCodeburnClassifier();

// Each row is [prompt, expected-category]. The category names are
// shared between the two classifiers (we added consumer categories to
// both in the same release). The two scoring schemes can disagree on
// secondary categories but must agree on the top one.
const ALIGNMENT_CASES = [
	['Draft an email to my manager about the slip', 'writing'],
	['Reply to this client politely', 'writing'],
	['Summarize this article in three bullet points', 'summarization'],
	['TL;DR this 30-page contract', 'summarization'],
	['Translate the following paragraph into Spanish', 'translation'],
	['Translate to German', 'translation'],
	['Who founded OpenAI and when did the company start?', 'research'],
	['Teach me the basics of double-entry accounting', 'learning'],
	['ELI5 how HTTPS works', 'learning'],
	['Write me a haiku about morning coffee', 'creative'],
	['Analyze this CSV: compute the average revenue per quarter', 'data_analysis']
];

for (const [prompt, expected] of ALIGNMENT_CASES) {
	test(`alignment: "${prompt.slice(0, 60)}"`, () => {
		const task = classifyTask(prompt);
		const burn = classifyCodeburn(prompt);
		// task-classifier returns { taskClass }, codeburn returns { category }
		const taskCat = task.taskClass;
		const burnCat = burn.category;
		assert.equal(taskCat, expected, `task-classifier got ${taskCat} expected ${expected}`);
		assert.equal(burnCat, expected, `codeburn-classifier got ${burnCat} expected ${expected}`);
	});
}

test('both classifiers expose a confidence between 0 and 1', () => {
	for (const [prompt] of ALIGNMENT_CASES) {
		const task = classifyTask(prompt);
		const burn = classifyCodeburn(prompt);
		assert.ok(task.confidence >= 0 && task.confidence <= 1);
		assert.ok(burn.confidence >= 0 && burn.confidence <= 1);
	}
});
