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

const TIER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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

function tierFromText(platform, text, { strict = false } = {}) {
	const raw = String(text || '').toLowerCase();
	const compact = raw.replace(/[\s_.-]+/g, '');
	if (platform === 'claude') {
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
		if (/\b(advanced|ultra|pro)\b/.test(raw) || /gemini(advanced|ultra|pro)/.test(compact)) return 'advanced';
		if (/\bfree\b/.test(raw)) return 'free';
	}
	if (platform === 'mistral') {
		if (/\b(pro|le chat pro)\b/.test(raw) || /lechatpro|mistralpro/.test(compact)) return 'pro';
		if (/\bfree\b/.test(raw)) return 'free';
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
		// Gemini Advanced users see different model options and UI indicators.
		detect: async () => {
			// Check for Advanced indicators in the DOM
			const body = document.body?.innerText || '';
			const visibleTier = tierFromText('gemini', body, { strict: true });
			if (visibleTier) return visibleTier;
			// Gemini Advanced shows specific model options
			const hasAdvancedModels = document.querySelector('[data-model-id*="ultra"]') ||
				document.querySelector('[data-model-id*="pro"]') ||
				body.includes('Gemini Advanced') ||
				body.includes('1.5 Pro') ||
				body.includes('2.5 Pro');
			// Check the model selector dropdown
			const modelSelector = document.querySelector('[aria-label*="model"] [aria-selected="true"]');
			const selectedModel = modelSelector?.textContent || '';
			if (selectedModel.includes('Pro') || selectedModel.includes('Ultra') || hasAdvancedModels) return 'advanced';
			return 'free';
		}
	},
	mistral: {
		// Mistral shows "Le Chat Pro" in the sidebar.
		detect: async () => {
			const body = document.body?.innerText || '';
			const visibleTier = tierFromText('mistral', body, { strict: true });
			if (visibleTier) return visibleTier;
			// Check sidebar or account area
			const sidebar = document.querySelector('nav, [class*="sidebar"]');
			if (sidebar?.textContent?.includes('Pro')) return 'pro';
			return 'free';
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
