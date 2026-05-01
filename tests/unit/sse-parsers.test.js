// tests/unit/sse-parsers.test.js
// Unit tests for the SSE parsers in injections/stream-token-counter.js.
// The parsers live inside the injection's IIFE, so we extract them via a
// Node vm sandbox: source the file, find the `const parsers = { ... };`
// block, and evaluate just that block. This means the tests track the
// shipping parsers exactly without requiring a refactor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
	path.join(__dirname, '../../injections/stream-token-counter.js'),
	'utf8'
);

function extractParsers() {
	const start = src.indexOf('const parsers = {');
	assert.ok(start !== -1, 'parsers block not found in injection source');
	// Find the matching closing brace + semicolon.
	let depth = 0;
	let i = start + 'const parsers = '.length;
	for (; i < src.length; i++) {
		const ch = src[i];
		if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) { i++; break; }
		}
	}
	const block = src.slice(start, i) + ';';
	// The parsers reference a helper `extractTextFromGeminiArray`. Pull it out.
	const helperStart = src.indexOf('function extractTextFromGeminiArray');
	assert.ok(helperStart !== -1);
	const helperEnd = src.indexOf('\n\t}\n', helperStart) + 4;
	const helperSrc = src.slice(helperStart, helperEnd);

	const sandbox = {};
	vm.createContext(sandbox);
	vm.runInContext(helperSrc + '\n' + block + '\nthis.parsers = parsers;', sandbox);
	return sandbox.parsers;
}

const parsers = extractParsers();

test('claude parser handles text_delta', () => {
	const out = parsers.claude({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } });
	assert.equal(out, 'hello');
});

test('claude parser handles thinking_delta', () => {
	const out = parsers.claude({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'pondering' } });
	assert.equal(out, 'pondering');
});

test('claude parser falls back to legacy completion field', () => {
	assert.equal(parsers.claude({ completion: 'legacy text' }), 'legacy text');
});

test('claude parser returns null for unknown shapes', () => {
	assert.equal(parsers.claude({ type: 'message_start' }), null);
});

test('chatgpt parser handles OpenAI delta.content', () => {
	const out = parsers.chatgpt({ choices: [{ delta: { content: 'hello' } }] });
	assert.equal(out, 'hello');
});

test('chatgpt parser handles reasoning delta', () => {
	const out = parsers.chatgpt({ choices: [{ delta: { reasoning: 'thinking...' } }] });
	assert.equal(out, 'thinking...');
});

test('chatgpt parser handles raw v string', () => {
	assert.equal(parsers.chatgpt({ v: 'streaming text' }), 'streaming text');
});

test('chatgpt parser handles message.content.parts', () => {
	const out = parsers.chatgpt({ message: { content: { parts: ['hello ', 'world'] } } });
	assert.equal(out, 'hello world');
});

test('chatgpt parser ignores non-string parts', () => {
	const out = parsers.chatgpt({ message: { content: { parts: ['hello', { x: 1 }, ' world'] } } });
	assert.equal(out, 'hello world');
});

test('chatgpt parser returns null for unknown shapes', () => {
	assert.equal(parsers.chatgpt({ unrelated: true }), null);
});

test('gemini parser handles candidates[].content.parts[].text', () => {
	const out = parsers.gemini({ candidates: [{ content: { parts: [{ text: 'hello' }, { text: ' world' }] } }] });
	assert.equal(out, 'hello world');
});

test('gemini parser handles singular candidate fallback', () => {
	const out = parsers.gemini({ candidate: { content: { parts: [{ text: 'hi' }] } } });
	assert.equal(out, 'hi');
});

test('gemini parser handles textChunk fallback', () => {
	assert.equal(parsers.gemini({ textChunk: 'chunk' }), 'chunk');
});

test('gemini parser handles delta.text fallback', () => {
	assert.equal(parsers.gemini({ delta: { text: 'foo' } }), 'foo');
});

test('gemini parser walks nested string arrays', () => {
	const out = parsers.gemini([['header', ['inner text more than 2 chars']]]);
	assert.match(out, /inner text more than 2 chars/);
});

test('mistral parser handles OpenAI-style delta.content', () => {
	const out = parsers.mistral({ choices: [{ delta: { content: 'hello' } }] });
	assert.equal(out, 'hello');
});

test('mistral parser returns null for unknown shapes', () => {
	assert.equal(parsers.mistral({ unrelated: true }), null);
});
