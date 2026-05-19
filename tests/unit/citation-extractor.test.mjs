// tests/unit/citation-extractor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCitations, formatBibliography } from '../../bg-components/citation-extractor.js';

test('returns empty array for empty or non-string input', () => {
	assert.deepEqual(extractCitations(''), []);
	assert.deepEqual(extractCitations(null), []);
	assert.deepEqual(extractCitations(undefined), []);
});

test('extracts bare http(s) URLs', () => {
	const r = extractCitations('See https://example.com for details.');
	assert.equal(r.length, 1);
	assert.equal(r[0].url, 'https://example.com');
	assert.equal(r[0].host, 'example.com');
	assert.equal(r[0].kind, 'bare');
});

test('extracts URLs from markdown links and prefers their label', () => {
	const r = extractCitations('Read more in [the docs](https://example.com/docs).');
	assert.equal(r.length, 1);
	assert.equal(r[0].url, 'https://example.com/docs');
	assert.equal(r[0].label, 'the docs');
	assert.equal(r[0].kind, 'markdown');
});

test('extracts URLs from <angle> form', () => {
	const r = extractCitations('Reference: <https://example.com/spec>');
	assert.equal(r.length, 1);
	assert.equal(r[0].url, 'https://example.com/spec');
	assert.equal(r[0].kind, 'angle');
});

test('deduplicates same URL across forms; count reflects occurrences', () => {
	const text = 'See [docs](https://example.com/docs). Also https://example.com/docs and again https://example.com/docs.';
	const r = extractCitations(text);
	assert.equal(r.length, 1);
	assert.equal(r[0].count, 3);
	// Label from markdown-link form preserved through dedup
	assert.equal(r[0].label, 'docs');
});

test('strips trailing punctuation from bare URLs', () => {
	const r = extractCitations('Go to https://example.com/page, and then https://example.com/other.');
	const urls = r.map(c => c.url).sort();
	assert.deepEqual(urls, ['https://example.com/other', 'https://example.com/page']);
});

test('preserves balanced parens inside URL (Wikipedia case)', () => {
	const r = extractCitations('See https://en.wikipedia.org/wiki/JavaScript_(programming_language) for context.');
	assert.equal(r.length, 1);
	assert.equal(r[0].url, 'https://en.wikipedia.org/wiki/JavaScript_(programming_language)');
});

test('markdown link with parens-bearing URL captures the full URL', () => {
	// The markdown URL group must allow `)` so the parenthesised
	// Wikipedia URL inside `](...)` syntax is captured in full. The
	// matchAll boundary consumes the closing `)` of the markdown
	// syntax, and stripTrailingPunctuation balances anything left.
	const r = extractCitations('See [JS](https://en.wikipedia.org/wiki/JavaScript_(programming_language)).');
	assert.equal(r.length, 1);
	assert.equal(r[0].url, 'https://en.wikipedia.org/wiki/JavaScript_(programming_language)');
	assert.equal(r[0].kind, 'markdown');
	assert.equal(r[0].label, 'JS');
});

test('bibtex escapes braces in URL', () => {
	const out = formatBibliography([
		{ url: 'https://example.com/path{with}braces', host: 'example.com', label: '', kind: 'bare', count: 1 }
	], 'bibtex');
	// `}` would otherwise terminate the BibTeX entry early.
	assert.match(out, /url = \{https:\/\/example\.com\/path%7Bwith%7Dbraces\}/);
	assert.ok(!out.includes('}braces}'), 'raw `}` inside URL must be escaped');
});

test('ranks by occurrence count, then by host', () => {
	const r = extractCitations('a https://b.test https://a.test https://b.test https://c.test https://a.test https://a.test');
	// a.test: 3, b.test: 2, c.test: 1
	assert.equal(r[0].host, 'a.test');
	assert.equal(r[1].host, 'b.test');
	assert.equal(r[2].host, 'c.test');
});

test('skips obviously-broken URLs', () => {
	const r = extractCitations('ftp://nope.test should be skipped, http:// alone too.');
	// `http:// alone` is "http://" only, which after stripping trailing
	// punctuation is invalid; ftp:// not matched by patterns.
	assert.equal(r.length, 0);
});

test('caps the result at MAX_CITATIONS', () => {
	// Generate 250 unique URLs.
	const urls = Array.from({ length: 250 }, (_, i) => `https://host${i}.test/p`);
	const r = extractCitations(urls.join(' '));
	assert.ok(r.length <= 200, `got ${r.length}, expected <= MAX_CITATIONS`);
});

test('formatBibliography emits markdown by default', () => {
	const out = formatBibliography([
		{ url: 'https://a.test', host: 'a.test', label: 'A', kind: 'markdown', count: 1 },
		{ url: 'https://b.test', host: 'b.test', label: '',  kind: 'bare',     count: 1 }
	]);
	assert.match(out, /\[A\]\(https:\/\/a\.test\)/);
	assert.match(out, /\[b\.test\]\(https:\/\/b\.test\)/, 'falls back to host when label missing');
});

test('formatBibliography plain is one URL per line', () => {
	const out = formatBibliography([
		{ url: 'https://a.test', host: 'a.test', label: '', kind: 'bare', count: 1 },
		{ url: 'https://b.test', host: 'b.test', label: '', kind: 'bare', count: 1 }
	], 'plain');
	assert.equal(out, 'https://a.test\nhttps://b.test');
});

test('formatBibliography bibtex emits one @misc block per citation', () => {
	const out = formatBibliography([
		{ url: 'https://a.test', host: 'a.test', label: 'Hello World', kind: 'markdown', count: 1 }
	], 'bibtex');
	assert.match(out, /@misc\{cite1,/);
	assert.match(out, /title = \{Hello World\}/);
	assert.match(out, /url = \{https:\/\/a\.test\}/);
});

test('formatBibliography returns empty string on empty input', () => {
	assert.equal(formatBibliography([]), '');
	assert.equal(formatBibliography(null), '');
});
