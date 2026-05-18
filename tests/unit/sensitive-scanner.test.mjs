// tests/unit/sensitive-scanner.test.mjs
// The scanner is pure and runs on every keystroke; tests assert both
// detection of well-known shapes AND that the result NEVER includes the
// matched substring (privacy invariant).

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanForSensitiveContent } from '../../bg-components/sensitive-scanner.js';

test('empty input returns no findings', () => {
	assert.equal(scanForSensitiveContent('').findings.length, 0);
	assert.equal(scanForSensitiveContent('').maxSeverity, 'none');
	assert.equal(scanForSensitiveContent(null).findings.length, 0);
	assert.equal(scanForSensitiveContent(undefined).findings.length, 0);
});

test('detects email addresses with info severity', () => {
	const r = scanForSensitiveContent('Contact alice@example.com about this.');
	assert.equal(r.findings.length, 1);
	assert.equal(r.findings[0].id, 'email');
	assert.equal(r.findings[0].severity, 'info');
	assert.equal(r.findings[0].count, 1);
});

test('counts multiple emails', () => {
	const r = scanForSensitiveContent('Loop a@b.com and c@d.org in.');
	const f = r.findings.find(x => x.id === 'email');
	assert.equal(f.count, 2);
});

test('detects AWS access key with block severity', () => {
	const r = scanForSensitiveContent('My key is AKIAIOSFODNN7EXAMPLE here.');
	assert.equal(r.findings.length, 1);
	assert.equal(r.findings[0].id, 'aws_access_key');
	assert.equal(r.findings[0].severity, 'block');
	assert.equal(r.maxSeverity, 'block');
});

test('detects Anthropic key', () => {
	const key = 'sk-ant-' + 'a'.repeat(30);
	const r = scanForSensitiveContent(`Use ${key} for testing`);
	assert.ok(r.findings.some(f => f.id === 'anthropic_key'));
	assert.equal(r.maxSeverity, 'block');
});

test('detects GitHub PATs across all prefixes', () => {
	for (const prefix of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
		const token = `${prefix}_` + 'A'.repeat(40);
		const r = scanForSensitiveContent(`Token: ${token}`);
		assert.ok(r.findings.some(f => f.id === 'github_pat'), `should detect ${prefix}`);
	}
});

test('detects JWT', () => {
	const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
	const r = scanForSensitiveContent(`auth=${jwt}`);
	assert.ok(r.findings.some(f => f.id === 'jwt'));
});

test('detects PEM private keys', () => {
	const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEo...';
	const r = scanForSensitiveContent(pem);
	assert.ok(r.findings.some(f => f.id === 'gcp_service_acct'));
	assert.equal(r.maxSeverity, 'block');
});

test('credit-card matcher rejects non-Luhn 16-digit numbers', () => {
	// Random 16-digit string -- fails Luhn.
	const r = scanForSensitiveContent('Order ID: 1234567890123456');
	assert.equal(r.findings.length, 0);
});

test('credit-card matcher accepts a Luhn-valid number', () => {
	// 4532015112830366 is a valid Luhn 16-digit number (Visa test BIN).
	const r = scanForSensitiveContent('card 4532015112830366 on file');
	assert.ok(r.findings.some(f => f.id === 'credit_card'));
});

test('detects US SSN shape', () => {
	const r = scanForSensitiveContent('SSN 123-45-6789 redacted');
	assert.ok(r.findings.some(f => f.id === 'ssn'));
});

test('detects E.164 and US phone numbers', () => {
	const r = scanForSensitiveContent('Call +1 415 555 0123 or 415-555-0124.');
	assert.ok(r.findings.length > 0);
});

test('codeOnly patterns require codeMode=true', () => {
	const env = 'API_KEY="' + 'a'.repeat(30) + '"';
	const off = scanForSensitiveContent(env);
	assert.equal(off.findings.find(f => f.id === 'env_assignment'), undefined);
	const on = scanForSensitiveContent(env, { codeMode: true });
	assert.ok(on.findings.some(f => f.id === 'env_assignment'));
});

test('env_assignment matches indented, exported, and commented forms', () => {
	// indented (e.g. inside a code block in the composer)
	const indented = '    API_KEY=' + 'x'.repeat(30);
	// `export` prefix
	const exported = 'export TOKEN=' + 'y'.repeat(30);
	// trailing comment
	const commented = 'STRIPE_KEY=' + 'z'.repeat(30) + '  # prod';
	for (const text of [indented, exported, commented]) {
		const r = scanForSensitiveContent(text, { codeMode: true });
		assert.ok(
			r.findings.some(f => f.id === 'env_assignment'),
			`env_assignment should match: ${text.slice(0, 40)}...`
		);
	}
});

test('Bearer Authorization header only fires in code mode', () => {
	const text = 'Authorization: Bearer ' + 'x'.repeat(30);
	const off = scanForSensitiveContent(text);
	assert.equal(off.findings.find(f => f.id === 'bearer_header'), undefined);
	const on = scanForSensitiveContent(text, { codeMode: true });
	assert.ok(on.findings.some(f => f.id === 'bearer_header'));
});

test('maxSeverity reflects highest severity match', () => {
	// email = info, JWT = warn, AWS key = block
	const aws = 'AKIAIOSFODNN7EXAMPLE';
	const r = scanForSensitiveContent(`a@b.com and ${aws}`);
	assert.equal(r.maxSeverity, 'block');
});

test('PRIVACY INVARIANT: findings never contain matched substrings', () => {
	// Repeatedly scan secrets and assert that no `result.findings[*]`
	// JSON dump contains any of the secret material. This catches the
	// most likely regression: someone adding `{ match: result }` to the
	// finding shape.
	const secrets = [
		'alice@example.com',
		'AKIAIOSFODNN7EXAMPLE',
		'sk-ant-' + 'a'.repeat(40),
		'ghp_' + 'A'.repeat(40),
		'4532015112830366',
		'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
		'-----BEGIN PRIVATE KEY-----'
	];
	for (const s of secrets) {
		const blob = `prefix ${s} suffix`;
		const r = scanForSensitiveContent(blob, { codeMode: true });
		const dumped = JSON.stringify(r);
		assert.ok(
			!dumped.includes(s.slice(0, Math.min(15, s.length))),
			`scanner result leaked secret: ${s.slice(0, 15)}... in ${dumped.slice(0, 80)}`
		);
	}
});

test('scanner is idempotent under repeated calls (no /g lastIndex leak)', () => {
	const text = 'a@b.com x@y.org';
	const first = scanForSensitiveContent(text);
	const second = scanForSensitiveContent(text);
	const third = scanForSensitiveContent(text);
	assert.deepEqual(first, second);
	assert.deepEqual(second, third);
});
