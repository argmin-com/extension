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
		}
	},
	// Approximate per-token pricing (USD per 1M tokens) for cost estimation
	"PRICING": {
		"claude": {
			"Opus": { "input": 15.0, "output": 75.0 },
			"Sonnet": { "input": 3.0, "output": 15.0 },
			"Haiku": { "input": 0.25, "output": 1.25 }
		},
		"chatgpt": {
			"gpt-4o": { "input": 2.50, "output": 10.0 },
			"gpt-4o-mini": { "input": 0.15, "output": 0.60 },
			"gpt-4.1": { "input": 2.0, "output": 8.0 },
			"o3": { "input": 2.0, "output": 8.0 },
			"o4-mini": { "input": 1.10, "output": 4.40 }
		},
		"gemini": {
			"gemini-2.5-pro": { "input": 1.25, "output": 10.0 },
			"gemini-2.5-flash": { "input": 0.15, "output": 0.60 },
			"gemini-2.0-flash": { "input": 0.10, "output": 0.40 }
		},
		"mistral": {
			"mistral-large": { "input": 2.0, "output": 6.0 },
			"mistral-medium": { "input": 2.7, "output": 8.1 },
			"mistral-small": { "input": 0.2, "output": 0.6 }
		}
	}
};

function fillEstimatedCaps(caps) {
	const tierMultipliers = { claude_pro: 1, claude_max_5x: 5, claude_max_20x: 20 };
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

// FIX #1: FORCE_DEBUG must be false in production builds.
// The original shipped with true, causing every log to write to browser.storage.local.
const FORCE_DEBUG = false;

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

// Sanitize debug log entries before persisting to storage.
// Two-step: sanitizeStringForDebug handles values already embedded in strings,
// sanitizeForDebug handles structured objects by key name.
function sanitizeStringForDebug(s) {
	if (typeof s !== 'string') return s;

	// API keys
	s = s.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted-api-key]');

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

async function RawLog(sender, ...args) {
	let level = "debug";
	if (typeof args[0] === 'string' && ["debug", "warn", "error"].includes(args[0])) {
		level = args.shift();
	}
	if (!(await isDebugEnabled())) return;

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
