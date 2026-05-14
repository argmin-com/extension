import './lib/browser-polyfill.min.js';
import './lib/o200k_base.js';
import { CONFIG, isElectron, sleep, RawLog, FORCE_DEBUG, containerFetch, addContainerFetchListener, StoredMap, getStorageValue, setStorageValue, removeStorageValue, getOrgStorageKey, sendTabMessage, messageRegistry, detectPlatform } from './bg-components/utils.js';
import { tokenStorageManager, tokenCounter } from './bg-components/tokenManagement.js';
import { ClaudeAPI, ConversationAPI } from './bg-components/claude-api.js';
import { UsageData } from './shared/dataclasses.js';
import { scheduleAlarm, getAlarm, createNotification } from './bg-components/electron-compat.js';
import { PLATFORM_INTERCEPT_PATTERNS, getAllInterceptUrls, detectPlatformFromUrl } from './bg-components/platforms/intercept-patterns.js';
import { platformUsageStore, limitForecaster } from './bg-components/platforms/platform-base.js';
import { estimateImpact, getRegions, getMethodology, compareModels } from './bg-components/carbon-energy.js';
import { getModelRecommendation, detectAnomaly, getBudgets, setBudgets, checkBudgets, computeEfficiency, previewCost } from './bg-components/decision-engine.js';
import { evaluateDecision, recordUserAction } from './bg-components/decision-orchestrator.js';
import { getUserProfile, updateUserProfile, getSessionSummary, genSessionId } from './bg-components/event-store.js';
import { sessionTracker } from './bg-components/session-tracker.js';
import { runOptimize } from './bg-components/optimize-engine.js';
import { compareModelsReal, availableModels } from './bg-components/compare-engine.js';
import { getCurrency, setCurrency, resetCurrency, convertUSD, formatUSD, listCurrencies, fetchRate } from './bg-components/currency.js';
import { getPlan, setPlan, resetPlan, getPlanInsights, listPlans } from './bg-components/plan-tracker.js';
import { resolveModel, setUserAlias, removeUserAlias, listUserAliases } from './bg-components/model-aliases.js';
import { buildExport } from './bg-components/exporter.js';
import { exportUsageCSV, exportFindingsCSV, exportAllJSON, buildMonthlySummary } from './bg-components/reports-export.js';
import { classifyCodeburn } from './bg-components/codeburn-classifier.js';
import { handleUsageInsights } from './bg-components/usage-insights.js';

//#region Variable declarations
let processingLock = null;
const pendingTasks = [];
const LOCK_TIMEOUT = 30000;
let pendingRequests;
let scheduledNotifications;
let electronPollingInterval = null;
let electronPollInFlight = false;

let isInitialized = false;
let functionsPendingUntilInitialization = [];

function runOnceInitialized(fn, args) {
	if (!isInitialized) {
		functionsPendingUntilInitialization.push({ fn, args });
		return;
	}
	return fn(...args);
}
//#endregion

//#region Listener setup
browser.runtime.onMessage.addListener(async (message, sender) => {
	return runOnceInitialized(handleMessageFromContent, [message, sender]);
});

if (!isElectron) {
	// Extension icon click handled by popup (action.default_popup in manifest)
}

// Context menu items removed; debug and donate links are in popup.html header

// Clean up lastModelByTab when browser tabs close (non-Electron)
if (!isElectron && browser.tabs?.onRemoved) {
	browser.tabs.onRemoved.addListener((tabId) => {
		for (const key of lastModelByTab.keys()) {
			if (key.endsWith(`:${tabId}`)) lastModelByTab.delete(key);
		}
	});
}

// Fix 6: Keyboard shortcut handler for toggle-badge command
if (chrome.commands) {
	chrome.commands.onCommand.addListener(async (command) => {
		if (command === 'toggle-badge') {
			const tabs = await browser.tabs.query({ active: true, currentWindow: true });
			if (tabs.length > 0) {
				sendTabMessage(tabs[0].id, { type: 'toggleBadgeVisibility' });
			}
		}
	});
}

if (!isElectron) {
	// Claude-specific webRequest listeners
	browser.webRequest.onBeforeRequest.addListener(
		(details) => runOnceInitialized(onBeforeRequestHandler, [details]),
		{ urls: getAllInterceptUrls('onBeforeRequest') },
		["requestBody"]
	);

	browser.webRequest.onCompleted.addListener(
		(details) => runOnceInitialized(onCompletedHandler, [details]),
		{ urls: getAllInterceptUrls('onCompleted') },
		["responseHeaders"]
	);

	addContainerFetchListener();
}

// Alarm listeners
async function handleAlarm(alarmName) {
	// Alarms fire on a fixed schedule (every ~3min for resetNotifications)
	// and are usually a no-op. RawLog is binary (all-or-nothing once
	// debug_mode is enabled), so a per-tick "Alarm triggered" line spams
	// the debug stream whenever a user opens the popup. Skip the tick
	// log entirely -- the dispatched handler is responsible for logging
	// when it has real work to do. Unknown alarms still surface as a
	// warning so accidental regressions are not silenced.
	if (alarmName === 'checkResetNotifications') {
		await checkResetNotifications();
	} else {
		await Log("warn", "Unknown alarm fired", { alarmName });
	}
}

async function checkResetNotifications() {
	const enabled = await getStorageValue('resetNotifEnabled', false);
	if (!enabled) return;

	const entries = await scheduledNotifications.entries();
	if (!entries || entries.length === 0) return;
	await Log("debug", `checkResetNotifications: evaluating ${entries.length} scheduled entries`);

	const now = Date.now();
	let shouldNotify = false;

	for (const [timestampKey, orgId] of entries) {
		const resetTime = parseInt(timestampKey);
		if (resetTime > now) continue;
		if (now - resetTime > 10 * 60 * 1000) {
			await scheduledNotifications.delete(timestampKey);
			continue;
		}

		try {
			const tabs = await browser.tabs.query({ url: "*://claude.ai/*" });
			if (tabs.length === 0) {
				await scheduledNotifications.delete(timestampKey);
				continue;
			}
			const tab = tabs[0];
			const tabOrgId = await requestActiveOrgId(tab);
			const api = new ClaudeAPI(tab.cookieStoreId, tabOrgId);
			const usageData = await api.getUsageData();
			const sessionLimit = usageData.limits.session;
			if (!sessionLimit || sessionLimit.percentage === 0) shouldNotify = true;
		} catch (error) {
			await Log("warn", "Error checking reset status:", error);
		}
		await scheduledNotifications.delete(timestampKey);
	}

	if (shouldNotify) {
		try {
			await createNotification({
				type: 'basic',
				iconUrl: browser.runtime.getURL('icon128.png'),
				title: 'AI Usage Reset',
				message: 'Your usage limit has been reset!'
			});
			await Log("warn", "Reset notification fired", { processedEntries: entries.length });
		} catch (error) {
			await Log("error", "Failed to create reset notification:", error?.message || String(error));
		}
	}

	// HIGH-4: Mark all processed reset times as notified to prevent re-scheduling
	for (const [timestampKey] of entries) {
		const resetTime = parseInt(timestampKey);
		if (resetTime <= now) {
			await notifiedResets.set(timestampKey, true, 24 * 60 * 60 * 1000);
		}
	}
}

let alarmListenerRegistered = false;
if (chrome.alarms) {
	if (!alarmListenerRegistered) {
		alarmListenerRegistered = true;
		chrome.alarms.onAlarm.addListener(alarm => handleAlarm(alarm.name));
	}
} else {
	messageRegistry.register('electron-alarm', (msg) => handleAlarm(msg.name));
}
//#endregion


async function Log(...args) { await RawLog("background", ...args); }

async function logError(error) {
	if (!(error instanceof Error)) { await Log("error", JSON.stringify(error)); return; }
	await Log("error", error.toString());
	if ("captureStackTrace" in Error) Error.captureStackTrace(error, logError);
	await Log("error", JSON.stringify(error.stack));
}


async function requestActiveOrgId(tab) {
	if (!tab) return null;
	if (typeof tab === "number") tab = await browser.tabs.get(tab);
	if (chrome.cookies) {
		try {
			const cookie = await browser.cookies.get({ name: 'lastActiveOrg', url: tab.url, storeId: tab.cookieStoreId });
			if (cookie?.value) return cookie.value;
		} catch (error) {
			await Log("error", "Error getting cookie directly:", error);
		}
	}
	try {
		const response = await sendTabMessage(tab.id, { action: "getOrgID" });
		return response?.orgId;
	} catch (error) {
		await Log("error", "Error getting org ID from content script:", error);
		return null;
	}
}


//#region Messaging
async function updateAllTabsWithUsage(usageData = null) {
	// FIX #9: Fetch once and broadcast to all tabs, not once-per-tab
	const claudeTabs = await browser.tabs.query({ url: "*://claude.ai/*" });

	if (!usageData && claudeTabs.length > 0) {
		try {
			const orgId = await requestActiveOrgId(claudeTabs[0]);
			const api = new ClaudeAPI(claudeTabs[0].cookieStoreId, orgId);
			usageData = await api.getUsageData();
			if (usageData?.subscriptionTier) await platformUsageStore.setSubscriptionTier('claude', usageData.subscriptionTier);
		} catch (e) {
			await Log("warn", "Failed to fetch usage data for broadcast:", e);
			return;
		}
	}

	if (usageData) {
		if (usageData.subscriptionTier) await platformUsageStore.setSubscriptionTier('claude', usageData.subscriptionTier);
		for (const tab of claudeTabs) {
			sendTabMessage(tab.id, { type: 'updateUsage', data: { usageData: usageData.toJSON() } });
		}
	}
}

async function updateTabWithConversationData(tabId, conversationData) {
	sendTabMessage(tabId, {
		type: 'updateConversationData',
		data: { conversationData: conversationData.toJSON() }
	});
}

// Message registry handlers
messageRegistry.register('getConfig', () => CONFIG);
messageRegistry.register('initOrg', async (message, sender) => {
	const orgId = await requestActiveOrgId(sender.tab);
	if (orgId) await tokenStorageManager.addOrgId(orgId);
	return true;
});
messageRegistry.register('getAPIKey', () => getStorageValue('apiKey'));
messageRegistry.register('setAPIKey', async (message) => {
	const newKey = message.newKey;
	if (newKey === "") { await removeStorageValue('apiKey'); return true; }
	const isValid = await tokenCounter.testApiKey(newKey);
	if (isValid) { await setStorageValue('apiKey', newKey); return true; }
	return false;
});
messageRegistry.register('getResetNotifEnabled', () => getStorageValue('resetNotifEnabled', false));
messageRegistry.register('setResetNotifEnabled', (message) => setStorageValue('resetNotifEnabled', message.value));
messageRegistry.register('isElectron', () => isElectron);
messageRegistry.register('getMonkeypatchPatterns', () => isElectron ? PLATFORM_INTERCEPT_PATTERNS : false);
messageRegistry.register('getPlatformUsageToday', async (message) => {
	return await platformUsageStore.getAllPlatformsToday();
});
messageRegistry.register('getPlatformHistory', async (message) => {
	return await platformUsageStore.getHistory(message.platform, message.days || 7);
});
// Track last model used per platform:tab for output token attribution
const lastModelByTab = new Map();
const recentGenericRequestFingerprints = new Map();
const GENERIC_REQUEST_DEDUPE_TTL_MS = 5000;
const CLAUDE_BROWSER_FALLBACK_DEDUPE_TTL_MS = 30000;
const GENERIC_REQUEST_FINGERPRINT_RETENTION_MS = Math.max(
	GENERIC_REQUEST_DEDUPE_TTL_MS,
	CLAUDE_BROWSER_FALLBACK_DEDUPE_TTL_MS
);
const SUPPORTED_BROWSER_PLATFORMS = ['claude', 'chatgpt', 'gemini', 'mistral', 'perplexity', 'grok', 'meta', 'copilot'];

// In-memory only: holds the user's raw prompt text just long enough to
// classify the activity once the response lands. Bound by a TTL so a
// pending request that never completes is reclaimed automatically.
// MUST stay in-memory -- the prompt body never goes to chrome.storage.local.
const pendingPromptTextByKey = new Map();
const PENDING_PROMPT_TEXT_TTL_MS = 10 * 60 * 1000;
const PENDING_REQUEST_TTL_MS = 10 * 60 * 1000;

function rememberPendingPromptText(key, promptText) {
	if (!key || !promptText) return;
	const now = Date.now();
	for (const [entryKey, entry] of pendingPromptTextByKey.entries()) {
		if (!entry?.expires || entry.expires <= now) pendingPromptTextByKey.delete(entryKey);
	}
	pendingPromptTextByKey.set(key, {
		text: String(promptText).slice(0, 8000),
		expires: now + PENDING_PROMPT_TEXT_TTL_MS
	});
}

function takePendingPromptText(key) {
	const entry = pendingPromptTextByKey.get(key);
	pendingPromptTextByKey.delete(key);
	if (!entry || entry.expires <= Date.now()) return '';
	return entry.text || '';
}

function hashForDedupe(value) {
	let text = '';
	try {
		text = typeof value === 'string' ? value : JSON.stringify(value);
	} catch {
		text = String(value || '');
	}
	let h = 2166136261 >>> 0;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h.toString(36);
}

function normalizedRequestPath(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return String(url || '').split('?')[0];
	}
}

function pruneGenericRequestFingerprints(now = Date.now()) {
	for (const [key, ts] of recentGenericRequestFingerprints.entries()) {
		if (now - ts > GENERIC_REQUEST_FINGERPRINT_RETENTION_MS) recentGenericRequestFingerprints.delete(key);
	}
}

function genericRequestFingerprintKey(details, platform, parsedBody) {
	// Page-context messages and webRequest events can disagree on tabId
	// during MV3 service-worker handoff. Dedupe on the stable request
	// identity instead so the same browser call is not counted twice.
	return [
		platform,
		String(details.method || 'POST').toUpperCase(),
		normalizedRequestPath(details.url),
		hashForDedupe(parsedBody)
	].join(':');
}

function hasRecentGenericRequestFingerprint(details, platform, parsedBody, ttlMs = GENERIC_REQUEST_DEDUPE_TTL_MS) {
	const now = Date.now();
	pruneGenericRequestFingerprints(now);
	const key = genericRequestFingerprintKey(details, platform, parsedBody);
	const previous = recentGenericRequestFingerprints.get(key);
	return !!(previous && now - previous <= ttlMs);
}

function markGenericRequestFingerprint(details, platform, parsedBody) {
	pruneGenericRequestFingerprints();
	recentGenericRequestFingerprints.set(genericRequestFingerprintKey(details, platform, parsedBody), Date.now());
}

function shouldSkipDuplicateGenericRequest(details, platform, parsedBody) {
	if (hasRecentGenericRequestFingerprint(details, platform, parsedBody)) return true;
	markGenericRequestFingerprint(details, platform, parsedBody);
	return false;
}

// Output token recording from stream interceptor
messageRegistry.register('recordOutputTokens', async (message, sender) => {
	const { platform, outputTokens } = message;
	if (!SUPPORTED_BROWSER_PLATFORMS.includes(platform)) return null;
	const rawOutputTokens = Math.max(0, Number(outputTokens) || 0);
	if (!rawOutputTokens) return null;
	const tabId = sender?.tab?.id;
	const model = await resolveModel(lastModelByTab.get(`${platform}:${tabId}`) || message.model || 'unknown');
	const updated = await platformUsageStore.recordOutputTokens(platform, model, rawOutputTokens, { source: message.source || 'outputStream' });
	const calibratedOutputTokens = platformUsageStore.calibrateTokens(platform, rawOutputTokens, 'output');

	// Estimate energy and carbon impact for output tokens
	const region = await getStorageValue('carbonRegion', 'us-average');
	const impact = estimateImpact(model, 0, calibratedOutputTokens, region);
	await platformUsageStore.addImpact(platform, impact.energy.estimateWh, impact.carbon.estimateGco2e);
	await platformUsageStore.store.flush();

	return updated;
});

messageRegistry.register('recordPlatformRequest', async (message, sender) => {
	const url = message.url || sender?.tab?.url || '';
	const platform = message.platform || detectPlatform(url);
	if (!platform || !SUPPORTED_BROWSER_PLATFORMS.includes(platform)) return false;

	const bodyText = typeof message.bodyText === 'string' ? message.bodyText.slice(0, 120000) : '';
	if (!bodyText) return false;

	try {
		const details = {
			url,
			method: String(message.method || 'POST').toUpperCase(),
			tabId: sender?.tab?.id,
			cookieStoreId: sender?.tab?.cookieStoreId,
			requestBody: {
				fromMonkeypatch: true,
				raw: [{ bytes: bodyText }]
			}
		};
		if (platform === 'claude') await handleClaudeBrowserRequest(details);
		else await handleGenericBeforeRequest(details, platform);
	} finally {
		await platformUsageStore.store.flush();
		await platformUsageStore.velocityStore.flush();
	}
	return true;
});
// Rate limit recording
messageRegistry.register('recordRateLimit', async (message) => {
	await platformUsageStore.recordRateLimit(message.platform, message.resetTime);
	return true;
});
// Forecast retrieval
messageRegistry.register('getForecast', async (message) => {
	const { platform, claudeUsageData } = message;
	return await limitForecaster.getForecast(platform, claudeUsageData);
});
messageRegistry.register('getAllForecasts', async () => {
	const result = {};
	for (const pid of Object.keys(CONFIG.PLATFORMS)) {
		result[pid] = await limitForecaster.getForecast(pid);
	}
	return result;
});
// Subscription tier management
messageRegistry.register('getSubscriptionTier', async (message) => {
	return await platformUsageStore.getSubscriptionTier(message.platform);
});
messageRegistry.register('setSubscriptionTier', async (message) => {
	// Default source = manual: this handler is invoked from popup tier
	// selects and content-script tier-badge selects, both of which are
	// direct user actions. Auto-detection paths pass source: 'auto' on
	// the wire. Anything not in the allowlist coerces to 'manual' so a
	// stray empty string from a future caller still gets sticky behavior.
	const source = message.source === 'auto' ? 'auto' : 'manual';
	await platformUsageStore.setSubscriptionTier(message.platform, message.tier, source);
	return true;
});
messageRegistry.register('getSubscriptionTierSource', async (message) => {
	return await platformUsageStore.getSubscriptionTierSource(message.platform);
});

// Debug-mode duration: opt-in time-boxed verbose logging. The user picks
// a duration in the popup; we stamp `debug_mode_until = now + duration`
// and isDebugEnabled() automatically flips off after the deadline. The
// stamp is the single source of truth -- there's no rolling timer that
// needs to be restored across SW restarts.
const DEBUG_DURATION_PRESETS_MS = {
	'15m': 15 * 60 * 1000,
	'1h':   60 * 60 * 1000,
	'4h':  4 * 60 * 60 * 1000,
	'24h': 24 * 60 * 60 * 1000
};
messageRegistry.register('getDebugMode', async () => {
	const until = await getStorageValue('debug_mode_until', 0);
	const now = Date.now();
	const active = !!until && until > now;
	return {
		active,
		until: active ? until : null,
		remainingMs: active ? until - now : 0,
		presets: DEBUG_DURATION_PRESETS_MS
	};
});

// Per-level threshold: filter the debug stream at the gate so the user
// can capture only warnings + errors when debug mode is on.
messageRegistry.register('getDebugMinLevel', async () => {
	// Validate stored value -- storage may contain garbage from a prior
	// manual edit or a previously-different schema. Default if invalid.
	const allowed = ['debug', 'warn', 'error'];
	const stored = await getStorageValue('debug_min_level', 'debug');
	return allowed.includes(stored) ? stored : 'debug';
});
messageRegistry.register('setDebugMinLevel', async (message) => {
	const allowed = ['debug', 'warn', 'error'];
	// Strict allowlist on the incoming value AND ensure it's a string;
	// `[].includes(undefined)` returns false but we also want non-string
	// shapes (objects, arrays) explicitly rejected.
	const candidate = typeof message?.level === 'string' ? message.level : null;
	const level = candidate && allowed.includes(candidate) ? candidate : 'debug';
	await setStorageValue('debug_min_level', level);
	await Log('warn', `Debug min-level set to ${level}`);
	return { level };
});

messageRegistry.register('setDebugMode', async (message) => {
	const presetKey = message?.preset;
	const customMs = Number(message?.durationMs);
	let durationMs = 0;
	if (presetKey && Object.prototype.hasOwnProperty.call(DEBUG_DURATION_PRESETS_MS, presetKey)) {
		durationMs = DEBUG_DURATION_PRESETS_MS[presetKey];
	} else if (Number.isFinite(customMs) && customMs > 0) {
		durationMs = Math.min(customMs, 7 * 24 * 60 * 60 * 1000); // cap at 7 days
	}
	if (durationMs <= 0) {
		await removeStorageValue('debug_mode_until');
		await Log('warn', 'Debug mode disabled by user');
		return { active: false, until: null, remainingMs: 0 };
	}
	const until = Date.now() + durationMs;
	await setStorageValue('debug_mode_until', until);
	await Log('warn', `Debug mode enabled for ${Math.round(durationMs / 60000)}m`, { until });
	return { active: true, until, remainingMs: durationMs };
});

// Opt-in error reporting. The user enables it explicitly in the popup,
// every subsequent warn/error log persists to a sanitized ring buffer,
// and the user can later download the buffer as JSON to share when
// filing a bug. AGENTS.md rule #1 (no off-device sync) is honored --
// there is no automatic upload, only a local download triggered by
// the user clicking a button.
messageRegistry.register('getErrorReportOptIn', async () => {
	return !!(await getStorageValue('errorReportOptIn', false));
});
messageRegistry.register('setErrorReportOptIn', async (message) => {
	const enabled = !!message?.enabled;
	await setStorageValue('errorReportOptIn', enabled);
	if (!enabled) {
		// Disabling also clears the buffer so the user does not leave
		// sanitized-but-still-personal log entries sitting on disk after
		// opting out.
		await setStorageValue('errorReportBuffer', []);
	}
	await Log('warn', `Error reporting ${enabled ? 'enabled' : 'disabled and buffer cleared'}`);
	return { enabled };
});
messageRegistry.register('getErrorReport', async () => {
	const buffer = await getStorageValue('errorReportBuffer', []);
	const optIn = await getStorageValue('errorReportOptIn', false);
	const version = chrome?.runtime?.getManifest?.()?.version || 'unknown';
	return {
		optIn,
		version,
		count: buffer.length,
		generatedAt: new Date().toISOString(),
		// Provide entries as-is; they were sanitized at write time.
		entries: buffer
	};
});
messageRegistry.register('clearErrorReport', async () => {
	await setStorageValue('errorReportBuffer', []);
	await Log('warn', 'Error report buffer cleared by user');
	return true;
});
// Fix 4: User-configurable custom limits
messageRegistry.register('getUserLimits', async (message) => {
	return await platformUsageStore.getUserLimits(message.platform);
});
messageRegistry.register('setUserLimits', async (message) => {
	await platformUsageStore.setUserLimits(message.platform, message.limits);
	return true;
});

// Carbon & Energy handlers
messageRegistry.register('getRegions', async () => {
	return getRegions();
});
messageRegistry.register('setRegion', async (message) => {
	await setStorageValue('carbonRegion', message.region);
	return { region: message.region };
});
messageRegistry.register('getRegion', async () => {
	return await getStorageValue('carbonRegion', 'us-average');
});
messageRegistry.register('getMethodology', async () => {
	return getMethodology();
});
messageRegistry.register('compareModels', async (message) => {
	return compareModels(message.models, message.tokenCount, message.region);
});

// Decision engine handlers
messageRegistry.register('previewCost', async (message, sender) => {
	const tokens = Math.round(GPTTokenizer_o200k_base.countTokens(message.text));
	const tabId = sender?.tab?.id;
	const model = lastModelByTab.get(`${message.platform}:${tabId}`) || 'unknown';
	return previewCost(message.platform, model, tokens);
});
messageRegistry.register('getRecommendation', async (message) => {
	return getModelRecommendation(message.platform, message.model, message.inputTokens);
});
messageRegistry.register('checkAnomaly', async (message) => {
	const key = `${message.platform}:${new Date().toISOString().slice(0, 10)}`;
	const todayUsage = await platformUsageStore.store.get(key);
	return await detectAnomaly(message.platform, todayUsage, platformUsageStore);
});
messageRegistry.register('checkBudgets', async () => {
	const allUsage = await platformUsageStore.getAllPlatformsToday() || {};
	// Compute weekly totals for weekly budget checks
	let weeklyCost = 0, weeklyCarbon = 0;
	for (const pid of Object.keys(CONFIG.PLATFORMS)) {
		for (let i = 0; i <= 6; i++) {
			const d = new Date();
			d.setDate(d.getDate() - i);
			const key = `${pid}:${d.toISOString().slice(0, 10)}`;
			const day = await platformUsageStore.store.get(key);
			if (day) {
				weeklyCost += day.estimatedCostUSD || 0;
				weeklyCarbon += day.totalCarbonGco2e || 0;
			}
		}
	}
	allUsage._weeklyTotals = { cost: weeklyCost, carbon: weeklyCarbon };
	return await checkBudgets(allUsage);
});
messageRegistry.register('getBudgets', async () => {
	return await getBudgets();
});
messageRegistry.register('setBudgets', async (message) => {
	await setBudgets(message.budgets);
	return true;
});
messageRegistry.register('computeEfficiency', async (message) => {
	return computeEfficiency(message.inputTokens, message.outputTokens, message.costUSD);
});
messageRegistry.register('countTokensLocal', async (message) => {
	return Math.round(GPTTokenizer_o200k_base.countTokens(message.text));
});

// Unified decision pipeline (replaces separate preview/recommend/budget calls)
messageRegistry.register('evaluateDecision', async (message, sender) => {
	const tokens = message.inputTokens || (message.text ? Math.round(GPTTokenizer_o200k_base.countTokens(message.text)) : 0);
	const tabId = sender?.tab?.id;
	const model = message.model || lastModelByTab.get(`${message.platform}:${tabId}`) || 'unknown';
	return await evaluateDecision({
		platform: message.platform,
		model,
		promptText: message.text || '',
		inputTokens: tokens,
		phase: message.phase || 'typing',
		sessionId: message.sessionId,
		tabId
	});
});
messageRegistry.register('recordUserAction', async (message) => {
	await recordUserAction(message.requestId, message.action, message.details || {});
	await updateUserProfile({ [message.action]: true, savingsCaptured: message.savingsCaptured, savingsMissed: message.savingsMissed });
	return true;
});
messageRegistry.register('getUserProfile', async () => {
	return await getUserProfile();
});
messageRegistry.register('getSessionSummary', async (message) => {
	return await getSessionSummary(message.sessionId);
});
// Velocity retrieval
messageRegistry.register('getVelocity', async (message) => {
	return await platformUsageStore.getVelocity(message.platform);
});

// ── codeburn-inspired handlers ──
// Period rollup (Today / 7d / 30d / Month / All) across sessions.
messageRegistry.register('getPeriodRollup', async (message) => {
	return await sessionTracker.computePeriodRollup({
		period: message.period || '7days',
		platform: message.platform || null
	});
});
messageRegistry.register('getSessions', async (message) => {
	return await sessionTracker.getSessions({
		period: message.period || '30days',
		platform: message.platform || null,
		limit: message.limit || 25
	});
});
messageRegistry.register('getSessionTurns', async (message) => {
	return await sessionTracker.getTurns({
		period: message.period || 'all',
		sessionId: message.sessionId
	});
});
messageRegistry.register('runOptimize', async (message) => {
	return await runOptimize({
		period: message.period || '30days',
		platform: message.platform || null
	});
});
messageRegistry.register('classifyPrompt', async (message) => {
	return classifyCodeburn(message.text || '', {});
});

// Model comparison backed by local session history (real data, not synthetic).
messageRegistry.register('compareModelsReal', async (message) => {
	return await compareModelsReal({
		modelA: message.modelA,
		modelB: message.modelB,
		period: message.period || '30days',
		platform: message.platform || null
	});
});
messageRegistry.register('getAvailableModels', async (message) => {
	return await availableModels({
		period: message.period || '30days',
		platform: message.platform || null
	});
});

// Currency handlers. Default is USD; a Frankfurter round-trip only happens
// when the user explicitly sets a non-USD currency.
messageRegistry.register('getCurrency', async () => await getCurrency());
messageRegistry.register('setCurrency', async (message) => await setCurrency(message.code));
messageRegistry.register('resetCurrency', async () => await resetCurrency());
messageRegistry.register('convertUSD', async (message) => await convertUSD(message.amountUSD || 0));
messageRegistry.register('formatUSD', async (message) => await formatUSD(message.amountUSD || 0, { decimals: message.decimals }));
messageRegistry.register('listCurrencies', () => listCurrencies());
messageRegistry.register('refreshCurrencyRate', async () => {
	const code = await getCurrency();
	return await fetchRate(code);
});

// Subscription plan handlers.
messageRegistry.register('getPlan', async () => await getPlan());
messageRegistry.register('setPlan', async (message) => await setPlan(message));
messageRegistry.register('resetPlan', async () => await resetPlan());
messageRegistry.register('getPlanInsights', async () => await getPlanInsights());
messageRegistry.register('listPlans', () => listPlans());

// Model alias handlers.
messageRegistry.register('listModelAliases', async () => await listUserAliases());
messageRegistry.register('setModelAlias', async (message) => await setUserAlias(message.alias, message.canonical));
messageRegistry.register('removeModelAlias', async (message) => await removeUserAlias(message.alias));
messageRegistry.register('resolveModel', async (message) => await resolveModel(message.model));

// Export handlers (CSV / JSON).
messageRegistry.register('buildExport', async (message) => {
	return await buildExport(message.format || 'json');
});

// Business-user exports surfaced under Tools -> Reports. Each handler
// returns { filename, content, mime } so the popup can stream a Blob
// download without any extra wrangling.
messageRegistry.register('exportUsageCSV', async (message) => {
	return await exportUsageCSV({
		startDate: message.startDate,
		endDate: message.endDate,
		platform: message.platform || null
	});
});
messageRegistry.register('exportFindingsCSV', async (message) => {
	return await exportFindingsCSV({ period: message.period || '30days' });
});
messageRegistry.register('exportAllJSON', async (message) => {
	return await exportAllJSON({ period: message.period || '30days' });
});
messageRegistry.register('buildMonthlySummary', async () => {
	return await buildMonthlySummary();
});
messageRegistry.register('usageInsights', async (message) => {
	return await handleUsageInsights(message);
});

async function openDebugPage() {
	if (browser.tabs?.create) {
		browser.tabs.create({ url: browser.runtime.getURL('debug.html') });
		return true;
	}
	return 'fallback';
}
messageRegistry.register(openDebugPage);

// Claude-specific: full conversation data request
async function requestData(message, sender) {
	const { conversationId } = message;
	const orgId = await requestActiveOrgId(sender.tab);
	const api = new ClaudeAPI(sender.tab?.cookieStoreId, orgId);

	const usageData = await api.getUsageData();
	if (usageData?.subscriptionTier) {
		await platformUsageStore.setSubscriptionTier('claude', usageData.subscriptionTier);
	}
	await scheduleResetNotifications(orgId, usageData);
	await sendTabMessage(sender.tab.id, { type: 'updateUsage', data: { usageData: usageData.toJSON() } });

	if (conversationId) {
		const cached = await conversationCache.get(conversationId);
		if (cached) {
			if (cached.conversationIsCachedUntil && cached.conversationIsCachedUntil <= Date.now()) {
				cached.cost = cached.uncachedCost;
				cached.futureCost = cached.uncachedFutureCost;
				cached.conversationIsCachedUntil = null;
			}
			await sendTabMessage(sender.tab.id, { type: 'updateConversationData', data: { conversationData: cached } });
		} else {
			const conversation = await api.getConversation(conversationId);
			const conversationData = await conversation.getInfo(false);
			const profileTokens = await api.getProfileTokens();
			if (conversationData) {
				conversationData.length += profileTokens;
				conversationData.cost += profileTokens * CONFIG.CACHING_MULTIPLIER;
				conversationData.uncachedCost += profileTokens * CONFIG.CACHING_MULTIPLIER;
				await conversationCache.set(conversationId, conversationData.toJSON(), CONVERSATION_CACHE_TTL);
				await updateTabWithConversationData(sender.tab.id, conversationData);
			}
		}
	}
	return true;
}
messageRegistry.register(requestData);

async function interceptedRequest(message, sender) {
	if (!isElectron) return false;
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onBeforeRequestHandler(message.details);
	return true;
}
messageRegistry.register(interceptedRequest);

async function interceptedResponse(message, sender) {
	if (!isElectron) return false;
	message.details.tabId = sender.tab.id;
	message.details.cookieStoreId = sender.tab.cookieStoreId;
	onCompletedHandler(message.details);
	return true;
}
messageRegistry.register(interceptedResponse);

// Fix 1: Electron tab lifecycle handlers (previously unhandled)
const activeElectronTabs = new Set();

messageRegistry.register('electronTabActivated', async (message) => {
	const tabId = message.details?.tabId;
	if (tabId) {
		activeElectronTabs.add(tabId);
		await Log("Electron tab activated:", tabId);
	}
	return true;
});

messageRegistry.register('electronTabDeactivated', async (message) => {
	const tabId = message.details?.tabId;
	if (tabId) {
		activeElectronTabs.delete(tabId);
		await Log("Electron tab deactivated:", tabId);
	}
	return true;
});

messageRegistry.register('electronTabRemoved', async (message) => {
	const tabId = message.details?.tabId;
	if (tabId) {
		activeElectronTabs.delete(tabId);
		// Clean up model tracking for removed tabs
		for (const key of lastModelByTab.keys()) {
			if (key.endsWith(`:${tabId}`)) lastModelByTab.delete(key);
		}
		await Log("Electron tab removed, cleaned up:", tabId);
	}
	return true;
});

async function getTotalTokensTracked() { return await tokenStorageManager.getTotalTokens(); }
messageRegistry.register(getTotalTokensTracked);

async function handleMessageFromContent(message, sender) {
	return messageRegistry.handle(message, sender);
}
//#endregion


//#region Network handling
// URL paths the extension intercepts for rate-limit / telemetry reasons
// but whose bodies are not inference payloads (no prompt/messages). Hitting
// these is expected and must not produce parse warnings.
// Pathname-only match (no leading word boundary because `/` is a non-word
// character; \b would never anchor cleanly before it). Trailing \b on
// /backend-api/files so /backend-api/files-of-something is not falsely
// flagged as a non-inference URL.
const NON_INFERENCE_PATH_RE = /(\/ces\/v1\/|\/sentinel\/|\/backend-api\/files(\b|$))/i;

// summarizeRequestBody returns a small diagnostic object describing what
// the browser actually gave us. Used to make body-parse warnings useful
// instead of opaque -- the caller can see whether the body was empty,
// form-encoded, multipart, or binary, and decide how to react.
function summarizeRequestBody(requestBody) {
	const summary = {
		hasRaw: false,
		rawByteLength: 0,
		hasFormData: false,
		fromMonkeypatch: !!requestBody?.fromMonkeypatch,
		looksLike: 'unknown'
	};
	if (!requestBody) {
		summary.looksLike = 'missing';
		return summary;
	}
	if (requestBody.formData && typeof requestBody.formData === 'object') {
		summary.hasFormData = true;
		summary.looksLike = 'form-data';
	}
	const raw0 = requestBody.raw?.[0]?.bytes;
	if (raw0) {
		summary.hasRaw = true;
		if (typeof raw0 === 'string') {
			summary.rawByteLength = raw0.length;
			const head = raw0.slice(0, 24).trimStart();
			if (head.startsWith('{') || head.startsWith('[')) summary.looksLike = 'json-text';
			else if (/^[A-Za-z0-9_]+=/.test(head)) summary.looksLike = 'urlencoded';
			else if (head.startsWith('--')) summary.looksLike = 'multipart';
			else summary.looksLike = 'opaque-text';
		} else if (raw0 instanceof ArrayBuffer || ArrayBuffer.isView(raw0)) {
			summary.rawByteLength = raw0.byteLength;
			summary.looksLike = 'binary';
		}
	} else if (!summary.hasFormData) {
		summary.looksLike = 'empty';
	}
	return summary;
}

async function parseRequestBody(requestBody) {
	// webRequest exposes pre-parsed form data on requestBody.formData for
	// application/x-www-form-urlencoded bodies. Treat it as already-parsed.
	if (requestBody?.formData && typeof requestBody.formData === 'object') {
		const flat = {};
		for (const [k, v] of Object.entries(requestBody.formData)) {
			flat[k] = Array.isArray(v) && v.length === 1 ? v[0] : v;
		}
		return flat;
	}
	if (!requestBody?.raw?.[0]?.bytes) return undefined;
	if (requestBody.fromMonkeypatch) {
		const body = requestBody.raw[0].bytes;
		try { return JSON.parse(body); }
		catch (e) {
			try {
				const params = new URLSearchParams(body);
				const formData = {};
				for (const [key, value] of params) formData[key] = value;
				return formData;
			} catch (e2) { return undefined; }
		}
	} else {
		try {
			const text = new TextDecoder().decode(requestBody.raw[0].bytes);
			return JSON.parse(text);
		} catch (e) { return undefined; }
	}
}

// Multi-platform request handler
async function onBeforeRequestHandler(details) {
	const url = details.url;
	const platform = detectPlatformFromUrl(url);

	if (!platform) {
		await Log("warn", "Request matched webRequest filter but no platform detected:", url.split('?')[0]);
		return;
	}

	if (platform === 'claude') {
		await handleClaudeBeforeRequest(details);
	} else if (platform && details.method === "POST") {
		await handleGenericBeforeRequest(details, platform);
	}
}

async function handleClaudeBeforeRequest(details) {
	if (details.method === "POST" && (details.url.includes("/completion") || details.url.includes("/retry_completion"))) {
		const requestBodyJSON = await parseRequestBody(details.requestBody);
		const ids = extractClaudeRequestIds(details.url);
		if (!ids) return;
		// Initial check: if the page-context handler has already recorded
		// this request, defer immediately. We deliberately do NOT mark
		// here -- the page-context handler is the FAST path (no
		// getUsageData call), and we want it to win the race naturally.
		// Marking upfront here makes us "win" but then forces the test
		// (and real users) to wait for our slow getUsageData call to
		// complete before any record lands.
		if (requestBodyJSON && hasRecentGenericRequestFingerprint(
			details,
			'claude',
			requestBodyJSON,
			CLAUDE_BROWSER_FALLBACK_DEDUPE_TTL_MS
		)) return;
		// markedByThisHandler stays false; we only mark after recording.
		// The re-check before recordClaudeLocalEstimate below catches the
		// case where page-context fires DURING our slow getUsageData.
		const markedByThisHandler = false;
		const { orgId, conversationId } = ids;
		await tokenStorageManager.addOrgId(orgId);

		const model = await resolveModel(extractClaudeModel(requestBodyJSON));

		const key = `${orgId}:${conversationId}`;
		const styleId = requestBodyJSON?.personalized_styles?.[0]?.key || requestBodyJSON?.personalized_styles?.[0]?.uuid;

		// Store model for output token attribution via stream counter
		lastModelByTab.set(`claude:${details.tabId}`, model);

		const toolDefs = requestBodyJSON?.tools?.filter(tool =>
			tool.name && !['artifacts_v0', 'repl_v0'].includes(tool.type)
		)?.map(tool => ({
			name: tool.name,
			description: tool.description || '',
			schema: JSON.stringify(tool.input_schema || {})
		})) || [];

		let previousUsage = null;
		try {
			const api = new ClaudeAPI(details.cookieStoreId, orgId);
			const usageData = await api.getUsageData();
			previousUsage = usageData.toJSON();
		} catch (error) {
			await Log("warn", "Failed to fetch pre-message usage snapshot:", error);
		}

		const promptPreview = extractClaudePromptText(requestBodyJSON).slice(0, 8000);
		const fallbackEstimate = requestBodyJSON ? await estimateClaudeLocalRequest(requestBodyJSON, model) : null;
		let fallbackRecorded = false;
		const alreadyAccountedByPageContext = requestBodyJSON && !markedByThisHandler && hasRecentGenericRequestFingerprint(
			details,
			'claude',
			requestBodyJSON,
			CLAUDE_BROWSER_FALLBACK_DEDUPE_TTL_MS
		);

		if (alreadyAccountedByPageContext) {
			previousUsage = null;
			fallbackRecorded = true;
		} else if (previousUsage) {
			// Held in an in-memory Map only -- never chrome.storage.local.
			rememberPendingPromptText(key, promptPreview);
			// Mark the fingerprint so that if the page-context handler
			// fires after our slow getUsageData call resolves, it sees
			// "already accounted" and skips. Without this, both paths
			// can record the same request.
			if (requestBodyJSON) markGenericRequestFingerprint(details, 'claude', requestBodyJSON);
		} else if (fallbackEstimate) {
			fallbackRecorded = await recordClaudeLocalEstimate(details, fallbackEstimate, {
				conversationId,
				source: 'fallback',
				promptText: promptPreview
			});
		}
		if (fallbackRecorded && requestBodyJSON) markGenericRequestFingerprint(details, 'claude', requestBodyJSON);

		await pendingRequests.set(key, {
			orgId, conversationId, tabId: details.tabId, styleId, model,
			requestTimestamp: Date.now(), toolDefinitions: toolDefs, previousUsage,
			fallbackRecorded,
			fallbackModel: fallbackEstimate?.model || model,
			fallbackInputTokens: fallbackEstimate?.inputTokens || 0
		}, PENDING_REQUEST_TTL_MS);
	}

	if (details.method === "GET" && details.url.includes("/settings/billing")) {
		const orgId = await requestActiveOrgId(details.tabId);
		const api = new ClaudeAPI(details.cookieStoreId, orgId);
		const tier = await api.getSubscriptionTier(true);
		if (tier) await platformUsageStore.setSubscriptionTier('claude', tier);
	}
}

function extractClaudeRequestIds(url) {
	const urlParts = String(url || '').split('/');
	const orgIdx = urlParts.indexOf('organizations');
	const convIdx = urlParts.indexOf('chat_conversations');
	if (orgIdx === -1 || convIdx === -1) return null;
	const orgId = urlParts[orgIdx + 1];
	const conversationId = urlParts[convIdx + 1]?.split('?')[0];
	if (!orgId || !conversationId) return null;
	return { orgId, conversationId };
}

function extractClaudeModel(requestBodyJSON) {
	const candidates = [
		requestBodyJSON?.model,
		requestBodyJSON?.model_slug,
		requestBodyJSON?.selected_model_slug,
		requestBodyJSON?.metadata?.model,
		requestBodyJSON?.metadata?.model_slug
	].filter(value => typeof value === 'string');
	const modelString = candidates.join(' ').toLowerCase();
	for (const modelType of CONFIG.MODELS) {
		if (modelString.includes(modelType.toLowerCase())) return modelType;
	}
	return "Sonnet";
}

function extractClaudePromptText(requestBodyJSON) {
	if (!requestBodyJSON || typeof requestBodyJSON !== 'object') return '';
	if (typeof requestBodyJSON.prompt === 'string') return requestBodyJSON.prompt;
	if (Array.isArray(requestBodyJSON.messages)) {
		const userMessages = requestBodyJSON.messages.filter(message => {
			const role = message?.role || message?.sender || message?.author?.role;
			return !role || String(role).toLowerCase() === 'user' || String(role).toLowerCase() === 'human';
		});
		const source = userMessages.length > 0 ? userMessages : requestBodyJSON.messages;
		const text = source.map(message => textFromContentValue(message?.content ?? message?.parts ?? message)).filter(Boolean).join(' ');
		if (text.trim()) return text;
	}
	if (requestBodyJSON.content) {
		const text = textFromContentValue(requestBodyJSON.content);
		if (text.trim()) return text;
	}
	if (requestBodyJSON.message) {
		const text = textFromContentValue(requestBodyJSON.message);
		if (text.trim()) return text;
	}
	try {
		return JSON.stringify(requestBodyJSON).slice(0, 50000);
	} catch {
		return '';
	}
}

async function estimateClaudeLocalRequest(requestBodyJSON, modelOverride = null) {
	const model = await resolveModel(modelOverride || extractClaudeModel(requestBodyJSON));
	const inputText = extractClaudePromptText(requestBodyJSON);
	const rawTokens = Math.round(GPTTokenizer_o200k_base.countTokens(inputText));
	const inputTokens = platformUsageStore.calibrateTokens('claude', rawTokens, 'input');
	return { model, inputText, rawTokens, inputTokens };
}

async function recordClaudeLocalEstimate(details, estimate, { conversationId = null, source = 'local estimate', promptText = '' } = {}) {
	if (!estimate || !estimate.model) return false;
	lastModelByTab.set(`claude:${details.tabId}`, estimate.model);
	await platformUsageStore.recordRequest('claude', estimate.model, estimate.inputTokens || 0, 0, { source });

	const region = await getStorageValue('carbonRegion', 'us-average');
	const impact = estimateImpact(estimate.model, estimate.inputTokens || 0, 0, region);
	await platformUsageStore.addImpact('claude', impact.energy.estimateWh, impact.carbon.estimateGco2e);

	try {
		const pricing = CONFIG.PRICING.claude?.[estimate.model] || { input: 3.0, output: 15.0 };
		const estCostUSD = ((estimate.inputTokens || 0) / 1e6) * pricing.input;
		const conversationUrl = await deriveConversationUrl({ platform: 'claude', conversationId, tabId: details.tabId });
		await sessionTracker.recordTurn({
			platform: 'claude',
			sessionId: conversationId || deriveSessionId('claude', details.tabId, details.url),
			promptText: promptText || estimate.inputText || '',
			model: estimate.model,
			inputTokens: estimate.inputTokens || 0,
			outputTokens: 0,
			costUSD: estCostUSD,
			tabId: details.tabId,
			conversationUrl
		});
	} catch (e) { await Log('warn', `Session record (claude ${source}) failed:`, e?.message || e); }

	if (typeof details.tabId === 'number' && details.tabId >= 0) {
		sendTabMessage(details.tabId, {
			type: 'platformUsageUpdate',
			data: { platform: 'claude', model: estimate.model, inputTokens: estimate.inputTokens || 0, outputTokens: 0 }
		});
	}
	return true;
}

async function recordClaudeLocalRequest(details, requestBodyJSON, meta = {}) {
	if (!requestBodyJSON) return false;
	const estimate = await estimateClaudeLocalRequest(requestBodyJSON, meta.modelOverride || null);
	return await recordClaudeLocalEstimate(details, estimate, {
		conversationId: meta.conversationId || null,
		source: meta.source || 'local request',
		promptText: meta.promptText || estimate.inputText
	});
}

async function recordClaudePendingFallback(pendingRequest, responseKey, details, reason) {
	if (!pendingRequest || pendingRequest.fallbackRecorded) return false;
	const estimate = {
		model: pendingRequest.fallbackModel || pendingRequest.model || 'Sonnet',
		inputText: '',
		rawTokens: 0,
		inputTokens: pendingRequest.fallbackInputTokens || 0
	};
	const recorded = await recordClaudeLocalEstimate(details, estimate, {
		conversationId: pendingRequest.conversationId,
		source: 'fallback',
		promptText: takePendingPromptText(responseKey)
	});
	if (recorded) {
		pendingRequest.fallbackRecorded = true;
		await pendingRequests.set(responseKey, pendingRequest, PENDING_REQUEST_TTL_MS);
	}
	return recorded;
}

async function handleClaudeBrowserRequest(details) {
	const requestBodyJSON = await parseRequestBody(details.requestBody);
	if (!requestBodyJSON) return false;
	if (shouldSkipDuplicateGenericRequest(details, 'claude', requestBodyJSON)) return false;

	const ids = extractClaudeRequestIds(details.url) || {};
	const conversationId = ids.conversationId || deriveSessionId('claude', details.tabId, details.url);
	const key = ids.orgId && ids.conversationId ? `${ids.orgId}:${ids.conversationId}` : null;
	const model = await resolveModel(extractClaudeModel(requestBodyJSON));
	const promptPreview = extractClaudePromptText(requestBodyJSON).slice(0, 8000);
	const estimate = await estimateClaudeLocalRequest(requestBodyJSON, model);
	const recorded = await recordClaudeLocalEstimate(details, estimate, {
		conversationId,
		source: 'pageContext',
		promptText: promptPreview
	});

	if (key) {
		await pendingRequests.set(key, {
			orgId: ids.orgId,
			conversationId: ids.conversationId,
			tabId: details.tabId,
			styleId: requestBodyJSON?.personalized_styles?.[0]?.key || requestBodyJSON?.personalized_styles?.[0]?.uuid,
			model,
			requestTimestamp: Date.now(),
			toolDefinitions: [],
			previousUsage: null,
			fallbackRecorded: recorded,
			fallbackModel: estimate.model,
			fallbackInputTokens: estimate.inputTokens
		}, PENDING_REQUEST_TTL_MS);
	}

	return recorded;
}

function textFromContentValue(value, depth = 0) {
	if (value == null || depth > 6) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return '';
	if (Array.isArray(value)) return value.map(item => textFromContentValue(item, depth + 1)).filter(Boolean).join(' ');
	if (typeof value !== 'object') return '';

	if (typeof value.text === 'string') return value.text;
	if (typeof value.value === 'string') return value.value;
	if (typeof value.content === 'string') return value.content;
	if (Array.isArray(value.parts)) return textFromContentValue(value.parts, depth + 1);
	if (Array.isArray(value.content?.parts)) return textFromContentValue(value.content.parts, depth + 1);
	if (Array.isArray(value.content)) return textFromContentValue(value.content, depth + 1);
	return '';
}

function extractMessagesText(messages) {
	if (!Array.isArray(messages)) return '';
	const userMessages = messages.filter(m => {
		if (!m || typeof m !== 'object') return typeof m === 'string';
		const role = m.role || m.author?.role || m.message?.author?.role;
		return !role || role === 'user';
	});
	const source = userMessages.length > 0 ? userMessages : messages;
	return source.map(m => {
		if (typeof m === 'string') return m;
		return textFromContentValue(m.content ?? m.parts ?? m.message?.content ?? m);
	}).filter(Boolean).join(' ');
}

function extractChatGptModel(requestBodyJSON) {
	return requestBodyJSON.model ||
		requestBodyJSON.model_slug ||
		requestBodyJSON.selected_model_slug ||
		requestBodyJSON.conversation_mode?.model_slug ||
		requestBodyJSON.conversation_mode?.kind ||
		requestBodyJSON.metadata?.model_slug ||
		requestBodyJSON.metadata?.selected_model_slug ||
		'gpt-4o';
}

function extractChatGptInputText(requestBodyJSON) {
	const messages = requestBodyJSON.messages || requestBodyJSON.input_messages || requestBodyJSON.inputs || [];
	let inputText = extractMessagesText(messages);
	if (!inputText.trim() && requestBodyJSON.conversation?.messages) {
		inputText = extractMessagesText(requestBodyJSON.conversation.messages);
	}
	if (!inputText.trim() && typeof requestBodyJSON.prompt === 'string') inputText = requestBodyJSON.prompt;
	if (!inputText.trim() && typeof requestBodyJSON.input === 'string') inputText = requestBodyJSON.input;
	if (!inputText.trim() && typeof requestBodyJSON.query === 'string') inputText = requestBodyJSON.query;
	if (!inputText.trim() && requestBodyJSON.content) inputText = textFromContentValue(requestBodyJSON.content);
	if (!inputText.trim()) inputText = JSON.stringify(requestBodyJSON).slice(0, 50000);
	return inputText;
}

function firstTextCandidate(...values) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value;
		const text = textFromContentValue(value);
		if (text.trim()) return text;
	}
	return '';
}

function extractGenericInputText(requestBodyJSON) {
	if (!requestBodyJSON || typeof requestBodyJSON !== 'object') return '';
	const messages = requestBodyJSON.messages ||
		requestBodyJSON.input_messages ||
		requestBodyJSON.inputs ||
		requestBodyJSON.thread?.messages ||
		requestBodyJSON.conversation?.messages ||
		requestBodyJSON.payload?.messages ||
		[];

	let inputText = extractMessagesText(messages);
	if (!inputText.trim()) {
		inputText = firstTextCandidate(
			requestBodyJSON.prompt,
			requestBodyJSON.query,
			requestBodyJSON.question,
			requestBodyJSON.text,
			requestBodyJSON.content,
			requestBodyJSON.input,
			requestBodyJSON.q,
			requestBodyJSON.ask,
			requestBodyJSON.user_input,
			requestBodyJSON.payload?.query,
			requestBodyJSON.payload?.prompt,
			requestBodyJSON.variables?.query,
			requestBodyJSON.variables?.prompt
		);
	}
	if (!inputText.trim()) {
		try { inputText = JSON.stringify(requestBodyJSON).slice(0, 50000); }
		catch { inputText = ''; }
	}
	return inputText;
}

function extractPerplexityModel(requestBodyJSON) {
	const candidates = [
		requestBodyJSON?.model,
		requestBodyJSON?.modelName,
		requestBodyJSON?.model_slug,
		requestBodyJSON?.selected_model,
		requestBodyJSON?.settings?.model,
		requestBodyJSON?.payload?.model,
		requestBodyJSON?.variables?.model
	].filter(value => typeof value === 'string' && value.trim());
	const modelString = candidates.join(' ').toLowerCase();
	if (modelString.includes('deep')) return 'sonar-deep-research';
	if (modelString.includes('reasoning')) return 'sonar-reasoning-pro';
	if (modelString.includes('pro')) return 'sonar-pro';
	if (modelString.includes('sonar')) return 'sonar';
	return 'sonar';
}

function extractGrokModel(requestBodyJSON) {
	const candidates = [
		requestBodyJSON?.model,
		requestBodyJSON?.modelName,
		requestBodyJSON?.model_id,
		requestBodyJSON?.modelId,
		requestBodyJSON?.conversation?.model,
		requestBodyJSON?.payload?.model,
		requestBodyJSON?.request?.model,
		requestBodyJSON?.settings?.model
	].filter(value => typeof value === 'string' && value.trim());
	return candidates[0] || 'grok-4.3';
}

function extractMetaModel(requestBodyJSON) {
	// Meta AI does NOT expose model in the request body. Model selection is
	// server-side per account/tier. The newer Muse Spark rollout introduces
	// mode hints in fb_api_req_friendly_name or variables: muse-spark,
	// muse-spark-thinking, muse-spark-contemplating. We surface these as
	// distinct buckets for cost analytics, otherwise default to Llama 3.3.
	// Source: Strvm/meta-ai-api; diegosouzapw/OmniRoute issue #1308.
	const variables = requestBodyJSON?.variables || {};
	const friendlyName = String(
		requestBodyJSON?.fb_api_req_friendly_name ||
		variables?.fb_api_req_friendly_name ||
		''
	).toLowerCase();
	const entrypoint = String(variables?.entrypoint || '').toUpperCase();
	const composedAt = JSON.stringify(variables).toLowerCase();
	if (composedAt.includes('muse-spark-contemplating')) return 'llama-4-behemoth';
	if (composedAt.includes('muse-spark-thinking')) return 'llama-4-maverick';
	if (composedAt.includes('muse-spark')) return 'llama-4-scout';
	if (friendlyName.includes('useabrasendmessage') || entrypoint === 'ABRA__CHAT__TEXT') {
		return 'llama-3.3-70b';
	}
	return 'llama-3.3-70b';
}

function extractCopilotModel(requestBodyJSON) {
	// Microsoft Copilot exposes the Think-Deeper mode via the thinkDeeper
	// flag in chat options (confirmed in the production bundle: i18n keys
	// "thinkDeeper.title" / "thinkDeeper.description", flag
	// thinkDeeperFreemiumEnabled). Frame structure is JSON with options
	// nested under `chatOptions` or top-level. Source: copilot.microsoft.com
	// production bundle (reverse-engineered).
	const opts = requestBodyJSON?.chatOptions || requestBodyJSON?.options || requestBodyJSON || {};
	if (opts.thinkDeeper === true || opts.isThinkDeeper === true) return 'copilot-think-deeper';
	if (typeof opts.tone === 'string' && opts.tone.toLowerCase().includes('think')) return 'copilot-think-deeper';
	if (typeof opts.mode === 'string' && opts.mode.toLowerCase().includes('think')) return 'copilot-think-deeper';
	// "Smart" mode in the UI is the default GPT-4o. There is no explicit
	// gpt-4o-mini surface on the consumer site; m365 enterprise may signal
	// it via the explicit model field.
	const modelStr = String(opts.model || opts.modelName || '').toLowerCase();
	if (modelStr.includes('mini')) return 'copilot-gpt-4o-mini';
	if (modelStr.includes('o1') || modelStr.includes('reasoning') || modelStr.includes('deeper')) {
		return 'copilot-think-deeper';
	}
	return 'copilot';
}

// Generic handler for ChatGPT, Gemini, Mistral: track the request with calibrated tokens
async function handleGenericBeforeRequest(details, platform) {
	// Telemetry / rate-limit / file-upload endpoints are intercepted on
	// purpose but never carry an inference payload. Don't try to parse
	// them and don't emit a body-parse warning.
	const urlPath = (() => {
		try { return new URL(details.url).pathname; }
		catch { return String(details.url || ''); }
	})();
	if (NON_INFERENCE_PATH_RE.test(urlPath)) return;

	const requestBodyJSON = await parseRequestBody(details.requestBody);
	if (!requestBodyJSON) {
		const summary = summarizeRequestBody(details.requestBody);
		// Empty / file-upload bodies are common and not actionable. Demote
		// to debug so the real-time console stays readable; keep the rich
		// context so debug builds can still investigate.
		const level = summary.looksLike === 'empty' || summary.looksLike === 'multipart' || summary.looksLike === 'binary' ? 'debug' : 'warn';
		await Log(level, `${platform}: body-parse failed`, {
			url: urlPath,
			method: details.method,
			source: details.requestBody?.fromMonkeypatch ? 'page-context' : 'webRequest',
			bodyKind: summary.looksLike,
			rawBytes: summary.rawByteLength,
			hasFormData: summary.hasFormData,
			tabId: details.tabId
		});
		return;
	}
	if (shouldSkipDuplicateGenericRequest(details, platform, requestBodyJSON)) return;

	let model = 'unknown';
	let inputText = '';

	if (platform === 'chatgpt') {
		model = extractChatGptModel(requestBodyJSON);
		inputText = extractChatGptInputText(requestBodyJSON);
	} else if (platform === 'gemini') {
		model =
			requestBodyJSON.model ||
			requestBodyJSON.modelName ||
			requestBodyJSON.generationConfig?.model ||
			requestBodyJSON.request?.model ||
			requestBodyJSON?.[1]?.[0] ||
			null;

		if (!model) {
			const tier = await platformUsageStore.getSubscriptionTier('gemini');
			model = tier === 'advanced' ? 'gemini-2.5-pro' : 'gemini-2.0-flash';
		}

		if (requestBodyJSON.contents && Array.isArray(requestBodyJSON.contents)) {
			inputText = requestBodyJSON.contents
				.flatMap(c => c?.parts || [])
				.map(p => p?.text || p?.inline_data?.data || '')
				.join(' ');
		}
		if (!inputText.trim() && Array.isArray(requestBodyJSON)) {
			inputText = JSON.stringify(requestBodyJSON).slice(0, 50000);
		}
		if (!inputText.trim() && requestBodyJSON.prompt) inputText = requestBodyJSON.prompt;
		if (!inputText.trim()) inputText = JSON.stringify(requestBodyJSON).slice(0, 50000);
	} else if (platform === 'mistral') {
		model = requestBodyJSON.model || 'mistral-large';
		// Try standard messages array first, then other field names
		const messages = requestBodyJSON.messages || requestBodyJSON.inputs || [];
		inputText = messages.map(m => {
			if (typeof m === 'string') return m;
			if (typeof m.content === 'string') return m.content;
			if (Array.isArray(m.content)) return m.content.map(p => p.text || p.value || '').join(' ');
			return '';
		}).join(' ');
		// Fallback: try content, prompt, query, or raw body
		if (!inputText.trim() && requestBodyJSON.content) inputText = requestBodyJSON.content;
		if (!inputText.trim() && requestBodyJSON.prompt) inputText = requestBodyJSON.prompt;
		if (!inputText.trim() && requestBodyJSON.query) inputText = requestBodyJSON.query;
		if (!inputText.trim()) inputText = JSON.stringify(requestBodyJSON).slice(0, 50000);
	} else if (platform === 'perplexity') {
		model = extractPerplexityModel(requestBodyJSON);
		inputText = extractGenericInputText(requestBodyJSON);
	} else if (platform === 'grok') {
		model = extractGrokModel(requestBodyJSON);
		inputText = extractGenericInputText(requestBodyJSON);
	} else if (platform === 'meta') {
		model = extractMetaModel(requestBodyJSON);
		inputText = extractGenericInputText(requestBodyJSON);
	} else if (platform === 'copilot') {
		model = extractCopilotModel(requestBodyJSON);
		inputText = extractGenericInputText(requestBodyJSON);
	}

	// Count tokens locally then apply platform-specific calibration factor
	const rawTokens = Math.round(GPTTokenizer_o200k_base.countTokens(inputText));
	const inputTokens = platformUsageStore.calibrateTokens(platform, rawTokens, 'input');

	await Log(`${platform}: intercepted ${details.method} to ${details.url.split('?')[0]}, model=${model}, inputChars=${inputText.length}, rawTokens=${rawTokens}, calibrated=${inputTokens}`);

	// Resolve model through alias table (handles proxy name variants).
	const canonicalModel = await resolveModel(model);

	// Store canonical model for this tab so output tokens and input tokens use
	// the same pricing bucket.
	lastModelByTab.set(`${platform}:${details.tabId}`, canonicalModel);

	// Record calibrated input tokens (output will be added when stream completes)
	const captureSource = details.requestBody?.fromMonkeypatch ? 'pageContext' : 'webRequest';
	await platformUsageStore.recordRequest(platform, canonicalModel, inputTokens, 0, { source: captureSource });

	// Estimate energy and carbon impact for this request's input tokens
	const region = await getStorageValue('carbonRegion', 'us-average');
	const impact = estimateImpact(canonicalModel, inputTokens, 0, region);
	await platformUsageStore.addImpact(platform, impact.energy.estimateWh, impact.carbon.estimateGco2e);

	// Session tracking: treat (platform, tab, url-thread) as a session. For
	// non-Claude platforms we can't always read a canonical conversation id,
	// so we derive a stable one from the tab + origin.
	try {
		const pricing = CONFIG.PRICING[platform]?.[canonicalModel] || Object.values(CONFIG.PRICING[platform] || {})[0] || { input: 1.0, output: 3.0 };
		const estCostUSD = (inputTokens / 1e6) * pricing.input;
		const sessionId = deriveSessionId(platform, details.tabId, details.url);
		const conversationUrl = await deriveConversationUrl({ platform, tabId: details.tabId });
		await sessionTracker.recordTurn({
			platform,
			sessionId,
			promptText: inputText,
			model: canonicalModel,
			inputTokens,
			outputTokens: 0,
			costUSD: estCostUSD,
			tabId: details.tabId,
			conversationUrl
		});
	} catch (e) { await Log('warn', `Session record (${platform}) failed:`, e?.message || e); }

	// Notify content script when the request came from a browser tab. Page-context
	// fallback events can be replayed in tests or non-tab contexts.
	if (typeof details.tabId === 'number' && details.tabId >= 0) {
		sendTabMessage(details.tabId, {
			type: 'platformUsageUpdate',
			data: { platform, model: canonicalModel, inputTokens, outputTokens: 0 }
		});
	}
}

// Derive a stable session id for platforms that don't give us a conversation
// id directly. Based on tab + URL path fragment so switching conversations in
// the same tab starts a new session.
function deriveSessionId(platform, tabId, url) {
	let pathKey = '';
	try {
		const u = new URL(url);
		const m = u.pathname.match(/\/(c|chat|share|conversation|conv)\/([A-Za-z0-9_-]{6,})/);
		pathKey = m ? m[2] : u.pathname.split('/').filter(Boolean).slice(-1)[0] || '';
	} catch { /* ignore */ }
	return `${platform}:${tabId || 0}:${pathKey || 'root'}`;
}

// Derive the canonical conversation page URL for a turn. We prefer a
// platform-specific URL built from the conversation id (Claude has the
// cleanest mapping), then fall back to the active tab's URL. The returned
// URL is sanitized via sanitizeConversationUrl inside session-tracker, so
// any auth/query params are stripped before storage.
async function deriveConversationUrl({ platform, conversationId = null, tabId = null }) {
	if (platform === 'claude' && conversationId && !conversationId.includes(':')) {
		// `deriveSessionId` returns 'claude:0:abc' format -- skip those, they
		// are not real conversation ids.
		return `https://claude.ai/chat/${conversationId}`;
	}
	if (typeof tabId === 'number' && tabId >= 0 && browser.tabs && browser.tabs.get) {
		try {
			const tab = await browser.tabs.get(tabId);
			if (tab && typeof tab.url === 'string') return tab.url;
		} catch { /* tab may have closed; fall through */ }
	}
	return null;
}


async function processResponse(orgId, conversationId, responseKey, details) {
	const tabId = details.tabId;
	const api = new ClaudeAPI(details.cookieStoreId, orgId);

	const pendingRequest = await pendingRequests.get(responseKey);
	const isNewMessage = pendingRequest !== undefined;
	const model = pendingRequest?.model || "Sonnet";

	let usageData;
	try {
		usageData = await api.getUsageData();
	} catch (error) {
		await Log("warn", "Failed to fetch post-message usage snapshot:", error);
		if (isNewMessage) await recordClaudePendingFallback(pendingRequest, responseKey, details, 'post-usage fallback');
		return true;
	}

	// Bridge Claude's API-detected tier to the popup's storage
	if (usageData?.subscriptionTier) {
		await platformUsageStore.setSubscriptionTier('claude', usageData.subscriptionTier);
	}

	let conversationData;
	try {
		const conversation = await api.getConversation(conversationId);
		conversationData = await conversation.getInfo(isNewMessage);
	} catch (error) {
		await Log("warn", "Failed to fetch Claude conversation after response:", error);
		if (isNewMessage) await recordClaudePendingFallback(pendingRequest, responseKey, details, 'conversation fallback');
		return true;
	}

	if (!conversationData) {
		await Log("warn", "Could not get conversation data, exiting...");
		if (isNewMessage) await recordClaudePendingFallback(pendingRequest, responseKey, details, 'empty conversation fallback');
		return true;
	}

	let modifierCost = 0;
	let profileTokens = 0;
	try {
		profileTokens = await api.getProfileTokens();
	} catch (error) {
		await Log("warn", "Failed to fetch Claude profile token modifier:", error);
	}
	modifierCost += profileTokens;

	let styleTokens = 0;
	try {
		styleTokens = await api.getStyleTokens(pendingRequest?.styleId, tabId);
	} catch (error) {
		await Log("warn", "Failed to fetch Claude style token modifier:", error);
	}
	modifierCost += styleTokens;

	if (pendingRequest?.toolDefinitions) {
		let toolTokens = 0;
		for (const tool of pendingRequest.toolDefinitions) {
			try {
				toolTokens += await tokenCounter.countText(`${tool.name} ${tool.description} ${tool.schema}`);
			} catch (error) {
				await Log("warn", "Failed to count Claude tool definition tokens:", error);
			}
		}
		modifierCost += toolTokens;
	}

	conversationData.cost += modifierCost;
	conversationData.futureCost += modifierCost;
	conversationData.uncachedCost += modifierCost;
	conversationData.uncachedFutureCost += modifierCost;
	conversationData.length += profileTokens;
	conversationData.model = model;

	// Store model for this tab so stream counter output tokens attribute correctly
	lastModelByTab.set(`claude:${tabId}`, model);

	if (isNewMessage && pendingRequest.previousUsage) {
		const previousUsage = UsageData.fromJSON(pendingRequest.previousUsage);
		await logUsageDelta(orgId, previousUsage, usageData, conversationData.length, model);
		await tokenStorageManager.addToTotalTokens(conversationData.cost);

		// Record per-message cost to unified platform tracker.
		// Uses conversationData.cost (token cost for this interaction, with caching)
		// not conversationData.length (full context window, which would double-count).
		await platformUsageStore.recordRequest('claude', model, conversationData.cost, 0, { source: 'claudeApi' });

		// Estimate energy and carbon for this Claude message
		const carbonRegion = await getStorageValue('carbonRegion', 'us-average');
		const impact = estimateImpact(model, conversationData.cost, 0, carbonRegion);
		await platformUsageStore.addImpact('claude', impact.energy.estimateWh, impact.carbon.estimateGco2e);

		// Session tracking: record this turn against the conversation. Only an
		// activity category + hash is persisted -- prompt text is never stored.
		try {
			const pricing = CONFIG.PRICING['claude']?.[model] || { input: 3.0, output: 15.0 };
			const estCostUSD = (conversationData.cost / 1e6) * pricing.input;
			const conversationUrl = await deriveConversationUrl({ platform: 'claude', conversationId, tabId });
			await sessionTracker.recordTurn({
				platform: 'claude',
				sessionId: conversationId,
				promptText: takePendingPromptText(responseKey),
				model,
				inputTokens: conversationData.cost,
				outputTokens: 0,
				costUSD: estCostUSD,
				tabId,
				conversationUrl
			});
		} catch (e) { await Log('warn', 'Session record (claude) failed:', e?.message || e); }
	} else if (isNewMessage && !pendingRequest.fallbackRecorded) {
		// No pre-message usage snapshot was available. Use the post-response
		// conversation estimate if we have one, otherwise rely on the local
		// fallback recorded during request interception.
		await platformUsageStore.recordRequest('claude', model, conversationData.cost, 0, { source: 'claudeApi' });

		const carbonRegion = await getStorageValue('carbonRegion', 'us-average');
		const impact = estimateImpact(model, conversationData.cost, 0, carbonRegion);
		await platformUsageStore.addImpact('claude', impact.energy.estimateWh, impact.carbon.estimateGco2e);

		try {
			const pricing = CONFIG.PRICING['claude']?.[model] || { input: 3.0, output: 15.0 };
			const estCostUSD = (conversationData.cost / 1e6) * pricing.input;
			const conversationUrl = await deriveConversationUrl({ platform: 'claude', conversationId, tabId });
			await sessionTracker.recordTurn({
				platform: 'claude',
				sessionId: conversationId,
				promptText: takePendingPromptText(responseKey),
				model,
				inputTokens: conversationData.cost,
				outputTokens: 0,
				costUSD: estCostUSD,
				tabId,
				conversationUrl
			});
		} catch (e) { await Log('warn', 'Session record (claude conversation fallback) failed:', e?.message || e); }
	}

	await scheduleResetNotifications(orgId, usageData);
	await updateAllTabsWithUsage(usageData);
	await updateTabWithConversationData(tabId, conversationData);
	await conversationCache.set(conversationId, conversationData.toJSON(), CONVERSATION_CACHE_TTL);
	return true;
}

async function logUsageDelta(orgId, previousUsage, currentUsage, conversationLength, model) {
	const deltas = {};
	for (const [key, currentLimit] of Object.entries(currentUsage.limits)) {
		if (!currentLimit) continue;
		const previousLimit = previousUsage.limits[key];
		if (!previousLimit) continue;
		const delta = currentLimit.percentage - previousLimit.percentage;
		if (delta >= 1) deltas[key] = delta;
	}
	if (Object.keys(deltas).length > 0) {
		await Log("Usage delta:", { timestamp: Date.now(), orgId, conversationLength, model, deltas });
	}
}

async function scheduleResetNotifications(orgId, usageData) {
	const maxedLimits = usageData.getMaxedLimits();
	for (const limit of maxedLimits) {
		if (limit.resetsAt <= Date.now()) continue;
		const timestampKey = limit.resetsAt.toString();
		if (await scheduledNotifications.has(timestampKey)) continue;
		// HIGH-4: Don't re-schedule if we already notified for this reset
		if (await notifiedResets.has(timestampKey)) continue;
		const expiryTime = limit.resetsAt + (60 * 60 * 1000) - Date.now();
		await scheduledNotifications.set(timestampKey, orgId, expiryTime);
	}
}

async function onCompletedHandler(details) {
	const platform = detectPlatformFromUrl(details.url);

	// Claude: full conversation processing
	if (platform === 'claude') {
		if (details.method === "GET" && details.url.includes("/chat_conversations/") &&
			details.url.includes("tree=True") && details.url.includes("render_all_tools=true")) {
			pendingTasks.push(async () => {
				const urlParts = details.url.split('/');
				const orgIdx = urlParts.indexOf('organizations');
				const convIdx = urlParts.indexOf('chat_conversations');
				if (orgIdx === -1 || convIdx === -1) return;
				const orgId = urlParts[orgIdx + 1];
				await tokenStorageManager.addOrgId(orgId);
				const conversationId = urlParts[convIdx + 1]?.split('?')[0];
				const key = `${orgId}:${conversationId}`;
				const result = await processResponse(orgId, conversationId, key, details);
				if (result && await pendingRequests.has(key)) await pendingRequests.delete(key);
			});
			processNextTask();
		}

		if (details.url.includes("/v1/sessions/") && details.url.includes("/events")) {
			pendingTasks.push(async () => {
				const orgId = await requestActiveOrgId(details.tabId);
				if (!orgId) return;
				await tokenStorageManager.addOrgId(orgId);
				const api = new ClaudeAPI(details.cookieStoreId, orgId);
				const usageData = await api.getUsageData();
				if (usageData?.subscriptionTier) await platformUsageStore.setSubscriptionTier('claude', usageData.subscriptionTier);
				await updateAllTabsWithUsage(usageData);
				await scheduleResetNotifications(orgId, usageData);
			});
			processNextTask();
		}
	}

	// Other platforms: lightweight response tracking
	if (platform && platform !== 'claude') {
		// Notify content script that the request completed
		sendTabMessage(details.tabId, {
			type: 'platformRequestComplete',
			data: { platform, url: details.url }
		});
	}
}

// FIX #13: Use setTimeout(fn, 0) instead of non-awaited recursive call to prevent stack growth
async function processNextTask() {
	if (processingLock) {
		const lockAge = Date.now() - processingLock;
		if (lockAge < LOCK_TIMEOUT) return;
		await Log("warn", `Stale processing lock detected (${lockAge}ms old), clearing`);
	}
	if (pendingTasks.length === 0) return;

	processingLock = Date.now();
	const task = pendingTasks.shift();

	try {
		await task();
	} catch (error) {
		await Log("error", "Task processing failed:", error);
	} finally {
		processingLock = null;
		if (pendingTasks.length > 0) {
			setTimeout(processNextTask, 0);
		}
	}
}
//#endregion

async function electronUsagePoll() {
	if (electronPollInFlight) return;
	electronPollInFlight = true;
	try { await updateAllTabsWithUsage(); }
	catch (error) { await Log("warn", "Electron usage poll failed:", error); }
	finally { electronPollInFlight = false; }
}

//#region Initialization
pendingRequests = new StoredMap("pendingRequests");
scheduledNotifications = new StoredMap('scheduledNotifications');
const notifiedResets = new StoredMap('notifiedResets');
const conversationCache = new StoredMap("conversationCache");
const CONVERSATION_CACHE_TTL = 60 * 60 * 1000;

// One-shot migration: versions before v9.4.0 persisted the user's raw
// prompt text in pendingRequests entries under a `promptPreview` field
// (AGENTS.md rule #2 regression -- fixed in v9.4.0). New code holds
// prompt text in an in-memory Map only, so the field is no longer
// written. Existing entries on a user's disk still carry the field
// until their TTL expires; this migration strips it on first SW boot.
// Idempotent because subsequent runs find no offending entries.
(async () => {
	try {
		await pendingRequests.ensureInitialized();
		const all = await pendingRequests.entries();
		let scrubbed = 0;
		for (const [key, value] of all) {
			if (value && typeof value === 'object' && 'promptPreview' in value) {
				delete value.promptPreview;
				await pendingRequests.set(key, value, PENDING_REQUEST_TTL_MS);
				scrubbed++;
			}
		}
		if (scrubbed > 0) {
			await Log('warn', `pendingRequests legacy migration: stripped promptPreview from ${scrubbed} entries`);
		}
	} catch (e) {
		// Migration must never block startup; log and move on.
		await Log('warn', 'pendingRequests legacy migration failed', { error: e?.message || String(e) });
	}
})();

getAlarm('checkResetNotifications').then(existing => {
	if (!existing) {
		scheduleAlarm('checkResetNotifications', { periodInMinutes: 3 });
		Log("Created repeating checkResetNotifications alarm");
	}
});

isInitialized = true;
const pendingCount = functionsPendingUntilInitialization.length;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
// One structured startup checkpoint -- makes it possible to tell from
// debug_logs alone whether the SW reached steady state, and what set
// of intercept patterns / runtime it ended up with. The information is
// static, so the line is cheap.
Log("AI Cost & Usage Tracker background initialized.", {
	version: chrome?.runtime?.getManifest?.()?.version || 'unknown',
	isElectron: !!isElectron,
	platforms: Object.keys(PLATFORM_INTERCEPT_PATTERNS || {}),
	pendingTasksDrained: pendingCount
});

if (isElectron) {
	const ELECTRON_POLL_INTERVAL_MS = 2 * 60 * 1000;
	electronPollingInterval = setInterval(electronUsagePoll, ELECTRON_POLL_INTERVAL_MS);
}

// Badge: cycle between cost and token count every 4 seconds, color-coded by spend.
let badgeShowCost = true;
async function updateBadge() {
	try {
		const allUsage = await platformUsageStore.getAllPlatformsToday();
		if (!allUsage) { chrome.action?.setBadgeText?.({ text: '' }); return; }

		let totalCost = 0, totalTokens = 0;
		for (const usage of Object.values(allUsage)) {
			totalCost += usage.estimatedCostUSD || 0;
			totalTokens += (usage.inputTokens || 0) + (usage.outputTokens || 0);
		}

		if (totalCost < 0.005 && totalTokens === 0) {
			chrome.action?.setBadgeText?.({ text: '' });
			return;
		}

		let text;
		if (badgeShowCost) {
			if (totalCost < 1) text = '$' + totalCost.toFixed(2);
			else if (totalCost < 10) text = '$' + totalCost.toFixed(1);
			else text = '$' + Math.round(totalCost);
		} else {
			if (totalTokens < 1000) text = totalTokens + '';
			else if (totalTokens < 1e6) text = (totalTokens / 1000).toFixed(0) + 'k';
			else text = (totalTokens / 1e6).toFixed(1) + 'M';
		}
		badgeShowCost = !badgeShowCost;

		// Color-code by daily spend threshold
		let color;
		if (totalCost >= 5) color = '#ef4444';      // red: high spend
		else if (totalCost >= 1) color = '#eab308';  // yellow: moderate
		else color = '#10b981';                       // green: low

		chrome.action?.setBadgeText?.({ text });
		chrome.action?.setBadgeBackgroundColor?.({ color });
	} catch (e) { await Log("debug", "Badge update error:", e); }
}
setInterval(updateBadge, 4000);
setTimeout(updateBadge, 3000);
//#endregion
