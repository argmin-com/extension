// bg-components/utils.js
// Core utilities for AI Cost & Usage Tracker

const CONFIG = {
	"OUTPUT_TOKEN_MULTIPLIER": 4,
	"MODELS": ["Opus", "Sonnet", "Haiku"],
	"MODEL_WEIGHTS": {
		"Opus": 5,
		"Sonnet": 3,
		"Haiku": 1
	},
	"WARNING_THRESHOLD": 0.9,
	"PEAK_SESSION_MULTIPLIER": 1.5,
	"WARNING": {
		"PERCENT_THRESHOLD": 0.9,
		"LENGTH": 50000,
		"COST": 250000
	},
	"BASE_SYSTEM_PROMPT_LENGTH": 3200,
	"CACHING_MULTIPLIER": 0,
	"EXTRA_USAGE_CACHING_MULTIPLIER": 0.1,
	"TOKEN_CACHING_DURATION_MS": 5 * 60 * 1000,
	"ESTIMATED_CAPS": {
		"claude_free": { "session": 375000 },
		"claude_team": {},
		"claude_pro": {},
		"claude_max_5x": {
			"session": 7.5e6,
			"weekly": 75e6,
			"sonnetWeekly": 45e6
		},
		"claude_max_20x": {}
	},
	// Platform identifiers
	"PLATFORMS": {
		"claude": {
			"name": "Claude",
			"hostPatterns": ["claude.ai"],
			"color": "#d97706"
		},
		"chatgpt": {
			"name": "ChatGPT",
			"hostPatterns": ["chatgpt.com", "chat.openai.com"],
			"color": "#10a37f"
		},
		"gemini": {
			"name": "Gemini",
			"hostPatterns": ["gemini.google.com"],
			"color": "#4285f4"
		},
		"mistral": {
			"name": "Mistral",
			"hostPatterns": ["chat.mistral.ai"],
			"color": "#f97316"
		},
		"perplexity": {
			"name": "Perplexity",
			"hostPatterns": ["perplexity.ai", "www.perplexity.ai"],
			"color": "#14b8a6"
		},
		"grok": {
			"name": "Grok",
			"hostPatterns": ["grok.com"],
			"color": "#111827"
		},
		"meta": {
			"name": "Meta AI",
			"hostPatterns": ["meta.ai", "www.meta.ai"],
			"color": "#0866ff"
		}
	},
	// Approximate per-token pricing (USD per 1M tokens) for cost estimation.
	// Includes cacheRead / cacheWrite rates for providers that publish them, so
	// the Optimize engine can estimate real cache savings accurately.
	"PRICING": {
		"claude": {
			"Opus":   { "input": 15.0, "output": 75.0, "cacheRead": 1.50, "cacheWrite": 18.75 },
			"Sonnet": { "input": 3.0,  "output": 15.0, "cacheRead": 0.30, "cacheWrite": 3.75 },
			"Haiku":  { "input": 0.25, "output": 1.25, "cacheRead": 0.03, "cacheWrite": 0.30 }
		},
		"chatgpt": {
			"gpt-5.5":     { "input": 5.0,  "output": 30.0, "cacheRead": 0.50 },
			"gpt-5.4":     { "input": 2.50, "output": 15.0, "cacheRead": 0.25 },
			"gpt-5.4-mini": { "input": 0.75, "output": 4.50, "cacheRead": 0.075 },
			"gpt-4o":      { "input": 2.50, "output": 10.0, "cacheRead": 1.25 },
			"gpt-4o-mini": { "input": 0.15, "output": 0.60, "cacheRead": 0.075 },
			"gpt-4.1":     { "input": 2.0,  "output": 8.0,  "cacheRead": 0.50 },
			"gpt-5":       { "input": 1.25, "output": 10.0, "cacheRead": 0.125 },
			"gpt-5-mini":  { "input": 0.25, "output": 2.0,  "cacheRead": 0.025 },
			"o3":          { "input": 2.0,  "output": 8.0,  "cacheRead": 0.50 },
			"o4-mini":     { "input": 0.40, "output": 1.60, "cacheRead": 0.10 }
		},
		"gemini": {
			"gemini-2.5-pro":   { "input": 1.25, "output": 10.0, "cacheRead": 0.31 },
			"gemini-2.5-flash": { "input": 0.15, "output": 0.60, "cacheRead": 0.0375 },
			"gemini-2.0-flash": { "input": 0.10, "output": 0.40, "cacheRead": 0.025 }
		},
		"mistral": {
			"mistral-large":  { "input": 2.0, "output": 6.0 },
			"mistral-medium": { "input": 0.4, "output": 1.2 },
			"mistral-small":  { "input": 0.1, "output": 0.3 }
		},
		"perplexity": {
			"sonar":                { "input": 1.0, "output": 1.0,  "request": 0.005 },
			"sonar-pro":            { "input": 3.0, "output": 15.0, "request": 0.006 },
			"sonar-reasoning-pro":  { "input": 2.0, "output": 8.0,  "request": 0.006 },
			"sonar-deep-research":  { "input": 2.0, "output": 8.0 }
		},
		"grok": {
			"grok-4.3":                      { "input": 1.25, "output": 2.50, "cacheRead": 0.20 },
			"grok-4.20-multi-agent-0309":    { "input": 1.25, "output": 2.50, "cacheRead": 0.20 },
			"grok-4.20-0309-reasoning":      { "input": 1.25, "output": 2.50, "cacheRead": 0.20 },
			"grok-4.20-0309-non-reasoning":  { "input": 1.25, "output": 2.50, "cacheRead": 0.20 },
			"grok-4-1-fast-reasoning":       { "input": 0.20, "output": 0.50, "cacheRead": 0.05 },
			"grok-4-1-fast-non-reasoning":   { "input": 0.20, "output": 0.50, "cacheRead": 0.05 }
		},
		// Meta AI on meta.ai is free for consumers, so the user-visible "cost"
		// is always $0. The commented-out costEquivalent values below are
		// approximate public API rates (USD per 1M tokens) for the same Llama
		// models when served through Meta partners (Bedrock, Groq, Together,
		// Replicate). They are kept in source for analytics references and
		// future API-based plan tracking but MUST NOT be applied to user-
		// facing cost totals while the user is on the free consumer surface.
		"meta": {
			// llama-3.3-70b      costEquivalent: { input: 0.59, output: 0.79 }
			"llama-3.3-70b":       { "input": 0, "output": 0 },
			// llama-4-scout      costEquivalent: { input: 0.27, output: 0.85 }
			"llama-4-scout":       { "input": 0, "output": 0 },
			// llama-4-maverick   costEquivalent: { input: 0.50, output: 1.55 }
			"llama-4-maverick":    { "input": 0, "output": 0 },
			// llama-4-behemoth   costEquivalent: { input: 1.80, output: 5.40 } (estimated)
			"llama-4-behemoth":    { "input": 0, "output": 0 }
		}
	}
};

function fillEstimatedCaps(caps) {
	const tierMultipliers = { claude_team: 1, claude_pro: 1, claude_max_5x: 5, claude_max_20x: 20 };
	const tiers = Object.keys(tierMultipliers);

	for (const key of ['session', 'weekly']) {
		const sourceTier = tiers.find(t => caps[t]?.[key] != null);
		if (!sourceTier) continue;
		const proEquivalent = caps[sourceTier][key] / tierMultipliers[sourceTier];
		for (const tier of tiers) {
			caps[tier] ??= {};
			caps[tier][key] ??= proEquivalent * tierMultipliers[tier];
		}
	}

	const max5x = caps.claude_max_5x;
	const max20x = caps.claude_max_20x;
	if (max5x && max20x) {
		if (max5x.sonnetWeekly != null && max20x.sonnetWeekly == null) max20x.sonnetWeekly = max5x.sonnetWeekly * 4;
		else if (max20x.sonnetWeekly != null && max5x.sonnetWeekly == null) max5x.sonnetWeekly = max20x.sonnetWeekly / 4;
	}
	return caps;
}

CONFIG.ESTIMATED_CAPS = fillEstimatedCaps(CONFIG.ESTIMATED_CAPS);

const isElectron = chrome.action === undefined || navigator.userAgent.includes("Electron");

// FIX #1: FORCE_DEBUG reads from storage (development-only flag, must never be true in production).
// Aligns with content script behavior which also reads force_debug from storage.
let FORCE_DEBUG = false;
chrome.storage?.local?.get('force_debug').then(result => {
	FORCE_DEBUG = result?.force_debug || false;
}).catch(() => {});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// FIX #5: Cache debug mode state. The original read storage on every single log call.
let _debugCache = { until: null, checkedAt: 0 };
const DEBUG_CACHE_TTL = 5000;

async function isDebugEnabled() {
	if (FORCE_DEBUG) return true;
	const now = Date.now();
	if (now - _debugCache.checkedAt < DEBUG_CACHE_TTL) {
		return _debugCache.until && _debugCache.until > now;
	}
	_debugCache.checkedAt = now;
	_debugCache.until = await getStorageValue('debug_mode_until');
	return _debugCache.until && _debugCache.until > now;
}

// Per-level debug threshold. The user picks a minimum severity in the
// popup; anything below it is dropped at the gate. Default 'debug' keeps
// the existing behaviour (everything logs once debug_mode is enabled);
// 'warn' or 'error' lets the user capture only the actionable signal
// without the structural noise of every alarm tick / capture line.
const DEBUG_LEVEL_RANK = Object.freeze({ debug: 0, warn: 1, error: 2 });
const DEBUG_LEVELS = Object.freeze(Object.keys(DEBUG_LEVEL_RANK));
function isValidDebugLevel(value) {
	// Use Object.prototype.hasOwnProperty.call to avoid prototype-pollution
	// attacks (a stored key named "__proto__" or "constructor" must never
	// pass validation). Also reject non-string values explicitly.
	return typeof value === 'string'
		&& Object.prototype.hasOwnProperty.call(DEBUG_LEVEL_RANK, value);
}
let _minLevelCache = { value: 'debug', checkedAt: 0 };
async function getDebugMinLevel() {
	const now = Date.now();
	if (now - _minLevelCache.checkedAt < DEBUG_CACHE_TTL) return _minLevelCache.value;
	_minLevelCache.checkedAt = now;
	const stored = await getStorageValue('debug_min_level', 'debug');
	_minLevelCache.value = isValidDebugLevel(stored) ? stored : 'debug';
	return _minLevelCache.value;
}
function levelMeetsThreshold(level, minLevel) {
	const lvl = isValidDebugLevel(level) ? DEBUG_LEVEL_RANK[level] : 0;
	const min = isValidDebugLevel(minLevel) ? DEBUG_LEVEL_RANK[minLevel] : 0;
	return lvl >= min;
}

// Sanitize debug log entries before persisting to storage.
// Two-step: sanitizeStringForDebug handles values already embedded in strings,
// sanitizeForDebug handles structured objects by key name.
function sanitizeStringForDebug(s) {
	if (typeof s !== 'string') return s;

	// API keys (Anthropic, OpenAI, generic)
	s = s.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-api-key]');
	s = s.replace(/sk-proj-[A-Za-z0-9_-]+/g, '[redacted-api-key]');
	s = s.replace(/sk-or-[A-Za-z0-9_-]+/g, '[redacted-api-key]');
	s = s.replace(/Bearer\s+[A-Za-z0-9_.-]{20,}/g, 'Bearer [redacted]');

	// Full URLs -> keep origin only
	s = s.replace(/https?:\/\/[^\s"'`]+/g, (rawUrl) => {
		try {
			const u = new URL(rawUrl);
			return `${u.origin}/[redacted-path]`;
		} catch {
			return '[redacted-url]';
		}
	});

	// UUIDs / long opaque IDs
	s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted-uuid]');

	// Identifier labels embedded in strings
	s = s.replace(/\b(orgId|organizationId|conversationId|file_uuid|uuid|sync_uuid)\s*[:=]\s*["']?[^"',\s}]+["']?/gi, '$1=[redacted]');
	s = s.replace(/\b(org-[A-Za-z0-9_-]+)\b/g, '[redacted-org-id]');

	// Long strings still get truncated
	if (s.length > 500) return `[redacted-long-string:${s.length}]`;

	return s;
}

function sanitizeForDebug(value, depth = 0) {
	if (depth > 3) return '[truncated]';
	if (value instanceof Error) return sanitizeStringForDebug(`${value.name}: ${value.message}`);
	if (value === null || value === undefined) return value;

	if (typeof value === 'string') {
		return sanitizeStringForDebug(value);
	}

	if (Array.isArray(value)) {
		return value.slice(0, 20).map(v => sanitizeForDebug(v, depth + 1));
	}

	if (typeof value === 'object') {
		const out = {};
		const sensitiveKey = /(api.?key|authorization|cookie|headers|prompt|content|memory|sync|config|uri|url|uuid|org.?id|conversation.?id|text|file)/i;
		for (const [k, v] of Object.entries(value)) {
			if (sensitiveKey.test(k)) {
				out[k] = '[redacted]';
			} else {
				out[k] = sanitizeForDebug(v, depth + 1);
			}
		}
		return out;
	}

	return value;
}

// Opt-in error-report capture: when the user enables it in the popup,
// every warn/error log entry is appended to a persistent ring buffer
// that the user can later download as a JSON file. This is independent
// of `debug_mode_until` -- the user does NOT have to keep debug mode on
// to capture errors. Sanitization is applied (same path as debug logs)
// so prompt content, API keys, conversation IDs, etc. never enter the
// buffer. Buffer is capped to prevent unbounded growth.
const ERROR_REPORT_MAX_ENTRIES = 500;

async function appendErrorReportEntry(entry) {
	try {
		const optIn = await getStorageValue('errorReportOptIn', false);
		if (!optIn) return;
		const buffer = await getStorageValue('errorReportBuffer', []);
		buffer.push(entry);
		while (buffer.length > ERROR_REPORT_MAX_ENTRIES) buffer.shift();
		await setStorageValue('errorReportBuffer', buffer);
	} catch {
		// Capture must never break the caller.
	}
}

function buildLogEntry(sender, level, args) {
	const timestamp = new Date().toLocaleString('default', {
		hour: '2-digit', minute: '2-digit', second: '2-digit',
		hour12: false, fractionalSecondDigits: 3
	});
	const entry = {
		timestamp, sender, level,
		message: args.map(arg => {
			if (arg === null) return 'null';
			try { return JSON.stringify(sanitizeForDebug(arg), null, 2); }
			catch (e) { return String(sanitizeForDebug(arg)); }
		}).join(' ')
	};
	if (entry.message.length > 2000) {
		entry.message = entry.message.slice(0, 2000) + '...[truncated]';
	}
	return entry;
}

async function RawLog(sender, ...args) {
	let level = "debug";
	if (typeof args[0] === 'string' && ["debug", "warn", "error"].includes(args[0])) {
		level = args.shift();
	}

	const consoleFn = level === "warn" ? console.warn : level === "error" ? console.error : console.log;

	// warn/error entries persist to the error-report buffer when the user
	// opts in, regardless of whether debug mode is on. This is the
	// channel a user shares with you when filing a bug. Sanitized by the
	// same path as debug logs so prompts / keys / IDs never leak.
	if (level === 'warn' || level === 'error') {
		const reportEntry = buildLogEntry(sender, level, args);
		// Fire-and-forget; never blocks the caller. Failures are swallowed.
		appendErrorReportEntry(reportEntry).catch(() => {});
	}

	if (!(await isDebugEnabled())) return;

	// Per-level threshold: when the user has set debug_min_level to
	// 'warn' or 'error', drop everything below the threshold at the gate.
	// Default 'debug' preserves the prior behaviour.
	const minLevel = await getDebugMinLevel();
	if (!levelMeetsThreshold(level, minLevel)) return;

	consoleFn("[AITracker]", ...args);

	const logEntry = buildLogEntry(sender, level, args);
	const logs = await getStorageValue('debug_logs', []);
	logs.push(logEntry);
	while (logs.length > 1000) logs.shift();
	await setStorageValue('debug_logs', logs);
}

async function Log(...args) { await RawLog("utils", ...args); }

// Platform detection from URL
function detectPlatform(url) {
	if (!url) return null;
	try {
		const hostname = new URL(url).hostname;
		for (const [id, cfg] of Object.entries(CONFIG.PLATFORMS)) {
			if (cfg.hostPatterns.some(h => hostname.includes(h))) return id;
		}
	} catch (e) { /* invalid URL */ }
	return null;
}

async function containerFetch(url, options = {}, cookieStoreId = null) {
	if (!cookieStoreId || cookieStoreId === "0" || isElectron) return fetch(url, options);
	const headers = options.headers || {};
	headers['X-Container'] = cookieStoreId;
	options.headers = headers;
	return fetch(url, options);
}

async function addContainerFetchListener() {
	if (isElectron || !chrome.cookies) return;
	const stores = await browser.cookies.getAllCookieStores();
	const isFirefoxContainers = stores[0]?.id === "firefox-default";
	if (!isFirefoxContainers) return;

	await Log("Firefox containers detected, registering blocking listener...");
	browser.webRequest.onBeforeSendHeaders.addListener(
		async (details) => {
			const containerStore = details.requestHeaders.find(h => h.name === 'X-Container')?.value;
			if (!containerStore) return { requestHeaders: details.requestHeaders };

			const domain = new URL(details.url).hostname;
			const domainCookies = await browser.cookies.getAll({ domain, storeId: containerStore });

			if (domainCookies.length > 0) {
				let cookieHeader = details.requestHeaders.find(h => h.name === 'Cookie');
				if (!cookieHeader) {
					cookieHeader = { name: 'Cookie', value: '' };
					details.requestHeaders.push(cookieHeader);
				}
				cookieHeader.value = domainCookies.map(c => `${c.name}=${c.value}`).join('; ');
			}

			details.requestHeaders = details.requestHeaders.filter(h => h.name !== 'X-Container');
			return { requestHeaders: details.requestHeaders };
		},
		{ urls: ["<all_urls>"] },
		["blocking", "requestHeaders"]
	);
}


// FIX #3 + #16: StoredMap with debounced writes and periodic expired-entry cleanup.
// Original wrote the entire map on every set/delete. A single message exchange
// triggered 5-10+ full serializations. Now batches writes with a 100ms debounce.
class StoredMap {
	constructor(storageKey) {
		this.storageKey = storageKey;
		this.map = new Map();
		this.initialized = null;
		this._writeTimer = null;
		this._writeDelay = 100;
		this._cleanupInterval = setInterval(() => this._cleanupExpired(), 5 * 60 * 1000);
		this._storageChangeListener = (changes, areaName) => {
			if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, this.storageKey)) return;
			if (this._writeTimer) { clearTimeout(this._writeTimer); this._writeTimer = null; }
			const nextValue = changes[this.storageKey].newValue;
			this.map = new Map(Array.isArray(nextValue) ? nextValue : []);
			this.initialized = Promise.resolve();
		};
		browser.storage?.onChanged?.addListener?.(this._storageChangeListener);
	}

	async ensureInitialized() {
		if (!this.initialized) {
			this.initialized = getStorageValue(this.storageKey, []).then(arr => {
				this.map = new Map(arr);
			});
		}
		return this.initialized;
	}

	_schedulePersist() {
		if (this._writeTimer) clearTimeout(this._writeTimer);
		this._writeTimer = setTimeout(async () => {
			this._writeTimer = null;
			try { await setStorageValue(this.storageKey, Array.from(this.map)); }
			catch (e) { console.error(`[StoredMap:${this.storageKey}] persist error:`, e); }
		}, this._writeDelay);
	}

	async flush() {
		if (this._writeTimer) { clearTimeout(this._writeTimer); this._writeTimer = null; }
		await setStorageValue(this.storageKey, Array.from(this.map));
	}

	async set(key, value, lifetime = null) {
		await this.ensureInitialized();
		this.map.set(key, lifetime ? { value, expires: Date.now() + lifetime } : value);
		this._schedulePersist();
	}

	async get(key) {
		await this.ensureInitialized();
		const v = this.map.get(key);
		if (!v) return undefined;
		if (!v.expires) return v;
		if (Date.now() > v.expires) { await this.delete(key); return undefined; }
		return v.value;
	}

	async has(key) {
		await this.ensureInitialized();
		const v = this.map.get(key);
		if (!v) return false;
		if (!v.expires) return true;
		if (Date.now() > v.expires) { await this.delete(key); return false; }
		return true;
	}

	async delete(key) {
		await this.ensureInitialized();
		this.map.delete(key);
		this._schedulePersist();
	}

	async entries() {
		await this.ensureInitialized();
		const entries = [];
		const expired = [];
		for (const [key, val] of this.map.entries()) {
			if (val && val.expires && Date.now() > val.expires) { expired.push(key); continue; }
			entries.push([key, val.expires ? val.value : val]);
		}
		if (expired.length) { expired.forEach(k => this.map.delete(k)); this._schedulePersist(); }
		return entries;
	}

	async clear() { this.map.clear(); await setStorageValue(this.storageKey, []); }

	async _cleanupExpired() {
		await this.ensureInitialized();
		const now = Date.now();
		let cleaned = 0;
		for (const [key, val] of this.map.entries()) {
			if (val && val.expires && now > val.expires) { this.map.delete(key); cleaned++; }
		}
		if (cleaned > 0) this._schedulePersist();
	}

	destroy() {
		if (this._cleanupInterval) clearInterval(this._cleanupInterval);
		if (this._writeTimer) clearTimeout(this._writeTimer);
		browser.storage?.onChanged?.removeListener?.(this._storageChangeListener);
	}
}


function getOrgStorageKey(orgId, type) {
	return `aiTracker_v7_${orgId}_${type}`;
}

async function setStorageValue(key, value) {
	await browser.storage.local.set({ [key]: value });
	return true;
}

async function getStorageValue(key, defaultValue = null) {
	const result = await browser.storage.local.get(key) || {};
	return result[key] ?? defaultValue;
}

async function removeStorageValue(key) {
	await browser.storage.local.remove(key);
	return true;
}

// FIX #4: sendTabMessage no longer throws after retries exhausted.
// Tab messaging failures are non-fatal. Also catches "Extension context invalidated" (#10).
async function sendTabMessage(tabId, message, maxRetries = 10, delay = 100) {
	if (typeof tabId !== 'number' || tabId < 0) return undefined;
	let counter = maxRetries;
	while (counter > 0) {
		try {
			return await browser.tabs.sendMessage(tabId, message);
		} catch (error) {
			const msg = error.message || '';
			if (msg.includes('Receiving end does not exist') || msg.includes('Extension context invalidated')) {
				await new Promise(r => setTimeout(r, delay));
			} else {
				throw error;
			}
		}
		counter--;
	}
	return undefined;
}

class MessageHandlerRegistry {
	constructor() { this.handlers = new Map(); }

	register(messageTypeOrHandler, handlerFn = null) {
		if (typeof messageTypeOrHandler === 'function') {
			this.handlers.set(messageTypeOrHandler.name, messageTypeOrHandler);
		} else {
			this.handlers.set(messageTypeOrHandler, handlerFn);
		}
	}

	async handle(message, sender) {
		// Security: validate that messages come from our own extension
		if (sender && sender.id && sender.id !== chrome.runtime.id) {
			await Log("warn", "Rejected message from unauthorized sender:", sender.id);
			return null;
		}
		// Security: validate message structure before dispatching
		if (!message || typeof message.type !== 'string') return null;
		const handler = this.handlers.get(message.type);
		if (!handler) return null;
		return handler(message, sender, message.orgId);
	}
}
const messageRegistry = new MessageHandlerRegistry();

export {
	CONFIG, isElectron, sleep, RawLog, FORCE_DEBUG,
	containerFetch, addContainerFetchListener,
	StoredMap, getOrgStorageKey,
	getStorageValue, setStorageValue, removeStorageValue,
	sendTabMessage, messageRegistry, detectPlatform, Log
};
