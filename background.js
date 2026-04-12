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
	await Log("Alarm triggered:", alarmName);
	if (alarmName === 'checkResetNotifications') {
		await checkResetNotifications();
	}
}

async function checkResetNotifications() {
	const enabled = await getStorageValue('resetNotifEnabled', false);
	if (!enabled) return;

	const entries = await scheduledNotifications.entries();
	if (!entries || entries.length === 0) return;

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
		} catch (error) {
			await Log("error", "Failed to create reset notification:", error);
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
		} catch (e) {
			await Log("warn", "Failed to fetch usage data for broadcast:", e);
			return;
		}
	}

	if (usageData) {
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

// Output token recording from stream interceptor
messageRegistry.register('recordOutputTokens', async (message, sender) => {
	const { platform, outputTokens } = message;
	const tabId = sender?.tab?.id;
	const model = lastModelByTab.get(`${platform}:${tabId}`) || message.model || 'unknown';
	const updated = await platformUsageStore.recordOutputTokens(platform, model, outputTokens);

	// Estimate energy and carbon impact for output tokens
	const region = await getStorageValue('carbonRegion', 'us-average');
	const impact = estimateImpact(model, 0, outputTokens, region);
	await platformUsageStore.addImpact(platform, impact.energy.estimateWh, impact.carbon.estimateGco2e);

	return updated;
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
	await platformUsageStore.setSubscriptionTier(message.platform, message.tier);
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
async function parseRequestBody(requestBody) {
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
		const urlParts = details.url.split('/');
		const orgIdx = urlParts.indexOf('organizations');
		const convIdx = urlParts.indexOf('chat_conversations');
		if (orgIdx === -1 || convIdx === -1) return;
		const orgId = urlParts[orgIdx + 1];
		await tokenStorageManager.addOrgId(orgId);
		const conversationId = urlParts[convIdx + 1];

		let model = "Sonnet";
		if (requestBodyJSON?.model) {
			const modelString = requestBodyJSON.model.toLowerCase();
			for (const modelType of CONFIG.MODELS) {
				if (modelString.includes(modelType.toLowerCase())) { model = modelType; break; }
			}
		}

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

		await pendingRequests.set(key, {
			orgId, conversationId, tabId: details.tabId, styleId, model,
			requestTimestamp: Date.now(), toolDefinitions: toolDefs, previousUsage
		});
	}

	if (details.method === "GET" && details.url.includes("/settings/billing")) {
		const orgId = await requestActiveOrgId(details.tabId);
		const api = new ClaudeAPI(details.cookieStoreId, orgId);
		await api.getSubscriptionTier(true);
	}
}

// Generic handler for ChatGPT, Gemini, Mistral: track the request with calibrated tokens
async function handleGenericBeforeRequest(details, platform) {
	const requestBodyJSON = await parseRequestBody(details.requestBody);
	if (!requestBodyJSON) {
		await Log("warn", `${platform}: request intercepted but body could not be parsed`, { url: details.url, method: details.method });
		return;
	}

	let model = 'unknown';
	let inputText = '';

	if (platform === 'chatgpt') {
		model = requestBodyJSON.model || 'gpt-4o';
		// ChatGPT may structure messages as array of objects or nested
		const messages = requestBodyJSON.messages || [];
		inputText = messages.map(m => {
			if (typeof m === 'string') return m;
			if (typeof m.content === 'string') return m.content;
			if (Array.isArray(m.content)) return m.content.map(p => p.text || p.value || '').join(' ');
			if (typeof m.content === 'object' && m.content !== null) return JSON.stringify(m.content);
			return '';
		}).join(' ');
		// Fallback: if messages parsing got nothing, try prompt or other fields
		if (!inputText.trim() && requestBodyJSON.prompt) inputText = requestBodyJSON.prompt;
		if (!inputText.trim()) inputText = JSON.stringify(requestBodyJSON).slice(0, 50000);
	} else if (platform === 'gemini') {
		// Try to extract model from request body, fall back to tier-based detection
		model = requestBodyJSON.model || null;
		if (!model) {
			const tier = await platformUsageStore.getSubscriptionTier('gemini');
			model = tier === 'advanced' ? 'gemini-2.5-pro' : 'gemini-2.0-flash';
		}
		// Gemini uses various internal formats; extract any text content
		inputText = JSON.stringify(requestBodyJSON).slice(0, 50000);
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
	}

	// Count tokens locally then apply platform-specific calibration factor
	const rawTokens = Math.round(GPTTokenizer_o200k_base.countTokens(inputText));
	const inputTokens = platformUsageStore.calibrateTokens(platform, rawTokens, 'input');

	await Log(`${platform}: intercepted ${details.method} to ${details.url.split('?')[0]}, model=${model}, inputChars=${inputText.length}, rawTokens=${rawTokens}, calibrated=${inputTokens}`);

	// Store model for this tab so output tokens can be attributed correctly
	lastModelByTab.set(`${platform}:${details.tabId}`, model);

	// Record calibrated input tokens (output will be added when stream completes)
	await platformUsageStore.recordRequest(platform, model, inputTokens, 0);

	// Estimate energy and carbon impact for this request's input tokens
	const region = await getStorageValue('carbonRegion', 'us-average');
	const impact = estimateImpact(model, inputTokens, 0, region);
	await platformUsageStore.addImpact(platform, impact.energy.estimateWh, impact.carbon.estimateGco2e);

	// Notify content script
	sendTabMessage(details.tabId, {
		type: 'platformUsageUpdate',
		data: { platform, model, inputTokens, outputTokens: 0 }
	});
}


async function processResponse(orgId, conversationId, responseKey, details) {
	const tabId = details.tabId;
	const api = new ClaudeAPI(details.cookieStoreId, orgId);

	const pendingRequest = await pendingRequests.get(responseKey);
	const isNewMessage = pendingRequest !== undefined;
	const model = pendingRequest?.model || "Sonnet";

	const usageData = await api.getUsageData();

	// Bridge Claude's API-detected tier to the popup's storage
	if (usageData?.subscriptionTier && usageData.subscriptionTier !== 'claude_free') {
		await platformUsageStore.setSubscriptionTier('claude', usageData.subscriptionTier);
	}

	const conversation = await api.getConversation(conversationId);
	const conversationData = await conversation.getInfo(isNewMessage);

	if (!conversationData) {
		await Log("warn", "Could not get conversation data, exiting...");
		return false;
	}

	let modifierCost = 0;
	const profileTokens = await api.getProfileTokens();
	modifierCost += profileTokens;

	const styleTokens = await api.getStyleTokens(pendingRequest?.styleId, tabId);
	modifierCost += styleTokens;

	if (pendingRequest?.toolDefinitions) {
		let toolTokens = 0;
		for (const tool of pendingRequest.toolDefinitions) {
			toolTokens += await tokenCounter.countText(`${tool.name} ${tool.description} ${tool.schema}`);
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
		await platformUsageStore.recordRequest('claude', model, conversationData.cost, 0);

		// Estimate energy and carbon for this Claude message
		const carbonRegion = await getStorageValue('carbonRegion', 'us-average');
		const impact = estimateImpact(model, conversationData.cost, 0, carbonRegion);
		await platformUsageStore.addImpact('claude', impact.energy.estimateWh, impact.carbon.estimateGco2e);
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

getAlarm('checkResetNotifications').then(existing => {
	if (!existing) {
		scheduleAlarm('checkResetNotifications', { periodInMinutes: 3 });
		Log("Created repeating checkResetNotifications alarm");
	}
});

isInitialized = true;
for (const handler of functionsPendingUntilInitialization) {
	handler.fn(...handler.args);
}
functionsPendingUntilInitialization = [];
Log("AI Cost & Usage Tracker background initialized.");

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
