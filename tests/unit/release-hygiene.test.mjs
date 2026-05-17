// Static release hygiene checks for surfaces that store/release/package gates
// do not fully cover: operator backlog structure and customer-visible copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
	return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function splitTaskBlocks(src) {
	return src.split(/^## /m).slice(1).map(block => {
		const [slug, ...rest] = block.split('\n');
		return { slug: slug.trim(), body: rest.join('\n') };
	});
}

test('harness/TASKS.md keeps one complete metadata set per task', () => {
	const tasks = splitTaskBlocks(readRepoFile('harness/TASKS.md'));
	assert.ok(tasks.length > 0, 'TASKS.md should contain at least one task');

	for (const { slug, body } of tasks) {
		for (const field of ['Status', 'Owner', 'Lease', 'Blocked by', 'Created']) {
			const matches = [...body.matchAll(new RegExp(`^\\*\\*${field}\\*\\*:`, 'gm'))];
			assert.equal(matches.length, 1, `${slug} must contain exactly one ${field} field`);
		}
		assert.match(body, /^### Description$/m, `${slug} must contain a Description section`);
		assert.match(body, /^### Acceptance$/m, `${slug} must contain an Acceptance section`);
	}
});

test('customer-visible platform copy includes every supported platform', () => {
	const readme = readRepoFile('README.md');
	for (const platform of ['Claude', 'ChatGPT', 'Gemini', 'Mistral', 'Perplexity', 'Grok', 'Meta AI', 'Microsoft Copilot']) {
		assert.ok(readme.includes(platform), `README.md must mention ${platform}`);
	}

	const popupHtml = readRepoFile('popup.html');
	assert.doesNotMatch(
		popupHtml,
		/Claude, ChatGPT, Gemini, Mistral[.)]/,
		'popup onboarding/header copy must not hard-code the old four-platform list'
	);
});

test('optional network-call disclosure stays aligned across docs and popup copy', () => {
	const optionalHosts = [
		'api.anthropic.com',
		'raw.githubusercontent.com',
		'api.frankfurter.app'
	];
	const surfaces = [
		'README.md',
		'PRIVACY.md',
		'popup.html',
		'popup.js',
		'bg-components/usage-insights.js'
	];

	for (const surface of surfaces) {
		const src = readRepoFile(surface);
		for (const host of optionalHosts) {
			assert.ok(src.includes(host), `${surface} must disclose ${host}`);
		}
	}
});

test('host permissions have explicit release documentation for non-page domains', () => {
	const manifest = JSON.parse(readRepoFile('manifest_chrome.json'));
	const readme = readRepoFile('README.md');
	for (const host of [
		'https://api.anthropic.com/*',
		'https://raw.githubusercontent.com/*',
		'https://api.frankfurter.app/*',
		'https://graph.meta.ai/*'
	]) {
		assert.ok((manifest.host_permissions || []).includes(host), `manifest_chrome.json must include ${host}`);
		assert.ok(readme.includes(host), `README.md host-permissions table must document ${host}`);
	}
});

test('package, lockfile, and source manifests stay version-synchronized', () => {
	const pkg = JSON.parse(readRepoFile('package.json'));
	const lock = JSON.parse(readRepoFile('package-lock.json'));
	assert.equal(lock.version, pkg.version, 'package-lock.json top-level version must match package.json');
	assert.equal(lock.packages?.['']?.version, pkg.version, 'package-lock root package version must match package.json');

	for (const manifestFile of ['manifest.json', 'manifest_chrome.json', 'manifest_firefox.json']) {
		const manifest = JSON.parse(readRepoFile(manifestFile));
		assert.equal(manifest.version, pkg.version, `${manifestFile} version must match package.json`);
	}
});
