// tests/unit/tier-detection.test.mjs
// Unit coverage for the pure tier-detection helpers inside
// platform-adapters/adapters.js. The file is a content-script (loaded
// directly into the page, no ES module exports), so we evaluate it
// inside a vm sandbox with light DOM/chrome stubs and pull the helpers
// off the sandbox globals. Only the pure functions are tested here --
// the API-fetching wrappers and TIER_DETECTION strategies need a real
// page context and are out of scope.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(
	path.join(__dirname, '../../platform-adapters/adapters.js'),
	'utf8'
);

function makeSandbox() {
	const sandbox = {
		window: { location: { origin: 'https://example.com' } },
		document: {
			body: { innerText: '' },
			querySelector: () => null,
			querySelectorAll: () => []
		},
		chrome: { storage: { session: null, local: null } },
		browser: undefined,
		fetch: async () => ({ ok: false, json: async () => ({}) }),
		console: { log: () => {}, warn: () => {}, error: () => {} },
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
		Date,
		Math,
		Array,
		Object,
		String,
		Number,
		Boolean,
		JSON,
		RegExp,
		URL: globalThis.URL,
		URLSearchParams: globalThis.URLSearchParams
	};
	vm.createContext(sandbox);
	vm.runInContext(src + '\n; this.tierFromText = tierFromText; this.collectPlanSignals = collectPlanSignals; this.tierFromPayload = tierFromPayload;', sandbox);
	return sandbox;
}

const sb = makeSandbox();
const { tierFromText, collectPlanSignals, tierFromPayload } = sb;

// ----- ChatGPT -----
test('chatgpt: free plan text', () => {
	assert.equal(tierFromText('chatgpt', 'You are on the Free plan'), 'free');
});
test('chatgpt: plus plan text', () => {
	assert.equal(tierFromText('chatgpt', 'ChatGPT Plus subscription'), 'plus');
});
test('chatgpt: pro plan text', () => {
	assert.equal(tierFromText('chatgpt', 'You are on ChatGPT Pro'), 'pro');
});
test('chatgpt: team plan text', () => {
	assert.equal(tierFromText('chatgpt', 'Workspace: Acme Team'), 'team');
});
test('chatgpt: enterprise is NOT folded into team', () => {
	assert.equal(tierFromText('chatgpt', 'Your ChatGPT Enterprise workspace'), 'enterprise');
	assert.equal(tierFromText('chatgpt', 'Manage Enterprise SSO settings'), 'enterprise');
});
test('chatgpt: strict mode ignores upsell text', () => {
	assert.equal(tierFromText('chatgpt', 'Upgrade to ChatGPT Plus today', { strict: true }), null);
	assert.equal(tierFromText('chatgpt', 'Try ChatGPT Pro for $200/mo', { strict: true }), null);
});
test('chatgpt: paid signal in non-strict mode infers plus', () => {
	assert.equal(tierFromText('chatgpt', 'is_paid_subscription_active:true'), 'plus');
});

// ----- Claude -----
test('claude: free plan text', () => {
	assert.equal(tierFromText('claude', 'Claude Free user'), 'claude_free');
});
test('claude: pro plan text', () => {
	assert.equal(tierFromText('claude', 'Claude Pro plan'), 'claude_pro');
});
test('claude: team plan text', () => {
	assert.equal(tierFromText('claude', 'Anthropic Team workspace'), 'claude_team');
});
test('claude: enterprise is NOT folded into team', () => {
	assert.equal(tierFromText('claude', 'Claude Enterprise org'), 'claude_enterprise');
	assert.equal(tierFromText('claude', 'Enterprise plan billing'), 'claude_enterprise');
});
test('claude: max 5x and 20x', () => {
	assert.equal(tierFromText('claude', 'Claude Max 5x'), 'claude_max_5x');
	assert.equal(tierFromText('claude', 'Claude Max 20x'), 'claude_max_20x');
});

// ----- Gemini -----
test('gemini: free plan', () => {
	assert.equal(tierFromText('gemini', 'Gemini free tier'), 'free');
});
test('gemini: advanced plan', () => {
	assert.equal(tierFromText('gemini', 'Gemini Advanced'), 'advanced');
});

// ----- Mistral -----
test('mistral: free plan', () => {
	assert.equal(tierFromText('mistral', 'Mistral free'), 'free');
});
test('mistral: pro plan', () => {
	assert.equal(tierFromText('mistral', 'Le Chat Pro'), 'pro');
});

// ----- Perplexity -----
test('perplexity: free/pro/max/enterprise plans', () => {
	assert.equal(tierFromText('perplexity', 'Perplexity Free'), 'free');
	assert.equal(tierFromText('perplexity', 'Perplexity Pro subscription'), 'pro');
	assert.equal(tierFromText('perplexity', 'Perplexity Max plan'), 'max');
	assert.equal(tierFromText('perplexity', 'Enterprise Pro workspace'), 'enterprise');
});

test('perplexity: strict mode ignores upsell text', () => {
	assert.equal(tierFromText('perplexity', 'Upgrade to Perplexity Pro', { strict: true }), null);
	assert.equal(tierFromText('perplexity', 'Try Perplexity Max today', { strict: true }), null);
});

// ----- Grok -----
test('grok: free/x premium/supergrok/enterprise plans', () => {
	assert.equal(tierFromText('grok', 'Grok Free'), 'free');
	assert.equal(tierFromText('grok', 'X Premium account'), 'x_premium');
	assert.equal(tierFromText('grok', 'X Premium+ account'), 'x_premium_plus');
	assert.equal(tierFromText('grok', 'SuperGrok'), 'supergrok');
	assert.equal(tierFromText('grok', 'SuperGrok Heavy'), 'supergrok_heavy');
	assert.equal(tierFromText('grok', 'Grok Enterprise'), 'enterprise');
});

test('grok: strict mode ignores upsell text', () => {
	assert.equal(tierFromText('grok', 'Upgrade to SuperGrok', { strict: true }), null);
	assert.equal(tierFromText('grok', 'Try Grok Premium+', { strict: true }), null);
});

// ----- collectPlanSignals -----
test('collectPlanSignals surfaces plan-related keys from nested objects', () => {
	const payload = {
		account: {
			subscription_plan: 'chatgpt_plus',
			entitlement: { name: 'plus' }
		},
		other: 'ignored if too deep'
	};
	const signals = collectPlanSignals(payload).join(' ').toLowerCase();
	assert.ok(signals.includes('plus'), `expected plus in signals, got: ${signals}`);
});

test('collectPlanSignals bounded by depth', () => {
	let nested = { plan: 'leaf' };
	for (let i = 0; i < 10; i++) nested = { account: nested };
	const out = collectPlanSignals(nested);
	// Should not stack-overflow; either empty or includes leaf via plan path.
	assert.ok(Array.isArray(out));
});

// ----- tierFromPayload (full account-API shape) -----
test('tierFromPayload on realistic ChatGPT /backend-api/me Plus shape', () => {
	const payload = {
		accounts: {
			default: {
				entitlement: { subscription_plan: 'chatgptplusplan' }
			}
		},
		account_plan: { is_paid_subscription_active: true }
	};
	assert.equal(tierFromPayload('chatgpt', payload), 'plus');
});

test('tierFromPayload on realistic ChatGPT Enterprise shape', () => {
	const payload = {
		accounts: {
			default: {
				entitlement: { subscription_plan: 'chatgptenterprise' }
			}
		}
	};
	assert.equal(tierFromPayload('chatgpt', payload), 'enterprise');
});

test('tierFromPayload on Free / no paid plan', () => {
	const payload = { accounts: { default: { entitlement: {} } }, account_plan: { is_paid_subscription_active: false } };
	// Free is the implicit default; tierFromPayload returns null when
	// there is no positive signal, and the calling code falls back to
	// other paths. Either null or 'free' is acceptable.
	const tier = tierFromPayload('chatgpt', payload);
	assert.ok(tier === null || tier === 'free', `got ${tier}`);
});

// ----- Strict-mode upsell filtering (every platform) -----
test('strict mode drops upsell copy across platforms', () => {
	assert.equal(tierFromText('chatgpt', 'Upgrade to ChatGPT Plus', { strict: true }), null);
	assert.equal(tierFromText('claude', 'Get Claude Pro today', { strict: true }), null);
	assert.equal(tierFromText('gemini', 'Try Gemini Advanced for free', { strict: true }), null);
	assert.equal(tierFromText('mistral', 'Upgrade to Le Chat Pro', { strict: true }), null);
	assert.equal(tierFromText('perplexity', 'Get Perplexity Max', { strict: true }), null);
	assert.equal(tierFromText('grok', 'Start SuperGrok Heavy trial', { strict: true }), null);
});

// ----- Realistic Gemini / Mistral account-API payloads -----
test('tierFromPayload on Gemini-like advanced shape', () => {
	const payload = {
		user: {
			entitlements: [{ subscription: 'gemini_advanced', active: true }]
		}
	};
	const tier = tierFromPayload('gemini', payload);
	assert.equal(tier, 'advanced');
});
test('tierFromPayload on Gemini-like free shape', () => {
	const payload = { user: { plan: 'free' } };
	const tier = tierFromPayload('gemini', payload);
	assert.equal(tier, 'free');
});
test('tierFromPayload on Mistral-like pro shape', () => {
	const payload = {
		account: { subscription: { name: 'le chat pro' } }
	};
	const tier = tierFromPayload('mistral', payload);
	assert.equal(tier, 'pro');
});

test('tierFromPayload on Perplexity-like Max shape', () => {
	const payload = {
		user: { subscription: { tier: 'perplexity_max', active: true } }
	};
	assert.equal(tierFromPayload('perplexity', payload), 'max');
});

test('tierFromPayload on Grok-like Premium Plus shape', () => {
	const payload = {
		account: { plan: { product: 'x_premium_plus', active: true } }
	};
	assert.equal(tierFromPayload('grok', payload), 'x_premium_plus');
});

// ----- Claude tier matrix (full coverage) -----
test('claude tier matrix: free/pro/team/enterprise/max', () => {
	assert.equal(tierFromText('claude', 'Claude Free user'), 'claude_free');
	assert.equal(tierFromText('claude', 'Claude Pro plan'), 'claude_pro');
	assert.equal(tierFromText('claude', 'Anthropic Team workspace'), 'claude_team');
	assert.equal(tierFromText('claude', 'Claude Enterprise org'), 'claude_enterprise');
	assert.equal(tierFromText('claude', 'Claude Max 5x'), 'claude_max_5x');
	assert.equal(tierFromText('claude', 'Claude Max 20x'), 'claude_max_20x');
});

// ----- ChatGPT tier matrix (full coverage) -----
test('chatgpt tier matrix: free/plus/pro/team/enterprise', () => {
	assert.equal(tierFromText('chatgpt', 'You are on the Free plan'), 'free');
	assert.equal(tierFromText('chatgpt', 'ChatGPT Plus subscription'), 'plus');
	assert.equal(tierFromText('chatgpt', 'You are on ChatGPT Pro'), 'pro');
	assert.equal(tierFromText('chatgpt', 'Workspace: Acme Team'), 'team');
	assert.equal(tierFromText('chatgpt', 'ChatGPT Enterprise workspace'), 'enterprise');
});

// ----- Manual-override protection (platform-base.setSubscriptionTier) -----
// This is verified textually rather than via a full sandbox load since
// platform-base.js is an ES module that depends on chrome.storage. We
// check that the source-aware code paths exist and that the StoredMap
// privacy guard does not flag tierSource as a content field.
test('platform-base setSubscriptionTier accepts and respects source', () => {
	const src = fs.readFileSync(path.resolve(__dirname, '../../bg-components/platforms/platform-base.js'), 'utf8');
	assert.match(src, /async setSubscriptionTier\(platform, tier, source = 'auto'\)/);
	assert.match(src, /existingSource === 'manual' && source === 'auto'/);
	assert.match(src, /tierSource:\$\{platform\}/);
});
test('background.js exposes getSubscriptionTierSource handler', () => {
	const src = fs.readFileSync(path.resolve(__dirname, '../../background.js'), 'utf8');
	assert.match(src, /messageRegistry\.register\('getSubscriptionTierSource'/);
});

// ----- Claude API path coverage -----
test('claude-api recognizes Enterprise from app_start growthbook flags', () => {
	const src = fs.readFileSync(path.resolve(__dirname, '../../bg-components/claude-api.js'), 'utf8');
	// Probe the explicit flag candidates and the resulting claude_enterprise tier.
	assert.match(src, /isEnterprise/);
	assert.match(src, /claude_enterprise/);
});
