// tests/unit/prompt-templates.test.mjs
// Round-trip + edge-case coverage for the local prompt-template store.

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

const {
	listTemplates, saveTemplate, deleteTemplate, findTemplateBySlug,
	extractPlaceholders, renderTemplate, normalizeSlug,
	MAX_TEMPLATES, MAX_NAME_LEN, MAX_BODY_LEN
} = await import('../../bg-components/prompt-templates.js');

function reset() {
	for (const k of Object.keys(storageData)) delete storageData[k];
}

test('listTemplates returns empty array initially', async () => {
	reset();
	const list = await listTemplates();
	assert.deepEqual(list, []);
});

test('saveTemplate normalises slug, name, body', async () => {
	reset();
	const saved = await saveTemplate({ name: '  Code Review  ', slug: '/Code Review!', body: 'review {{file}}' });
	assert.equal(saved.name, 'Code Review');
	assert.equal(saved.slug, 'code-review');
	assert.equal(saved.body, 'review {{file}}');
	assert.ok(saved.id.startsWith('tpl_'));
	assert.ok(saved.createdAt > 0);
});

test('saveTemplate rejects empty name', async () => {
	reset();
	await assert.rejects(() => saveTemplate({ body: 'no name' }), /name is required/);
});

test('saveTemplate truncates over-long fields', async () => {
	reset();
	const longName = 'x'.repeat(MAX_NAME_LEN + 50);
	const longBody = 'y'.repeat(MAX_BODY_LEN + 100);
	const saved = await saveTemplate({ name: longName, body: longBody });
	assert.equal(saved.name.length, MAX_NAME_LEN);
	assert.equal(saved.body.length, MAX_BODY_LEN);
});

test('saveTemplate disambiguates slug collisions', async () => {
	reset();
	const a = await saveTemplate({ name: 'Review', body: 'a' });
	const b = await saveTemplate({ name: 'Review', body: 'b' });
	const c = await saveTemplate({ name: 'Review', body: 'c' });
	assert.equal(a.slug, 'review');
	assert.equal(b.slug, 'review-2');
	assert.equal(c.slug, 'review-3');
});

test('saveTemplate disambiguates collision when base slug is at MAX_SLUG_LEN', async () => {
	reset();
	// Use 32 chars exactly (MAX_SLUG_LEN). Without trimming the base
	// before adding the suffix, the slice-back would re-produce the same
	// string and the loop would burn 1000 iterations then ship a
	// colliding slug.
	const longBase = 'a'.repeat(32);
	const first = await saveTemplate({ name: 'a', slug: longBase, body: '1' });
	const second = await saveTemplate({ name: 'b', slug: longBase, body: '2' });
	assert.equal(first.slug, longBase);
	assert.notEqual(second.slug, first.slug, 'second slug must not collide');
	assert.ok(second.slug.length <= 32, 'second slug must respect MAX_SLUG_LEN');
	assert.ok(second.slug.endsWith('-2'), 'second slug should carry the disambiguator');
});

test('saveTemplate updates existing by id (preserves createdAt)', async () => {
	reset();
	const a = await saveTemplate({ name: 'Hi', body: 'hello' });
	await new Promise(r => setTimeout(r, 5));
	const b = await saveTemplate({ id: a.id, name: 'Hi v2', body: 'hello world' });
	assert.equal(b.id, a.id);
	assert.equal(b.createdAt, a.createdAt);
	assert.ok(b.updatedAt >= a.updatedAt);
	const list = await listTemplates();
	assert.equal(list.length, 1);
});

test('deleteTemplate removes by id', async () => {
	reset();
	const a = await saveTemplate({ name: 'a', body: 'A' });
	assert.equal(await deleteTemplate(a.id), true);
	assert.equal((await listTemplates()).length, 0);
	assert.equal(await deleteTemplate(a.id), false, 'second delete is no-op');
});

test('findTemplateBySlug accepts /-prefixed and bare slugs', async () => {
	reset();
	await saveTemplate({ name: 'Summary', slug: '/summary', body: 'sum it up' });
	const found1 = await findTemplateBySlug('/summary');
	const found2 = await findTemplateBySlug('summary');
	const found3 = await findTemplateBySlug('SUMMARY');
	assert.ok(found1 && found1.slug === 'summary');
	assert.equal(found1.id, found2.id);
	assert.equal(found1.id, found3.id);
});

test('normalizeSlug strips disallowed chars', () => {
	assert.equal(normalizeSlug('/Hello World!'), 'hello-world');
	assert.equal(normalizeSlug('  multi  space  '), 'multi-space');
	assert.equal(normalizeSlug('---weird---'), 'weird');
	assert.equal(normalizeSlug(''), '');
	assert.equal(normalizeSlug(null), '');
});

test('extractPlaceholders returns ordered, deduped names', () => {
	const body = 'Hello {{name}}, role={{role}}. Bye {{name}}. {{name}}';
	assert.deepEqual(extractPlaceholders(body), ['name', 'role']);
});

test('extractPlaceholders ignores malformed placeholders', () => {
	const body = '{ {name} } {{name}} {{ 1bad }} {{ ok-fine }}';
	// `1bad` starts with digit (not [A-Za-z_]) -> skip
	// `ok-fine` contains '-' which isn't in [A-Za-z0-9_] -> skip
	assert.deepEqual(extractPlaceholders(body), ['name']);
});

test('renderTemplate substitutes known placeholders', () => {
	const body = 'Hello {{name}}, you are {{role}}.';
	assert.equal(renderTemplate(body, { name: 'Alice', role: 'admin' }), 'Hello Alice, you are admin.');
});

test('renderTemplate leaves unknown placeholders intact', () => {
	const body = 'Hello {{name}}, role={{role}}, dept={{dept}}';
	const out = renderTemplate(body, { name: 'A' });
	assert.equal(out, 'Hello A, role={{role}}, dept={{dept}}');
});

test('renderTemplate handles numeric and null values', () => {
	assert.equal(renderTemplate('count={{n}}', { n: 5 }), 'count=5');
	assert.equal(renderTemplate('v={{x}}', { x: null }), 'v=');
});

test('renderTemplate is safe on non-string body', () => {
	assert.equal(renderTemplate(null), '');
	assert.equal(renderTemplate(undefined), '');
	assert.equal(renderTemplate(123), '');
});
