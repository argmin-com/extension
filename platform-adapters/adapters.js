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

const TIER_DETECTION = {
	claude: {
		// Claude tier is detected via API in claude-api.js and bridged to popup storage.
		// This DOM fallback catches the plan name from visible UI elements.
		selectors: [
			'[data-testid="user-menu-button"]',
			'button[aria-label*="Account"]'
		],
		detect: () => null // API-based; handled in background.js
	},
	chatgpt: {
		// ChatGPT shows plan in account menu and model selector.
		// Fetch /backend-api/me for authoritative plan info (once per session).
		detect: async () => {
			try {
				const cacheKey = '__aiTrackerChatGPTTier';
				const cached = sessionStorage.getItem(cacheKey);
				if (cached) return cached;
				const resp = await fetch('/backend-api/me', { credentials: 'include' });
				if (!resp.ok) return null;
				const data = await resp.json();
				const plans = data?.accounts?.default?.entitlement?.subscription_plan;
				const planId = plans || data?.account_plan?.subscription_plan || '';
				let tier = 'free';
				if (planId.includes('chatgptpro') || planId.includes('pro')) tier = 'pro';
				else if (planId.includes('team')) tier = 'team';
				else if (planId.includes('plus')) tier = 'plus';
				else if (data?.account_plan?.is_paid_subscription_active) tier = 'plus';
				sessionStorage.setItem(cacheKey, tier);
				return tier;
			} catch (e) { return null; }
		}
	},
	gemini: {
		// Gemini Advanced users see different model options and UI indicators.
		detect: async () => {
			// Check for Advanced indicators in the DOM
			const body = document.body?.innerText || '';
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
			if (body.includes('Le Chat Pro') || body.includes('Pro plan')) return 'pro';
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
