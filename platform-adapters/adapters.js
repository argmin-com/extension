/* global CURRENT_PLATFORM */
'use strict';

// platform-adapters/adapters.js
// Unified platform adapter: DOM selectors and query helpers for all 4 platforms.
// One file, one interface, per-platform selector maps.

const PLATFORM_SELECTORS = {
	claude: {
		composerRoot: ['form:has(textarea)', 'main form', 'div:has(textarea[placeholder*="Message"])'],
		textarea: ['div[contenteditable="true"][role="textbox"]', 'textarea'],
		sendButton: ['form button[type="submit"]', 'button[aria-label*="Send"]', 'form button'],
		conversationRoot: ['main', '[data-test-render-count]'],
		lastAssistantTurn: ['main article:last-of-type', '[data-test-render-count] article:last-of-type']
	},
	chatgpt: {
		composerRoot: ['form:has(textarea)', 'main form', '[data-testid="composer"]', 'div[role="presentation"]:has(textarea)'],
		textarea: ['#prompt-textarea', 'textarea[data-id]', 'form textarea', 'textarea'],
		sendButton: ['button[data-testid*="send"]', 'form button[aria-label*="Send"]', 'form button[type="submit"]'],
		conversationRoot: ['main', '[data-testid="conversation-turns"]'],
		lastAssistantTurn: ['[data-message-author-role="assistant"]:last-of-type', 'article[data-testid*="conversation-turn"]:last-of-type', 'main article:last-of-type']
	},
	gemini: {
		composerRoot: ['form:has(textarea)', 'div:has(textarea)', 'div:has(rich-textarea)'],
		textarea: ['textarea', 'div[contenteditable="true"]', 'rich-textarea textarea'],
		sendButton: ['button[aria-label*="Send"]', 'button[type="submit"]', 'form button'],
		conversationRoot: ['main', '[role="main"]'],
		lastAssistantTurn: ['message-content:last-of-type', 'article:last-of-type']
	},
	mistral: {
		composerRoot: ['form:has(textarea)', 'main form', 'div:has(textarea)'],
		textarea: ['textarea', '[contenteditable="true"]'],
		sendButton: ['button[type="submit"]', 'button[aria-label*="Send"]', 'form button'],
		conversationRoot: ['main'],
		lastAssistantTurn: ['main article:last-of-type', '[data-role="assistant"]:last-of-type']
	},
	perplexity: {
		composerRoot: ['form:has(textarea)', 'main form', 'div:has(textarea)', '[data-testid*="composer"]'],
		textarea: ['textarea', '[contenteditable="true"][role="textbox"]', '[data-testid*="input"] textarea'],
		sendButton: ['button[type="submit"]', 'button[aria-label*="Submit"]', 'button[aria-label*="Send"]', 'form button'],
		conversationRoot: ['main', '[role="main"]'],
		lastAssistantTurn: ['main article:last-of-type', '[data-testid*="answer"]:last-of-type', '[class*="answer"]:last-of-type']
	},
	grok: {
		composerRoot: ['form:has(textarea)', 'main form', 'div:has(textarea)', '[data-testid*="composer"]'],
		textarea: ['textarea', '[contenteditable="true"][role="textbox"]', '[aria-label*="Ask"]'],
		sendButton: ['button[type="submit"]', 'button[aria-label*="Send"]', 'form button'],
		conversationRoot: ['main', '[role="main"]'],
		lastAssistantTurn: ['main article:last-of-type', '[data-testid*="assistant"]:last-of-type', '[class*="assistant"]:last-of-type']
	}
};

/**
 * Query a DOM element using the platform's selector candidates.
 * Returns first match or null.
 */
function adapterQuery(role) {
	const selectors = PLATFORM_SELECTORS[CURRENT_PLATFORM]?.[role];
	if (!selectors) return null;
	for (const sel of selectors) {
		try {
			const el = document.querySelector(sel);
			if (el) return el;
		} catch (e) { /* invalid selector, skip */ }
	}
	return null;
}

/**
 * Get the current text in the composer textarea.
 */
function getComposerText() {
	const el = adapterQuery('textarea');
	if (!el) return '';
	return el.value || el.innerText || el.textContent || '';
}

/**
 * Observe the composer textarea for input changes.
 * Calls cb with the current text on each change.
 * Returns a disconnect function.
 */
function observeComposer(cb) {
	const textarea = adapterQuery('textarea');
	if (!textarea) return () => {};

	// For contenteditable divs (Claude, Gemini)
	if (textarea.getAttribute('contenteditable') === 'true') {
		const observer = new MutationObserver(() => cb(textarea.innerText || ''));
		observer.observe(textarea, { childList: true, subtree: true, characterData: true });
		textarea.addEventListener('input', () => cb(textarea.innerText || ''));
		return () => observer.disconnect();
	}

	// For standard textareas
	const handler = () => cb(textarea.value || '');
	textarea.addEventListener('input', handler);
	textarea.addEventListener('keyup', handler);
	return () => {
		textarea.removeEventListener('input', handler);
		textarea.removeEventListener('keyup', handler);
	};
}

// ── Tier Auto-Detection ──

// Unified 1h cache across all platforms. Short enough that a plan
// upgrade is reflected on the next page load within the hour, long
// enough to absorb cross-tab churn and incidental DOM noise.
const TIER_CACHE_TTL_MS = 60 * 60 * 1000;

async function getTierCache(cacheKey) {
	try {
		const store = chrome.storage?.session || chrome.storage?.local;
		if (!store) return null;
		const result = await store.get(cacheKey);
		const cached = result?.[cacheKey];
		if (!cached) return null;
		if (typeof cached === 'string') return cached;
		if (cached.tier && Date.now() - (cached.fetchedAt || 0) < TIER_CACHE_TTL_MS) return cached.tier;
	} catch {
		return null;
	}
	return null;
}

async function setTierCache(cacheKey, tier) {
	try {
		const store = chrome.storage?.session || chrome.storage?.local;
		if (store) await store.set({ [cacheKey]: { tier, fetchedAt: Date.now() } });
	} catch {
		// Non-critical.
	}
}

// Upsell-text detection in multiple languages. When a page shows an
// upgrade / try / compare-plans CTA we must NOT let the plan name in
// that CTA convince us the user is on that tier. Returns true if the
// text matches an upsell shape in any supported language. The list of
// patterns is conservative -- we'd rather miss an upsell-style match
// (and return a slightly wrong tier) than wrongly suppress account-
// menu text on a paid user (and return null). Inconclusive callers
// already preserve the prior stored value.
//
// Supported languages: English, French, Spanish, German, Portuguese,
// Italian, Japanese, Korean, Chinese (Simplified). Each set covers the
// most common consumer-product CTA verbs paired with plan tokens.
const MULTILINGUAL_UPSELL_PATTERNS = [
	// English (contiguous + brand-interrupted)
	/\b(upgrade(\s+to)?|try|switch(\s+to)?|get|start|learn more|see plans|compare plans)\b(\s+\S+){0,4}\s+\b(plus|pro|max|team|enterprise|advanced|premium|supergrok|ultra)\b/i,
	// French: "passer à pro", "essayer plus", "découvrir pro".
	// \b around à/é/è doesn't match (JS \b is ASCII-only), so the
	// French patterns drop trailing \b after non-ASCII chars.
	/\bpass(er|ez)\s+(à|au|aux)\s/i,
	/\bessay(er|ez)\b/i,
	/\bd(é|e)couvr(ir|ez)\b/i,
	/\bobten(ir|ez)\b/i,
	// Spanish: "actualizar a pro", "obtener plus"
	/\bactualiz(ar|a|e|en)\s+a\b/i,
	/\bobtener\b/i,
	/\bobtén\b/i,
	/\bprueba\s+(pro|plus|gratis|gratuita)\b/i,
	// German: "upgrade auf pro", "auf plus upgraden",
	// "jetzt X testen / kaufen / ausprobieren"
	/\bupgrade\s+auf\b/i,
	/\bauf\s+(\S+\s+){0,3}upgraden\b/i,
	/\bjetzt\s+(\S+\s+){0,3}(testen|ausprobieren|kaufen|upgraden|abonnieren)\b/i,
	// Portuguese: "atualize para pro", "obtenha plus"
	/\batualize?\s+para\b/i,
	/\bobtenha\b/i,
	/\bexperimente\s+\S+\s+(pro|plus)\b/i,
	// Italian: "passa a pro", "ottieni plus"
	/\bpass(a|are)\s+a\b/i,
	/\botten(ere|i)\b/i,
	// Japanese: アップグレード / プランを変更 / プランを比較 / プロにアップグレード
	/アップグレード/,
	/プランを?\s*(変更|比較)/,
	// Korean: 업그레이드 / 플랜 업그레이드 / 프로로 업그레이드
	/업그레이드/,
	// Chinese Simplified: 升级到 / 更改方案 / 查看方案
	/升级到/,
	/更改方案/,
	/查看方案/
];
function isUpsellText(rawLowered) {
	for (const re of MULTILINGUAL_UPSELL_PATTERNS) {
		if (re.test(rawLowered)) return true;
	}
	return false;
}

function tierFromText(platform, text, { strict = false } = {}) {
	const raw = String(text || '').toLowerCase();
	const compact = raw.replace(/[\s_.-]+/g, '');

	// Multilingual upsell short-circuit -- applies to every platform in
	// strict mode. Per-platform regexes below remain for backward-compat
	// and as a second layer of defense for English-only phrasings the
	// shared regex might miss.
	if (strict && isUpsellText(raw)) return null;
	if (platform === 'claude') {
		// Upsell phrasing covers both contiguous ("get pro") and brand-
		// interrupted ("get claude pro") variants. The verb prefix has
		// to be followed by an optional brand/article token within 1-2
		// words of a plan name -- without this gap-tolerance, "Get
		// Claude Pro today" would still match the /pro/ tier rule.
		if (strict && /\b(upgrade(\s+to)?|try|switch(\s+to)?|get|start|learn more|see plans|compare plans)\b(\s+\w+){0,3}\s+\b(pro|plus|max|team|enterprise|advanced)\b/.test(raw)) return null;
		if (strict && /\b(upgrade|try|switch|get pro|get max|learn more)\b/.test(raw)) return null;
		// Enterprise is a distinct contract from Team -- different commit
		// terms, audit/SAML, and (often) higher seat limits. Detect it
		// first so the more general /team|business|workspace/ rule does
		// not swallow it.
		if (/\benterprise\b/.test(raw) || /claudeenterprise/.test(compact)) return 'claude_enterprise';
		if (/\b(team|business|workspace)\b/.test(raw) || /claude(team|business)/.test(compact)) return 'claude_team';
		if (/\bmax\s*20x\b/.test(raw) || /claudemax20x|max20x/.test(compact)) return 'claude_max_20x';
		if (/\bmax\s*5x\b/.test(raw) || /\bmax\b/.test(raw) || /claudemax5x|max5x/.test(compact)) return 'claude_max_5x';
		if (/\bpro\b/.test(raw) || /claudepro|proplan|planpro|subscriptionpro/.test(compact)) return 'claude_pro';
		if (/\bfree\b/.test(raw) || /claudefree|freeplan|planfree/.test(compact)) return 'claude_free';
	}
	if (platform === 'chatgpt') {
		if (strict && /\b(upgrade(\s+to)?|try|switch(\s+to)?|get|start|learn more|see plans|compare plans)\b(\s+\w+){0,3}\s+\b(plus|pro|team|enterprise)\b/.test(raw)) return null;
		if (strict && /\b(upgrade|try|switch|get plus|get pro|learn more)\b/.test(raw)) return null;
		// Enterprise is a distinct contract from Team (custom seat
		// pricing, SAML, audit logs). Detect it before the more general
		// /team|business|workspace/ rule so it is not folded into 'team'.
		if (/\benterprise\b/.test(raw) || /chatgptenterprise/.test(compact)) return 'enterprise';
		if (/\b(team|business|workspace|edu)\b/.test(raw) || /chatgpt(team|business|edu)/.test(compact)) return 'team';
		if (/\bpro\b/.test(raw) || /chatgptpro|proplan|planpro|subscriptionpro/.test(compact)) return 'pro';
		if (/\bplus\b/.test(raw) || /chatgptplus|plusplan|planplus|subscriptionplus/.test(compact)) return 'plus';
		if (!strict && (/\bpaid\b/.test(raw) || raw.includes('is_paid_subscription_active:true'))) return 'plus';
		if (/\bfree\b/.test(raw) || /chatgptfree|freeplan|planfree/.test(compact)) return 'free';
	}
	if (platform === 'gemini') {
		// Strict mode drops upsell copy that would otherwise pin a free
		// user to 'advanced' just because the page renders an upgrade CTA.
		if (strict && /\b(upgrade(\s+to)?|try|switch(\s+to)?|get|start|learn more|see plans|start free trial)\b(\s+\w+){0,3}\s+\b(advanced|ultra|pro)\b/.test(raw)) return null;
		if (strict && /\b(upgrade|try|get advanced|get gemini advanced|learn more|start free trial)\b/.test(raw)) return null;
		if (/\b(advanced|ultra|pro)\b/.test(raw) || /gemini(advanced|ultra|pro)/.test(compact)) return 'advanced';
		if (/\bfree\b/.test(raw)) return 'free';
	}
	if (platform === 'mistral') {
		if (strict && /\b(upgrade(\s+to)?|try|switch(\s+to)?|get|start|learn more|see plans)\b(\s+\w+){0,3}\s+\bpro\b/.test(raw)) return null;
		if (strict && /\b(upgrade|try|get pro|learn more)\b/.test(raw)) return null;
		if (/\benterprise\b/.test(raw) || /mistralenterprise/.test(compact)) return 'enterprise';
		if (/\bteam\b/.test(raw) || /mistralteam|lechatteam/.test(compact)) return 'team';
		if (/\b(pro|le chat pro)\b/.test(raw) || /lechatpro|mistralpro/.test(compact)) return 'pro';
		if (/\bfree\b/.test(raw)) return 'free';
	}
	if (platform === 'perplexity') {
		if (strict && /\b(upgrade(\s+to)?|try|switch(\s+to)?|get|start|learn more|see plans|start free trial)\b(\s+\w+){0,4}\s+\b(pro|max|enterprise)\b/.test(raw)) return null;
		if (strict && /\b(upgrade|try|get pro|get max|learn more|start free trial)\b/.test(raw)) return null;
		if (/\benterprise\b/.test(raw) || /perplexityenterprise|enterprisemax|enterprisepro/.test(compact)) return 'enterprise';
		if (/\bmax\b/.test(raw) || /perplexitymax|maxplan|planmax/.test(compact)) return 'max';
		if (/\bpro\b/.test(raw) || /perplexitypro|proplan|planpro|subscriptionpro/.test(compact)) return 'pro';
		if (/\bfree\b/.test(raw) || /perplexityfree|freeplan|planfree/.test(compact)) return 'free';
	}
	if (platform === 'grok') {
		if (strict && /\b(upgrade(\s+to)?|try|switch(\s+to)?|get|start|learn more|see plans|start free trial)\b(\s+\w+){0,4}\s+\b(supergrok|premium|heavy|enterprise)\b/.test(raw)) return null;
		if (strict && /\b(upgrade|try|get supergrok|get premium|learn more|start free trial)\b/.test(raw)) return null;
		if (/\benterprise\b/.test(raw) || /grokenterprise/.test(compact)) return 'enterprise';
		if (/\bsuper\s*grok\s*heavy\b/.test(raw) || /supergrokheavy|grokheavy/.test(compact)) return 'supergrok_heavy';
		if (/\bsuper\s*grok\b/.test(raw) || /supergrok/.test(compact)) return 'supergrok';
		// `\b` after `+` cannot match (both `+` and the typical following
		// space are non-word characters; \b needs a word/non-word
		// transition). Use lookahead for end-of-token instead.
		if (/\bpremium\+(?=\s|$|[^\w+])/.test(raw) || /\bx\s*premium\+(?=\s|$|[^\w+])/.test(raw) || /xpremiumplus|premiumplus/.test(compact)) return 'x_premium_plus';
		if (/\bx\s*premium\b/.test(raw) || /\bpremium\b/.test(raw) || /xpremium/.test(compact)) return 'x_premium';
		if (/\bfree\b/.test(raw) || /grokfree|freeplan|planfree/.test(compact)) return 'free';
	}
	return null;
}

function collectPlanSignals(value, depth = 0, keyHint = '') {
	if (value == null || depth > 6) return [];
	if (typeof value === 'string') return [value];
	if (typeof value === 'number' || typeof value === 'boolean') return [`${keyHint}:${value}`];
	if (Array.isArray(value)) return value.flatMap(item => collectPlanSignals(item, depth + 1, keyHint));
	if (typeof value !== 'object') return [];

	// Real provider account APIs nest plan info under wrapper keys that
	// are not themselves "plan-like" (e.g. ChatGPT's
	// /backend-api/me shape: accounts.default.entitlement.subscription_plan).
	// Always recurse into object children -- the depth cap above already
	// bounds the walk. Strings under non-plan keys are still gated by
	// shallow depth so we do not collect arbitrary text bodies.
	const out = [];
	for (const [key, child] of Object.entries(value)) {
		const childKey = String(key).toLowerCase();
		const planKey = /(plan|tier|subscription|entitlement|account|billing|sku|license|workspace|product|paid)/.test(childKey);
		if (child && typeof child === 'object') {
			out.push(...collectPlanSignals(child, depth + 1, planKey ? childKey : keyHint));
		} else if (planKey) {
			out.push(...collectPlanSignals(child, depth + 1, childKey));
		} else if (typeof child === 'string' && depth <= 2) {
			out.push(child);
		}
	}
	return out;
}

function tierFromPayload(platform, payload) {
	const signals = collectPlanSignals(payload).join(' ');
	return tierFromText(platform, signals);
}

async function fetchJson(path) {
	try {
		const resp = await fetch(path, { credentials: 'include', cache: 'no-store' });
		if (!resp.ok) return null;
		return await resp.json();
	} catch {
		return null;
	}
}

function tierFromVisibleDom(platform) {
	const selectors = [
		'[data-testid*="account"]',
		'[data-testid*="plan"]',
		'[aria-label*="Account"]',
		'[aria-label*="Plan"]',
		'nav',
		'aside'
	];
	const text = selectors
		.flatMap(sel => Array.from(document.querySelectorAll(sel)))
		.map(el => el.textContent || '')
		.join(' ');
	return tierFromText(platform, text, { strict: true });
}

const TIER_DETECTION = {
	claude: {
		// Claude tier is detected via API in claude-api.js and bridged to popup storage.
		// This DOM fallback catches the plan name from visible UI elements.
		selectors: [
			'[data-testid="user-menu-button"]',
			'button[aria-label*="Account"]'
		],
		detect: () => {
			for (const selector of TIER_DETECTION.claude.selectors) {
				const tier = tierFromText('claude', document.querySelector(selector)?.textContent || '');
				if (tier) return tier;
			}
			const domTier = tierFromVisibleDom('claude');
			if (domTier) return domTier;
			const body = document.body?.innerText || '';
			return tierFromText('claude', body, { strict: true });
		}
	},
	chatgpt: {
		// ChatGPT shows plan in account menu and model selector.
		// Prefer account API payloads, then fall back to visible account/plan UI.
		detect: async () => {
			try {
				const cacheKey = 'chatgptTierCache';
				const cached = await getTierCache(cacheKey);
				if (cached) return cached;

				const accountPaths = [
					'/backend-api/me',
					'/backend-api/accounts/default',
					'/backend-api/accounts/check/v4-2023-04-27'
				];
				for (const path of accountPaths) {
					const data = await fetchJson(path);
					const tier = data ? tierFromPayload('chatgpt', data) : null;
					if (tier) {
						await setTierCache(cacheKey, tier);
						return tier;
					}
				}

				const domTier = tierFromVisibleDom('chatgpt');
				if (domTier) {
					await setTierCache(cacheKey, domTier);
					return domTier;
				}
				return null;
			} catch (e) { return null; }
		}
	},
	gemini: {
		// Read-only account / entitlement probes. Anything that actually
		// dispatches a model request (e.g. StreamGenerate, GenerateContent)
		// is deliberately excluded -- hitting it here would create a
		// phantom inference call and skew the user's own usage counters.
		// Each path is best-effort: a 401 / 404 / network error just
		// falls through to the next candidate.
		accountPaths: [
			'/api/account',
			'/api/v1/me'
		],
		detect: async () => {
			try {
				const cacheKey = 'geminiTierCache';
				const cached = await getTierCache(cacheKey);
				if (cached) return cached;

				for (const path of TIER_DETECTION.gemini.accountPaths) {
					const data = await fetchJson(path);
					const tier = data ? tierFromPayload('gemini', data) : null;
					if (tier) {
						await setTierCache(cacheKey, tier);
						return tier;
					}
				}

				// DOM fallback. Strict mode filters upsell text so a "Get
				// Gemini Advanced" banner on a free user does not pin them
				// to advanced. The model-selector heuristic is a second
				// signal that is meaningful only when the page has fully
				// hydrated.
				const body = document.body?.innerText || '';
				const visibleTier = tierFromText('gemini', body, { strict: true });
				if (visibleTier) {
					await setTierCache(cacheKey, visibleTier);
					return visibleTier;
				}
				const hasAdvancedModels = document.querySelector('[data-model-id*="ultra"]') ||
					document.querySelector('[data-model-id*="pro"]');
				const modelSelector = document.querySelector('[aria-label*="model"] [aria-selected="true"]');
				const selectedModel = modelSelector?.textContent || '';
				if (hasAdvancedModels || selectedModel.includes('Pro') || selectedModel.includes('Ultra')) {
					await setTierCache(cacheKey, 'advanced');
					return 'advanced';
				}
				// Returning null (rather than 'free') leaves the storage
				// untouched so a previously detected value or manual
				// override is not clobbered by an inconclusive run.
				return null;
			} catch (e) { return null; }
		}
	},
	mistral: {
		accountPaths: [
			'/api/v1/users/me',
			'/api/v1/account',
			'/api/account/me',
			'/api/me'
		],
		detect: async () => {
			try {
				const cacheKey = 'mistralTierCache';
				const cached = await getTierCache(cacheKey);
				if (cached) return cached;

				for (const path of TIER_DETECTION.mistral.accountPaths) {
					const data = await fetchJson(path);
					const tier = data ? tierFromPayload('mistral', data) : null;
					if (tier) {
						await setTierCache(cacheKey, tier);
						return tier;
					}
				}

				const body = document.body?.innerText || '';
				const visibleTier = tierFromText('mistral', body, { strict: true });
				if (visibleTier) {
					await setTierCache(cacheKey, visibleTier);
					return visibleTier;
				}
				const sidebar = document.querySelector('nav, [class*="sidebar"]');
				const sidebarText = sidebar?.textContent || '';
				if (/\b(pro|le chat pro)\b/i.test(sidebarText)) {
					await setTierCache(cacheKey, 'pro');
					return 'pro';
				}
				// Inconclusive -- leave any prior auto or manual value
				// in place rather than overwriting with a guess.
				return null;
			} catch (e) { return null; }
		}
	},
	perplexity: {
		accountPaths: [
			'/api/auth/session',
			'/api/profile',
			'/api/user',
			'/rest/user',
			'/rest/account'
		],
		detect: async () => {
			try {
				const cacheKey = 'perplexityTierCache';
				const cached = await getTierCache(cacheKey);
				if (cached) return cached;

				for (const path of TIER_DETECTION.perplexity.accountPaths) {
					const data = await fetchJson(path);
					const tier = data ? tierFromPayload('perplexity', data) : null;
					if (tier) {
						await setTierCache(cacheKey, tier);
						return tier;
					}
				}

				const visibleTier = tierFromVisibleDom('perplexity');
				if (visibleTier) {
					await setTierCache(cacheKey, visibleTier);
					return visibleTier;
				}
				return null;
			} catch (e) { return null; }
		}
	},
	grok: {
		accountPaths: [
			'/rest/account',
			'/rest/app-user',
			'/api/account',
			'/api/user',
			'/i/api/1.1/account/settings.json'
		],
		detect: async () => {
			try {
				const cacheKey = 'grokTierCache';
				const cached = await getTierCache(cacheKey);
				if (cached) return cached;

				for (const path of TIER_DETECTION.grok.accountPaths) {
					const data = await fetchJson(path);
					const tier = data ? tierFromPayload('grok', data) : null;
					if (tier) {
						await setTierCache(cacheKey, tier);
						return tier;
					}
				}

				const visibleTier = tierFromVisibleDom('grok');
				if (visibleTier) {
					await setTierCache(cacheKey, visibleTier);
					return visibleTier;
				}
				return null;
			} catch (e) { return null; }
		}
	}
};

/**
 * Detect the user's subscription tier for the current platform.
 * Returns the tier string or null if detection fails.
 */
async function detectSubscriptionTier() {
	const detector = TIER_DETECTION[CURRENT_PLATFORM];
	if (!detector?.detect) return null;
	try {
		return await detector.detect();
	} catch (e) {
		return null;
	}
}
