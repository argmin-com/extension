#!/usr/bin/env node
// Guard against partial provider additions. If CONFIG.PLATFORMS grows, every
// provider must have matching manifests, capture patterns, popup tiers, and
// content-script detection before the audit passes.
const fs = require('fs');

const PLATFORMS = {
	claude: {
		hosts: ['claude.ai'],
		matchHosts: ['https://claude.ai/*']
	},
	chatgpt: {
		hosts: ['chatgpt.com', 'chat.openai.com'],
		matchHosts: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
	},
	gemini: {
		hosts: ['gemini.google.com'],
		matchHosts: ['https://gemini.google.com/*']
	},
	mistral: {
		hosts: ['chat.mistral.ai'],
		matchHosts: ['https://chat.mistral.ai/*']
	},
	perplexity: {
		hosts: ['perplexity.ai', 'www.perplexity.ai'],
		matchHosts: ['https://perplexity.ai/*', 'https://www.perplexity.ai/*']
	},
	grok: {
		hosts: ['grok.com'],
		matchHosts: ['https://grok.com/*']
	},
	meta: {
		hosts: ['meta.ai', 'www.meta.ai'],
		matchHosts: ['https://meta.ai/*', 'https://www.meta.ai/*']
	}
};

const TEXT_FILES = {
	'bg-components/utils.js': ['PLATFORMS', 'PRICING'],
	'bg-components/platforms/platform-base.js': ['TOKEN_CALIBRATION', 'PLATFORM_LIMITS'],
	'bg-components/platforms/intercept-patterns.js': ['PLATFORM_INTERCEPT_PATTERNS'],
	'background.js': ['SUPPORTED_BROWSER_PLATFORMS'],
	'platform-adapters/adapters.js': ['PLATFORM_SELECTORS', 'TIER_DETECTION'],
	'injections/stream-token-counter.js': ['hostPlatform', 'urlMatchers'],
	'content-components/content_utils.js': ['detectCurrentPlatform'],
	'content-components/platform_content.js': ['tierNames'],
	'popup.js': ['PLATFORMS']
};

let failed = false;

function fail(message) {
	console.error(`FAIL: ${message}`);
	failed = true;
}

function read(file) {
	return fs.readFileSync(file, 'utf8');
}

for (const [file, sections] of Object.entries(TEXT_FILES)) {
	const src = read(file);
	for (const platform of Object.keys(PLATFORMS)) {
		if (!src.includes(platform)) {
			fail(`${file} is missing platform id "${platform}" (${sections.join(', ')})`);
		}
	}
}

for (const file of ['manifest.json', 'manifest_chrome.json', 'manifest_firefox.json']) {
	const manifest = JSON.parse(read(file));
	const hostPermissions = new Set(manifest.host_permissions || []);
	const contentMatches = new Set();
	for (const script of manifest.content_scripts || []) {
		for (const match of script.matches || []) contentMatches.add(match);
	}
	const resourceMatches = new Set();
	for (const resource of manifest.web_accessible_resources || []) {
		for (const match of resource.matches || []) resourceMatches.add(match);
	}

	for (const [platform, cfg] of Object.entries(PLATFORMS)) {
		for (const host of cfg.hosts) {
			const wildcard = `*://${host}/*`;
			const https = `https://${host}/*`;
			if (!hostPermissions.has(wildcard)) fail(`${file} missing host_permission ${wildcard} for ${platform}`);
			if (!contentMatches.has(wildcard) && !contentMatches.has(https)) {
				fail(`${file} missing content_script match for ${platform} host ${host}`);
			}
		}
		for (const match of cfg.matchHosts) {
			if (!resourceMatches.has(match)) fail(`${file} missing web_accessible_resources match ${match} for ${platform}`);
		}
	}
}

if (failed) process.exit(1);
console.log(`PASS: platform coverage complete for ${Object.keys(PLATFORMS).length} platforms`);
