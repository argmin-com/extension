// tests/unit/request-body-and-error-helpers.test.mjs
// Coverage for the small pure helpers added to make body-parse warnings
// informative and to suppress repeated "context lost" errors. Lifts the
// functions out of background.js and content_utils.js with a textual
// sandbox so the production code does not need to add exports for tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function extractFunctionSource(src, functionName) {
	const start = src.indexOf(`async function ${functionName}(`);
	assert.notEqual(start, -1, `could not find ${functionName} source`);
	const bodyStart = src.indexOf('{', start);
	assert.notEqual(bodyStart, -1, `could not find ${functionName} body`);
	let depth = 0;
	for (let i = bodyStart; i < src.length; i += 1) {
		if (src[i] === '{') depth += 1;
		if (src[i] === '}') {
			depth -= 1;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	assert.fail(`could not extract complete ${functionName} source`);
}

// ---------- summarizeRequestBody + parseRequestBody ----------
{
	const bgSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
	// Pull both functions out of the source as standalone declarations
	// by isolating them with regex slices and evaluating in a sandbox.
	const summarizeSrc = bgSrc.match(/function summarizeRequestBody\([\s\S]+?\n}\n/)?.[0];
	const parseSrc = bgSrc.match(/async function parseRequestBody\([\s\S]+?\n}\n/)?.[0];
	const nonInferenceLine = bgSrc.match(/const NON_INFERENCE_PATH_RE\s*=[^;]+;/)?.[0];
	assert.ok(summarizeSrc, 'could not find summarizeRequestBody source');
	assert.ok(parseSrc, 'could not find parseRequestBody source');
	assert.ok(nonInferenceLine, 'could not find NON_INFERENCE_PATH_RE constant');

	const sandbox = {
		TextDecoder: globalThis.TextDecoder,
		URLSearchParams: globalThis.URLSearchParams,
		JSON, Object, String, Array, Boolean, Number,
		ArrayBuffer: globalThis.ArrayBuffer
	};
	vm.createContext(sandbox);
	vm.runInContext(
		`${nonInferenceLine}\n${summarizeSrc}\n${parseSrc}\n; this.summarizeRequestBody = summarizeRequestBody; this.parseRequestBody = parseRequestBody; this.NON_INFERENCE_PATH_RE = NON_INFERENCE_PATH_RE;`,
		sandbox
	);

	const { summarizeRequestBody, parseRequestBody, NON_INFERENCE_PATH_RE } = sandbox;

	test('summarizeRequestBody: missing body', () => {
		assert.equal(summarizeRequestBody(null).looksLike, 'missing');
		assert.equal(summarizeRequestBody(undefined).looksLike, 'missing');
	});
	test('summarizeRequestBody: empty raw + no formData', () => {
		const s = summarizeRequestBody({ raw: [] });
		assert.equal(s.looksLike, 'empty');
	});
	test('summarizeRequestBody: json-text body', () => {
		const s = summarizeRequestBody({ raw: [{ bytes: '{"messages":[]}' }] });
		assert.equal(s.looksLike, 'json-text');
		assert.equal(s.rawByteLength, 15);
	});
	test('summarizeRequestBody: urlencoded body', () => {
		const s = summarizeRequestBody({ raw: [{ bytes: 'q=hello&model=gpt-4o' }] });
		assert.equal(s.looksLike, 'urlencoded');
	});
	test('summarizeRequestBody: multipart body', () => {
		const s = summarizeRequestBody({ raw: [{ bytes: '--boundary\r\nContent-Disposition: form-data;' }] });
		assert.equal(s.looksLike, 'multipart');
	});
	test('summarizeRequestBody: formData path', () => {
		const s = summarizeRequestBody({ formData: { foo: ['bar'] } });
		assert.equal(s.hasFormData, true);
		assert.equal(s.looksLike, 'form-data');
	});

	test('parseRequestBody: webRequest formData unwraps single-element arrays', async () => {
		const out = await parseRequestBody({ formData: { conversation_id: ['abc-123'], items: ['one', 'two'] } });
		assert.equal(out.conversation_id, 'abc-123');
		assert.deepEqual(out.items, ['one', 'two']);
	});

	test('parseRequestBody: fromMonkeypatch JSON path', async () => {
		const out = await parseRequestBody({ fromMonkeypatch: true, raw: [{ bytes: '{"model":"gpt-4o"}' }] });
		assert.equal(out.model, 'gpt-4o');
	});

	test('parseRequestBody: fromMonkeypatch urlencoded fallback', async () => {
		const out = await parseRequestBody({ fromMonkeypatch: true, raw: [{ bytes: 'a=1&b=hello' }] });
		assert.equal(out.a, '1');
		assert.equal(out.b, 'hello');
	});

	test('NON_INFERENCE_PATH_RE matches ces, sentinel, files', () => {
		assert.ok(NON_INFERENCE_PATH_RE.test('/ces/v1/foo'));
		assert.ok(NON_INFERENCE_PATH_RE.test('/sentinel/health'));
		assert.ok(NON_INFERENCE_PATH_RE.test('/backend-api/files'));
		assert.ok(!NON_INFERENCE_PATH_RE.test('/backend-api/conversation'));
		assert.ok(!NON_INFERENCE_PATH_RE.test('/backend-api/f/conversation'));
	});
}

// ---------- handleClaudeBeforeRequest dedupe accounting ----------
{
	const bgSrc = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
	const handleClaudeSrc = extractFunctionSource(bgSrc, 'handleClaudeBeforeRequest');

	test('handleClaudeBeforeRequest early fingerprint does not self-suppress accounting', async () => {
		let fingerprinted = false;
		let markCount = 0;
		let rememberedPrompt = null;
		let pendingSet = null;
		let fallbackRecordCalls = 0;

		const sandbox = {
			parseRequestBody: async () => ({ model: 'claude-3-sonnet', messages: [{ text: 'hello' }], tools: [] }),
			hasRecentGenericRequestFingerprint: () => fingerprinted,
			markGenericRequestFingerprint: () => {
				fingerprinted = true;
				markCount += 1;
			},
			extractClaudeRequestIds: () => ({ orgId: 'org-1', conversationId: 'conv-1' }),
			tokenStorageManager: { addOrgId: async () => {} },
			resolveModel: async model => model || 'unknown',
			extractClaudeModel: body => body.model,
			lastModelByTab: new Map(),
			ClaudeAPI: class {
				async getUsageData() {
					return { toJSON: () => ({ totalCost: 1.23 }) };
				}
			},
			Log: async () => {},
			extractClaudePromptText: () => 'hello',
			estimateClaudeLocalRequest: async () => ({ model: 'claude-3-sonnet', inputTokens: 12 }),
			recordClaudeLocalEstimate: async () => {
				fallbackRecordCalls += 1;
				return true;
			},
			rememberPendingPromptText: (key, text) => {
				rememberedPrompt = { key, text };
			},
			pendingRequests: {
				set: async (key, value, ttl) => {
					pendingSet = { key, value, ttl };
				}
			},
			CLAUDE_BROWSER_FALLBACK_DEDUPE_TTL_MS: 1500,
			PENDING_REQUEST_TTL_MS: 300000,
			Map
		};
		vm.createContext(sandbox);
		vm.runInContext(`${handleClaudeSrc}\nthis.handleClaudeBeforeRequest = handleClaudeBeforeRequest;`, sandbox);

		await sandbox.handleClaudeBeforeRequest({
			method: 'POST',
			url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion',
			requestBody: { raw: [] },
			tabId: 7,
			cookieStoreId: 'firefox-default'
		});

		assert.equal(markCount, 1);
		assert.equal(fallbackRecordCalls, 0);
		assert.deepEqual(rememberedPrompt, { key: 'org-1:conv-1', text: 'hello' });
		assert.equal(pendingSet.key, 'org-1:conv-1');
		assert.deepEqual(pendingSet.value.previousUsage, { totalCost: 1.23 });
		assert.equal(pendingSet.value.fallbackRecorded, false);
	});

	test('handleClaudeBeforeRequest skips when page context already fingerprinted the request', async () => {
		let addOrgCalls = 0;
		let pendingCalls = 0;

		const sandbox = {
			parseRequestBody: async () => ({ model: 'claude-3-sonnet' }),
			hasRecentGenericRequestFingerprint: () => true,
			markGenericRequestFingerprint: () => assert.fail('should not mark an already fingerprinted request'),
			extractClaudeRequestIds: () => ({ orgId: 'org-1', conversationId: 'conv-1' }),
			tokenStorageManager: { addOrgId: async () => { addOrgCalls += 1; } },
			pendingRequests: { set: async () => { pendingCalls += 1; } },
			CLAUDE_BROWSER_FALLBACK_DEDUPE_TTL_MS: 1500,
			PENDING_REQUEST_TTL_MS: 300000
		};
		vm.createContext(sandbox);
		vm.runInContext(`${handleClaudeSrc}\nthis.handleClaudeBeforeRequest = handleClaudeBeforeRequest;`, sandbox);

		await sandbox.handleClaudeBeforeRequest({
			method: 'POST',
			url: 'https://claude.ai/api/organizations/org-1/chat_conversations/conv-1/completion',
			requestBody: { raw: [] },
			tabId: 7
		});

		assert.equal(addOrgCalls, 0);
		assert.equal(pendingCalls, 0);
	});
}

// ---------- isContextLostError ----------
{
	const cuSrc = fs.readFileSync(path.join(root, 'content-components/content_utils.js'), 'utf8');
	const isLostSrc = cuSrc.match(/function isContextLostError\([\s\S]+?\n}\n/)?.[0];
	const lostReLine = cuSrc.match(/const _ctxLostRe\s*=[^;]+;/)?.[0];
	assert.ok(isLostSrc, 'could not find isContextLostError source');
	assert.ok(lostReLine, 'could not find _ctxLostRe constant');

	const sandbox = {};
	vm.createContext(sandbox);
	vm.runInContext(
		`${lostReLine}\n${isLostSrc}\n; this.isContextLostError = isContextLostError;`,
		sandbox
	);
	const { isContextLostError } = sandbox;

	test('isContextLostError: identifies definitive runtime-loss patterns only', () => {
		assert.ok(isContextLostError({ message: 'Extension context invalidated' }));
		assert.ok(isContextLostError('chrome-extension://abc/content_utils.js invalidated'));
	});
	test('isContextLostError: rejects transient sendMessage errors and unrelated errors', () => {
		assert.ok(!isContextLostError(new TypeError('Failed to fetch')));
		assert.ok(!isContextLostError('Receiving end does not exist.'));
		assert.ok(!isContextLostError(new Error('Could not establish connection')));
		assert.ok(!isContextLostError(new Error('The message port closed before a response was received.')));
		assert.ok(!isContextLostError(new TypeError('Cannot read properties of undefined')));
		assert.ok(!isContextLostError(new Error('Network timeout')));
		assert.ok(!isContextLostError(null));
		assert.ok(!isContextLostError(undefined));
		assert.ok(!isContextLostError(''));
	});
}
