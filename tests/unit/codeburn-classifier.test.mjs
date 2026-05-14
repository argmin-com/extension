// tests/unit/codeburn-classifier.test.mjs
// Unit tests for codeburn-classifier. Pure functions, no DOM, no network.
// Source is loaded into a vm sandbox with exports stripped, matching the
// pattern in task-classifier.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
	path.join(__dirname, '../../bg-components/codeburn-classifier.js'),
	'utf8'
);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
	src.replace(/export\s+\{[\s\S]+?\};\s*$/, 'this.classifyCodeburn = classifyCodeburn; this.CODEBURN_CATEGORIES = CODEBURN_CATEGORIES; this.CATEGORY_LABELS = CATEGORY_LABELS; this.ACTIVITY_MODEL_FIT = ACTIVITY_MODEL_FIT;'),
	sandbox
);
const { classifyCodeburn, CODEBURN_CATEGORIES, CATEGORY_LABELS, ACTIVITY_MODEL_FIT } = sandbox;

test('email drafting classifies as writing', () => {
	const r = classifyCodeburn('Draft an email to my manager about the deadline slipping.');
	assert.equal(r.category, 'writing', `got ${r.category}`);
});

test('reply-style asks classify as writing', () => {
	const r = classifyCodeburn('Reply to this client saying we will follow up next week.');
	assert.equal(r.category, 'writing');
});

test('tldr-style asks classify as summarization', () => {
	assert.equal(classifyCodeburn('Summarize the key points of this article.').category, 'summarization');
	assert.equal(classifyCodeburn('TL;DR this 20-page contract for me.').category, 'summarization');
});

test('translate request classifies as translation', () => {
	const r = classifyCodeburn('Translate the following paragraph into Spanish.');
	assert.equal(r.category, 'translation');
});

test('language-target phrasing classifies as translation', () => {
	const r = classifyCodeburn('Can you rephrase this in French so it sounds natural?');
	assert.equal(r.category, 'translation');
});

test('research / who-is questions classify as research', () => {
	const r = classifyCodeburn('Who founded OpenAI and when did the company start?');
	assert.equal(r.category, 'research');
});

test('eli5 / teach-me classifies as learning', () => {
	assert.equal(classifyCodeburn('Teach me the basics of double-entry accounting.').category, 'learning');
	assert.equal(classifyCodeburn('ELI5: how does HTTPS actually work?').category, 'learning');
});

test('poem / story requests classify as creative', () => {
	assert.equal(classifyCodeburn('Write me a haiku about morning coffee.').category, 'creative');
	assert.equal(classifyCodeburn('Draft a short story about a lost dog finding its way home.').category, 'creative');
});

test('CSV / dataset analysis classifies as data_analysis', () => {
	const r = classifyCodeburn('Analyze this CSV: compute the average revenue per quarter.');
	assert.equal(r.category, 'data_analysis');
});

test('SQL phrasing classifies as data_analysis', () => {
	const r = classifyCodeburn('Write a query: SELECT user_id, COUNT(*) FROM orders GROUP BY user_id');
	// SQL keywords + select/group-by patterns; coding can also match via code fences,
	// so accept either since the prompt is ambiguous.
	assert.ok(['data_analysis', 'coding'].includes(r.category), `got ${r.category}`);
});

test('debugging still wins over writing when both keywords appear', () => {
	const r = classifyCodeburn('There is a TypeError in this function — fix the bug and explain why.');
	assert.ok(['debugging', 'coding'].includes(r.category), `got ${r.category}`);
});

test('coding still wins when prompt is fenced code', () => {
	const r = classifyCodeburn('Make this work:\n```js\nfunction foo(){ return 1; }\n```');
	assert.equal(r.category, 'coding');
});

test('all categories have labels and model-fit entries', () => {
	for (const cat of CODEBURN_CATEGORIES) {
		assert.ok(CATEGORY_LABELS[cat], `missing label for ${cat}`);
		assert.ok(ACTIVITY_MODEL_FIT[cat], `missing model-fit for ${cat}`);
	}
});

// ----- Multilingual coverage -----
test('French email drafting classifies as writing', () => {
	const r = classifyCodeburn('Rédiger un courriel à mon manager');
	assert.equal(r.category, 'writing');
});
test('Spanish email drafting classifies as writing', () => {
	const r = classifyCodeburn('Redactar un correo electrónico al cliente');
	assert.equal(r.category, 'writing');
});
test('German email drafting classifies as writing', () => {
	const r = classifyCodeburn('Verfassen Sie einen E-Mail-Entwurf an den Manager');
	assert.equal(r.category, 'writing');
});
test('Japanese email drafting classifies as writing', () => {
	const r = classifyCodeburn('上司にメールを書いてください');
	assert.equal(r.category, 'writing');
});
test('French summarize classifies as summarization', () => {
	const r = classifyCodeburn('Résumer cet article en trois points');
	assert.equal(r.category, 'summarization');
});
test('German summarize classifies as summarization', () => {
	const r = classifyCodeburn('Zusammenfassen Sie diesen Bericht in drei Punkten');
	assert.equal(r.category, 'summarization');
});
test('Japanese summarize classifies as summarization', () => {
	const r = classifyCodeburn('この記事を要約してください');
	assert.equal(r.category, 'summarization');
});
test('French translate classifies as translation', () => {
	const r = classifyCodeburn('Traduire le texte suivant en anglais');
	assert.equal(r.category, 'translation');
});
test('Spanish translate classifies as translation', () => {
	const r = classifyCodeburn('Traducir esta frase al inglés');
	assert.equal(r.category, 'translation');
});
test('Japanese translate classifies as translation', () => {
	const r = classifyCodeburn('翻訳してください');
	assert.equal(r.category, 'translation');
});
test('Korean translate classifies as translation', () => {
	const r = classifyCodeburn('이 문장을 영어로 번역해 주세요');
	assert.equal(r.category, 'translation');
});
test('French debugging classifies as debugging', () => {
	const r = classifyCodeburn('Corriger ce bug qui plante le serveur');
	assert.equal(r.category, 'debugging');
});

test('classifier returns confidence between 0 and 1 for new categories', () => {
	const cases = [
		'Draft a thank-you email',
		'Summarize this report',
		'Translate to German',
		'Tell me about the Renaissance',
		'Teach me Bayesian inference',
		'Write a poem about rain',
		'Analyze this dataset and find the median'
	];
	for (const prompt of cases) {
		const r = classifyCodeburn(prompt);
		assert.ok(r.confidence >= 0 && r.confidence <= 1, `${prompt}: ${r.confidence}`);
	}
});
