'use strict';

// Constants
const BLUE_HIGHLIGHT = "#2c84db";
const RED_WARNING = "#de2929";
const SUCCESS_GREEN = "#22c55e";

// Security: generate a nonce for verifying CustomEvents from our MAIN-world script.
// Written to a DOM attribute so the MAIN-world script can read it.
// Must be set before event listeners are registered (bottom of this file).
const _eventNonce = crypto.getRandomValues(new Uint32Array(2)).reduce((s, v) => s + v.toString(36), '');
document.documentElement.dataset.aiTrackerNonce = _eventNonce;

const SELECTORS = {
	MODEL_PICKER: '[data-testid="model-selector-dropdown"]',
	CHAT_MENU: '[data-testid="chat-menu-trigger"]',
	MODEL_SELECTOR: '[data-testid="model-selector-dropdown"]',
	INIT_LOGIN_SCREEN: 'button[data-testid="login-with-google"]',
	VERIF_LOGIN_SCREEN: 'input[data-testid="code"]'
};

// FIX #6: Cache debug mode check instead of reading storage every call
let _contentDebugCache = { until: null, checkedAt: 0 };
let FORCE_DEBUG = false;
browser.storage.local.get('force_debug').then(result => {
	FORCE_DEBUG = result.force_debug || false;
	if (!FORCE_DEBUG) {
		window.addEventListener('error', async (event) => await logError(event.error));
		window.addEventListener('unhandledrejection', async (event) => await logError(event.reason));
	}
});

let CONFIG;

// FIX #10: Track extension context validity
let _extensionContextValid = true;

// Sanitize debug log entries before persisting to storage.
function sanitizeStringForDebug(s) {
	if (typeof s !== 'string') return s;
	s = s.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-api-key]');
	s = s.replace(/https?:\/\/[^\s"'`]+/g, (rawUrl) => {
		try { const u = new URL(rawUrl); return `${u.origin}/[redacted-path]`; }
		catch { return '[redacted-url]'; }
	});
	s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted-uuid]');
	s = s.replace(/\b(orgId|organizationId|conversationId|file_uuid|uuid|sync_uuid)\s*[:=]\s*["']?[^"',\s}]+["']?/gi, '$1=[redacted]');
	s = s.replace(/\b(org-[A-Za-z0-9_-]+)\b/g, '[redacted-org-id]');
	if (s.length > 500) return `[redacted-long-string:${s.length}]`;
	return s;
}
function sanitizeForDebug(value, depth = 0) {
	if (depth > 3) return '[truncated]';
	if (value instanceof Error) return sanitizeStringForDebug(`${value.name}: ${value.message}`);
	if (value === null || value === undefined) return value;
	if (typeof value === 'string') return sanitizeStringForDebug(value);
	if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitizeForDebug(v, depth + 1));
	if (typeof value === 'object') {
		const out = {};
		const sensitiveKey = /(api.?key|authorization|cookie|headers|prompt|content|memory|sync|config|uri|url|uuid|org.?id|conversation.?id|text|file)/i;
		for (const [k, v] of Object.entries(value)) {
			out[k] = sensitiveKey.test(k) ? '[redacted]' : sanitizeForDebug(v, depth + 1);
		}
		return out;
	}
	return value;
}

async function Log(...args) {
	if (!_extensionContextValid) return;

	const sender = `content:${CURRENT_PLATFORM || window.location.hostname}`;
	let level = "debug";
	if (typeof args[0] === 'string' && ["debug", "warn", "error"].includes(args[0])) {
		level = args.shift();
	}

	// FIX #6: Cached check
	if (!FORCE_DEBUG) {
		const now = Date.now();
		if (now - _contentDebugCache.checkedAt > 5000) {
			_contentDebugCache.checkedAt = now;
			try {
				const result = await browser.storage.local.get('debug_mode_until');
				_contentDebugCache.until = result.debug_mode_until;
			} catch (e) {
				_extensionContextValid = false;
				return;
			}
		}
		if (!_contentDebugCache.until || _contentDebugCache.until <= Date.now()) return;
	}

	const consoleFn = level === "warn" ? console.warn : level === "error" ? console.error : console.log;
	consoleFn("[AITracker]", ...args);

	const timestamp = new Date().toLocaleString('default', {
		hour: '2-digit', minute: '2-digit', second: '2-digit',
		hour12: false, fractionalSecondDigits: 3
	});

	const logEntry = {
		timestamp, sender, level,
		message: args.map(arg => {
			if (arg === null) return 'null';
			try { return JSON.stringify(sanitizeForDebug(arg), null, 2); }
			catch (e) { return String(sanitizeForDebug(arg)); }
		}).join(' ')
	};

	if (logEntry.message.length > 2000) {
		logEntry.message = logEntry.message.slice(0, 2000) + '...[truncated]';
	}

	try {
		const logsResult = await browser.storage.local.get('debug_logs');
		const logs = logsResult.debug_logs || [];
		logs.push(logEntry);
		while (logs.length > 1000) logs.shift();
		await browser.storage.local.set({ debug_logs: logs });
	} catch (e) {
		_extensionContextValid = false;
	}
}

async function logError(error) {
	if (!(error instanceof Error)) { await Log("error", JSON.stringify(error)); return; }
	await Log("error", error.toString());
	if ("captureStackTrace" in Error) Error.captureStackTrace(error, logError);
	await Log("error", JSON.stringify(error.stack));
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Security: escape dynamic values before innerHTML interpolation to prevent XSS
function escapeHtml(str) {
	if (typeof str !== 'string') return String(str ?? '');
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Formatting: energy and carbon values with adaptive precision
function fmtEnergy(wh) {
	if (!wh || wh === 0) return '0 Wh';
	if (wh < 0.001) return wh.toFixed(6) + ' Wh';
	if (wh < 0.1) return wh.toFixed(4) + ' Wh';
	if (wh < 10) return wh.toFixed(2) + ' Wh';
	if (wh < 1000) return wh.toFixed(1) + ' Wh';
	return (wh / 1000).toFixed(2) + ' kWh';
}

function fmtCarbon(gco2e) {
	if (!gco2e || gco2e === 0) return '0 gCO\u2082e';
	if (gco2e < 0.001) return gco2e.toFixed(6) + ' gCO\u2082e';
	if (gco2e < 0.1) return gco2e.toFixed(4) + ' gCO\u2082e';
	if (gco2e < 10) return gco2e.toFixed(2) + ' gCO\u2082e';
	if (gco2e < 1000) return gco2e.toFixed(1) + ' gCO\u2082e';
	return (gco2e / 1000).toFixed(2) + ' kgCO\u2082e';
}

// Platform detection from current URL
function detectCurrentPlatform() {
	const host = window.location.hostname;
	if (host.includes('claude.ai')) return 'claude';
	if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) return 'chatgpt';
	if (host.includes('gemini.google.com')) return 'gemini';
	if (host.includes('chat.mistral.ai')) return 'mistral';
	return null;
}

const CURRENT_PLATFORM = detectCurrentPlatform();

function getConversationId() {
	if (CURRENT_PLATFORM === 'claude') {
		const match = window.location.pathname.match(/\/chat\/([^/?]+)/);
		return match ? match[1] : null;
	}
	if (CURRENT_PLATFORM === 'chatgpt') {
		const match = window.location.pathname.match(/\/c\/([^/?]+)/);
		return match ? match[1] : null;
	}
	return null;
}

// FIX #10: sendBackgroundMessage with extension context invalidation handling
async function sendBackgroundMessage(message) {
	if (!_extensionContextValid) return null;

	const enrichedMessage = { ...message };
	let counter = 10;
	while (counter > 0) {
		try {
			return await browser.runtime.sendMessage(enrichedMessage);
		} catch (error) {
			const msg = error.message || '';
			if (msg.includes('Receiving end does not exist')) {
				await sleep(200);
			} else if (msg.includes('Extension context invalidated')) {
				_extensionContextValid = false;
				showExtensionInvalidatedBanner();
				return null;
			} else {
				throw error;
			}
		}
		counter--;
	}
	return null;
}

function showExtensionInvalidatedBanner() {
	if (document.getElementById('ut-invalidated-banner')) return;
	const banner = document.createElement('div');
	banner.id = 'ut-invalidated-banner';
	banner.style.cssText = `
		position: fixed; top: 0; left: 0; right: 0; z-index: 100000;
		background: ${RED_WARNING}; color: white; text-align: center;
		padding: 8px; font-size: 13px; font-family: sans-serif; cursor: pointer;
	`;
	banner.textContent = 'AI Cost & Usage Tracker was updated. Click to reload the page.';
	banner.addEventListener('click', () => location.reload());
	document.body.appendChild(banner);
}

async function waitForElement(target, selector, maxTime = 1000) {
	let elapsed = 0;
	const waitInterval = 100;
	while (elapsed < maxTime) {
		const element = target.querySelector(selector);
		if (element) return element;
		await sleep(waitInterval);
		elapsed += waitInterval;
	}
	return null;
}

async function getCurrentModel(maxWait = 3000) {
	if (CURRENT_PLATFORM !== 'claude') return undefined;
	const modelSelector = await waitForElement(document, SELECTORS.MODEL_PICKER, maxWait);
	if (!modelSelector) return undefined;
	let fullModelName = modelSelector.querySelector('.whitespace-nowrap')?.textContent?.trim() || 'default';
	if (!fullModelName || fullModelName === 'default') return undefined;
	fullModelName = fullModelName.toLowerCase();
	for (const modelType of CONFIG.MODELS) {
		if (fullModelName.includes(modelType.toLowerCase())) return modelType;
	}
	return undefined;
}

function isMobileView() { return window.innerHeight > window.innerWidth; }

function isCodePage() {
	return window.location.pathname.includes('claude-code-desktop') || window.location.pathname.includes('/code');
}

function isPeakHours() {
	const now = new Date();
	const day = now.getUTCDay();
	const hour = now.getUTCHours();
	if (day === 0 || day === 6) return false;
	return hour >= 13 && hour < 19;
}

// FIX #11: setupRequestInterception defined once, not duplicated
async function setupRequestInterception(patterns) {
	window.addEventListener('interceptedRequest', async (event) => {
		if (!_extensionContextValid) return;
		if (event.detail?.__nonce !== _eventNonce) return;
		browser.runtime.sendMessage({ type: 'interceptedRequest', details: event.detail });
	});
	window.addEventListener('interceptedResponse', async (event) => {
		if (!_extensionContextValid) return;
		if (event.detail?.__nonce !== _eventNonce) return;
		browser.runtime.sendMessage({ type: 'interceptedResponse', details: event.detail });
	});

	const script = document.createElement('script');
	script.src = browser.runtime.getURL('injections/webrequest-polyfill.js');
	script.dataset.patterns = JSON.stringify(patterns);
	script.onload = function () { this.remove(); };
	(document.head || document.documentElement).appendChild(script);
}

function getResetTimeHTML(timeInfo) {
	const prefix = 'Reset in: ';
	if (!timeInfo || !timeInfo.timestamp || timeInfo.expired) {
		return `${prefix}<span>Not set</span>`;
	}
	const diff = timeInfo.timestamp - Date.now();
	const totalMinutes = Math.round(diff / (1000 * 60));
	if (totalMinutes === 0) return `${prefix}<span style="color: ${BLUE_HIGHLIGHT}"><1m</span>`;
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	const timeString = hours > 0 ? `${hours}h ${minutes}m` : `${totalMinutes}m`;
	return `${prefix}<span style="color: ${BLUE_HIGHLIGHT}">${timeString}</span>`;
}

function setupTooltip(element, tooltip, options = {}) {
	if (!element || !tooltip) return;
	if (element.hasAttribute('data-tooltip-setup')) return;
	element.setAttribute('data-tooltip-setup', 'true');

	const { topOffset = 10 } = options;
	element.classList.add('ut-tooltip-trigger', 'ut-info-item');
	element.style.cursor = 'help';

	let pressTimer, tooltipHideTimer;

	const showTooltip = () => {
		const rect = element.getBoundingClientRect();
		tooltip.style.opacity = '1';
		const tooltipRect = tooltip.getBoundingClientRect();
		let leftPos = rect.left + (rect.width / 2);
		if (leftPos + (tooltipRect.width / 2) > window.innerWidth) leftPos = window.innerWidth - tooltipRect.width - 10;
		if (leftPos - (tooltipRect.width / 2) < 0) leftPos = tooltipRect.width / 2 + 10;
		let topPos = rect.top - tooltipRect.height - topOffset;
		if (topPos < 10) topPos = rect.bottom + 10;
		tooltip.style.left = `${leftPos}px`;
		tooltip.style.top = `${topPos}px`;
		tooltip.style.transform = 'translateX(-50%)';
	};
	const hideTooltip = () => { tooltip.style.opacity = '0'; clearTimeout(tooltipHideTimer); };

	element.addEventListener('pointerdown', (e) => {
		if (e.pointerType === 'touch' || isMobileView()) {
			pressTimer = setTimeout(() => {
				showTooltip();
				tooltipHideTimer = setTimeout(hideTooltip, 3000);
			}, 500);
		}
	});
	element.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch' || isMobileView()) clearTimeout(pressTimer); });
	element.addEventListener('pointercancel', () => { clearTimeout(pressTimer); hideTooltip(); });
	if (!isMobileView()) {
		element.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showTooltip(); });
		element.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hideTooltip(); });
	}
}

// Progress bar component
class ProgressBar {
	constructor(options = {}) {
		const { width = '100%', height = '6px' } = options;
		this.container = document.createElement('div');
		this.container.className = 'ut-progress';
		if (width !== '100%') this.container.style.width = width;
		this.track = document.createElement('div');
		this.track.className = 'bg-bg-500 ut-progress-track';
		if (height !== '6px') this.track.style.height = height;
		this.bar = document.createElement('div');
		this.bar.className = 'ut-progress-bar';
		this.bar.style.background = BLUE_HIGHLIGHT;
		this.tooltip = document.createElement('div');
		this.tooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
		this.track.appendChild(this.bar);
		this.container.appendChild(this.track);
		document.body.appendChild(this.tooltip);
		setupTooltip(this.container, this.tooltip, { topOffset: 10 });
	}

	updateProgress(total, maxTokens) {
		const percentage = (total / maxTokens) * 100;
		this.bar.style.width = `${Math.min(percentage, 100)}%`;
		this.bar.style.background = total >= maxTokens * CONFIG.WARNING.PERCENT_THRESHOLD ? RED_WARNING : BLUE_HIGHLIGHT;
		this.tooltip.textContent = `${total.toLocaleString()} / ${maxTokens.toLocaleString()} credits (${percentage.toFixed(1)}%)`;
	}

	setMarker(percentage, label) {
		if (!this.marker) {
			this.marker = document.createElement('div');
			this.marker.className = 'ut-weekly-marker';
			this.marker.style.setProperty('--marker-color', RED_WARNING);
			this.container.style.paddingTop = '10px';
			this.container.style.marginTop = '-10px';
			this.container.appendChild(this.marker);
			this.markerTooltip = document.createElement('div');
			this.markerTooltip.className = 'bg-bg-500 text-text-000 ut-tooltip';
			document.body.appendChild(this.markerTooltip);
			setupTooltip(this.marker, this.markerTooltip);
		}
		this.marker.style.left = `${Math.min(percentage, 100)}%`;
		this.marker.style.display = 'block';
		if (label) this.markerTooltip.textContent = label;
	}

	clearMarker() {
		if (this.marker) {
			this.marker.style.display = 'none';
			this.container.style.paddingTop = '';
			this.container.style.marginTop = '';
		}
	}
}

// Message handlers for background script requests
browser.runtime.onMessage.addListener(async (message) => {
	if (!_extensionContextValid) return;
	if (message.type === 'getActiveModel') {
		return (await getCurrentModel()) || "Sonnet";
	}
	// Fix 6: Keyboard shortcut to toggle badge visibility
	if (message.type === 'toggleBadgeVisibility') {
		const badge = document.getElementById('ut-platform-badge');
		const sidebar = document.querySelector('.ut-container');
		if (badge) badge.style.display = badge.style.display === 'none' ? '' : 'none';
		if (sidebar) sidebar.style.display = sidebar.style.display === 'none' ? '' : 'none';
		return true;
	}
	if (message.action === "getOrgID") {
		const orgId = document.cookie.split('; ').find(row => row.startsWith('lastActiveOrg='))?.split('=')[1];
		return Promise.resolve({ orgId });
	}
	if (message.action === "getStyleId") {
		const storedStyle = localStorage.getItem('LSS-claude_personalized_style');
		let styleId;
		if (storedStyle) {
			try {
				const styleData = JSON.parse(storedStyle);
				if (styleData) styleId = styleData.styleKey;
			} catch (e) { /* ignore parse errors */ }
		}
		return Promise.resolve({ styleId });
	}
});

// FIX #8: CSS injection via direct link to extension resource (not fetch + data URI)
async function injectStyles() {
	if (document.getElementById('ut-styles')) return;
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.id = 'ut-styles';
	link.href = browser.runtime.getURL('tracker-styles.css');
	document.head.appendChild(link);
}

// Main initialization
async function initExtension() {
	if (window.aiTrackerInstance) {
		Log('Instance already running, stopping');
		return;
	}
	window.aiTrackerInstance = true;

	document.querySelectorAll('[class*="ut-"]').forEach(el => el.remove());
	const oldStyles = document.getElementById('ut-styles');
	if (oldStyles) oldStyles.remove();

	await injectStyles();
	// Inject SSE stream output counter for all platforms
	injectStreamCounter();
	CONFIG = await sendBackgroundMessage({ type: 'getConfig' });
	if (!CONFIG) {
		// Extension context likely invalid
		return;
	}
	await Log("Config received for platform:", CURRENT_PLATFORM);

	if (CURRENT_PLATFORM === 'claude') {
		await initClaudePlatform();
	} else {
		await initGenericPlatform();
	}
}

async function initClaudePlatform() {
	const LOGIN_CHECK_DELAY = 10000;
	while (true) {
		let userMenuButton = await waitForElement(document, 'button[data-testid="user-menu-button"]', 6000);
		if (!userMenuButton) userMenuButton = document.querySelector('button[data-testid="code-user-menu-button"]');

		if (userMenuButton) {
			if (userMenuButton.getAttribute('data-script-loaded')) {
				await Log('Script already running, stopping duplicate');
				return;
			}
			userMenuButton.setAttribute('data-script-loaded', true);
			break;
		}

		const initialLoginScreen = document.querySelector(SELECTORS.INIT_LOGIN_SCREEN);
		const verificationLoginScreen = document.querySelector(SELECTORS.VERIF_LOGIN_SCREEN);
		if (!initialLoginScreen && !verificationLoginScreen) {
			await Log("error", 'Neither user menu button nor any login screen found');
			return;
		}
		await Log('Login screen detected, waiting before retry...');
		await sleep(LOGIN_CHECK_DELAY);
	}

	sendBackgroundMessage({ type: 'requestData' });
	sendBackgroundMessage({ type: 'initOrg' });
	await Log('Claude platform initialization complete.');
}

async function initGenericPlatform() {
	// For ChatGPT, Gemini, Mistral: detect tier and show tracking UI
	await sleep(2000);

	// Auto-detect subscription tier
	if (typeof detectSubscriptionTier === 'function') {
		try {
			const detectedTier = await detectSubscriptionTier();
			if (detectedTier) {
				await sendBackgroundMessage({
					type: 'setSubscriptionTier',
					platform: CURRENT_PLATFORM,
					tier: detectedTier
				});
				await Log(`${CURRENT_PLATFORM}: auto-detected tier: ${detectedTier}`);
			}
		} catch (e) { /* non-critical */ }
	}

	await Log(`${CURRENT_PLATFORM} platform initialization complete.`);
}

// Inject the stream output token counter into page context (all platforms)
function injectStreamCounter() {
	const script = document.createElement('script');
	script.src = browser.runtime.getURL('injections/stream-token-counter.js');
	script.dataset.platform = CURRENT_PLATFORM || 'unknown';
	script.onload = function () { this.remove(); };
	(document.head || document.documentElement).appendChild(script);
}

// Fix 5: Count output tokens with the real o200k tokenizer (available in content script context).
// The stream counter now dispatches raw output text; we tokenize properly here.
window.addEventListener('streamOutputComplete', async (event) => {
	if (!_extensionContextValid) return;
	if (event.detail?.__nonce !== _eventNonce) return;
	const detail = event.detail;
	const outputText = detail.outputText || '';
	if (outputText.length === 0) return;

	let tokenCount = 0;
	try {
		if (typeof GPTTokenizer_o200k_base !== 'undefined') {
			tokenCount = GPTTokenizer_o200k_base.countTokens(outputText);
		} else {
			tokenCount = Math.ceil(outputText.length / 4);
		}
	} catch (e) {
		tokenCount = Math.ceil(outputText.length / 4);
	}

	try {
		await sendBackgroundMessage({
			type: 'recordOutputTokens',
			platform: detail.platform,
			outputTokens: tokenCount
		});
	} catch (e) {
		// Non-critical
	}
});

// Fix 3: Gemini DOM fallback. When SSE parsing fails (protobuf format),
// the DOM observer in stream-token-counter.js dispatches rendered response text.
window.addEventListener('geminiDOMOutput', async (event) => {
	if (!_extensionContextValid) return;
	if (event.detail?.__nonce !== _eventNonce) return;
	const text = event.detail.outputText || '';
	if (text.length === 0) return;

	let tokenCount = 0;
	try {
		if (typeof GPTTokenizer_o200k_base !== 'undefined') {
			tokenCount = GPTTokenizer_o200k_base.countTokens(text);
		} else {
			tokenCount = Math.ceil(text.length / 4);
		}
	} catch (e) {
		tokenCount = Math.ceil(text.length / 4);
	}

	try {
		await sendBackgroundMessage({
			type: 'recordOutputTokens',
			platform: 'gemini',
			outputTokens: tokenCount
		});
	} catch (e) {
		// Non-critical
	}
});

// Listen for rate limit events from the injected script
window.addEventListener('platformRateLimitHit', async (event) => {
	if (!_extensionContextValid) return;
	if (event.detail?.__nonce !== _eventNonce) return;
	const detail = event.detail;
	await Log('warn', 'Rate limit hit:', detail);
	try {
		await sendBackgroundMessage({
			type: 'recordRateLimit',
			platform: detail.platform,
			resetTime: detail.resetTime
		});
	} catch (e) {
		// Ignore
	}
});

(async () => {
	try { await initExtension(); }
	catch (error) { await Log("error", 'Failed to initialize AI Cost & Usage Tracker:', error); }
})();
