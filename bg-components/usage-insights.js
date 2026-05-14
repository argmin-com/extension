// bg-components/usage-insights.js
// Local-first dashboard layer for cross-provider usage intelligence. This
// module stores settings and aggregate counts only; it never persists prompts,
// completions, or page DOM content.

import { CONFIG, getStorageValue, setStorageValue } from './utils.js';
import { platformUsageStore } from './platforms/platform-base.js';
import { sessionTracker } from './session-tracker.js';
import { getBudgets, checkBudgets } from './decision-engine.js';
import { getCurrency } from './currency.js';
import { getPlanInsights } from './plan-tracker.js';

const RETENTION_STORAGE_KEY = 'usageInsights:retentionDays';
const DEFAULT_RETENTION_DAYS = 35;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeRetentionDays(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_RETENTION_DAYS;
	return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(n)));
}

async function getRetentionPolicy() {
	const retentionDays = normalizeRetentionDays(await getStorageValue(RETENTION_STORAGE_KEY, DEFAULT_RETENTION_DAYS));
	return {
		retentionDays,
		defaultDays: DEFAULT_RETENTION_DAYS,
		minDays: MIN_RETENTION_DAYS,
		maxDays: MAX_RETENTION_DAYS,
		storageKey: RETENTION_STORAGE_KEY
	};
}

async function setRetentionDays(days) {
	const retentionDays = normalizeRetentionDays(days);
	await setStorageValue(RETENTION_STORAGE_KEY, retentionDays);
	return await getRetentionPolicy();
}

function parseDayKey(key) {
	const parts = String(key || '').split(':');
	if (parts.length < 2) return null;
	const date = parts[1];
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const ts = new Date(date + 'T23:59:59.999Z').getTime();
	return Number.isFinite(ts) ? ts : null;
}

async function cleanupLocalUsage(days = null) {
	const retentionDays = normalizeRetentionDays(days ?? (await getRetentionPolicy()).retentionDays);
	const cutoff = Date.now() - retentionDays * DAY_MS;
	const removed = { platformDays: 0, turns: 0, sessions: 0, decisionEvents: 0 };

	for (const [key] of await platformUsageStore.store.entries()) {
		const dayEnd = parseDayKey(key);
		if (dayEnd !== null && dayEnd < cutoff) {
			await platformUsageStore.store.delete(key);
			removed.platformDays += 1;
		}
	}
	await platformUsageStore.store.flush();

	for (const [key, turn] of await sessionTracker.turns.entries()) {
		if ((turn?.ts || 0) < cutoff) {
			await sessionTracker.turns.delete(key);
			removed.turns += 1;
		}
	}
	await sessionTracker.turns.flush();

	for (const [key, meta] of await sessionTracker.sessionMeta.entries()) {
		if ((meta?.lastSeenAt || meta?.firstSeenAt || 0) < cutoff) {
			await sessionTracker.sessionMeta.delete(key);
			removed.sessions += 1;
		}
	}
	await sessionTracker.sessionMeta.flush();

	const events = await getStorageValue('decision:events', []);
	if (Array.isArray(events) && events.length > 0) {
		const kept = events.filter(event => (event?.timestamp || 0) >= cutoff);
		removed.decisionEvents = events.length - kept.length;
		if (removed.decisionEvents > 0) await setStorageValue('decision:events', kept);
	}

	return { retentionDays, cutoff, removed };
}

function pricingFor(platform, model) {
	const pricing = CONFIG.PRICING[platform] || {};
	if (pricing[model]) return pricing[model];
	const lower = String(model || '').toLowerCase();
	for (const [key, value] of Object.entries(pricing)) {
		const k = key.toLowerCase();
		if (lower.includes(k) || k.includes(lower)) return value;
	}
	return Object.values(pricing)[0] || { input: 0, output: 0 };
}

function estimateModelCost(platform, model, inputTokens, outputTokens) {
	const p = pricingFor(platform, model);
	return ((inputTokens || 0) / 1e6) * (p.input || 0) + ((outputTokens || 0) / 1e6) * (p.output || 0);
}

function addModelEntry(map, platform, model, bucket, date) {
	const key = `${platform}:${model || 'unknown'}`;
	const inputTokens = bucket?.inputTokens || 0;
	const outputTokens = bucket?.outputTokens || 0;
	const existing = map.get(key) || {
		platform,
		model: model || 'unknown',
		requests: 0,
		inputTokens: 0,
		outputTokens: 0,
		estimatedCostUSD: 0,
		lastSeenDate: date
	};
	existing.requests += bucket?.requests || 0;
	existing.inputTokens += inputTokens;
	existing.outputTokens += outputTokens;
	existing.estimatedCostUSD += estimateModelCost(platform, model || 'unknown', inputTokens, outputTokens);
	if (!existing.lastSeenDate || String(date || '') > existing.lastSeenDate) existing.lastSeenDate = date;
	map.set(key, existing);
}

function summarizeProviderMix(today) {
	const rows = [];
	let totalCost = 0;
	let totalRequests = 0;
	let totalTokens = 0;
	for (const [platform, day] of Object.entries(today || {})) {
		const tokens = (day?.inputTokens || 0) + (day?.outputTokens || 0);
		const cost = day?.estimatedCostUSD || 0;
		const requests = day?.requests || 0;
		totalCost += cost;
		totalRequests += requests;
		totalTokens += tokens;
		rows.push({ platform, requests, tokens, estimatedCostUSD: cost, costSharePct: 0, requestSharePct: 0 });
	}
	for (const row of rows) {
		row.costSharePct = totalCost > 0 ? (row.estimatedCostUSD / totalCost) * 100 : 0;
		row.requestSharePct = totalRequests > 0 ? (row.requests / totalRequests) * 100 : 0;
	}
	rows.sort((a, b) => b.estimatedCostUSD - a.estimatedCostUSD || b.requests - a.requests);
	return { rows, totalCost, totalRequests, totalTokens };
}

function summarizeCaptureReliability(histories, today) {
	const sources = {};
	let activeRequests = 0;
	let legacyRequestRecords = 0;
	for (const [platform, days] of Object.entries(histories || {})) {
		for (const day of days || []) {
			const daySources = day.captureSources || {};
			const sourceTotal = Object.values(daySources).reduce((a, v) => a + (v || 0), 0);
			const requests = day.requests || 0;
			activeRequests += requests;
			if (requests > 0 && sourceTotal === 0) legacyRequestRecords += requests;
			for (const [source, count] of Object.entries(daySources)) {
				sources[source] = (sources[source] || 0) + (count || 0);
			}
		}
		const current = today?.[platform] || {};
		const currentSources = current.captureSources || {};
		for (const [source, count] of Object.entries(currentSources)) {
			if (!(days || []).some(day => day.date === new Date().toISOString().slice(0, 10))) {
				sources[source] = (sources[source] || 0) + (count || 0);
			}
		}
	}
	if (legacyRequestRecords > 0) sources.legacy = (sources.legacy || 0) + legacyRequestRecords;
	const eventCount = Object.values(sources).reduce((a, v) => a + (v || 0), 0);
	const fallbackCount = sources.fallback || 0;
	return {
		sources,
		eventCount,
		activeRequests,
		legacyRequestRecords,
		fallbackCount,
		fallbackSharePct: eventCount > 0 ? (fallbackCount / eventCount) * 100 : 0
	};
}

function summarizeBudgets(today, alerts, budgets) {
	let dailyCost = 0;
	let dailyCarbon = 0;
	for (const usage of Object.values(today || {})) {
		dailyCost += usage?.estimatedCostUSD || 0;
		dailyCarbon += usage?.totalCarbonGco2e || 0;
	}
	return {
		budgets,
		alerts,
		dailyCost,
		dailyCarbon,
		dailyCostPct: budgets?.dailyCostLimit ? (dailyCost / budgets.dailyCostLimit) * 100 : null,
		dailyCarbonPct: budgets?.dailyCarbonLimit ? (dailyCarbon / budgets.dailyCarbonLimit) * 100 : null
	};
}

function buildDataQualityWarnings({ today, captureReliability, modelLeaderboard, retentionPolicy }) {
	const warnings = [];
	const totalRequests = Object.values(today || {}).reduce((sum, day) => sum + (day?.requests || 0), 0);
	if (totalRequests === 0) {
		warnings.push({ level: 'info', code: 'no_activity_today', message: 'No tracked requests yet today.' });
	}
	if (captureReliability.legacyRequestRecords > 0) {
		warnings.push({
			level: 'info',
			code: 'legacy_capture_source',
			message: `${captureReliability.legacyRequestRecords} stored request${captureReliability.legacyRequestRecords === 1 ? '' : 's'} predate capture-source attribution.`
		});
	}
	if (captureReliability.fallbackCount > 0) {
		warnings.push({
			level: 'warn',
			code: 'fallback_capture',
			message: `${captureReliability.fallbackCount} event${captureReliability.fallbackCount === 1 ? '' : 's'} used a fallback estimate because provider usage details were unavailable.`
		});
	}
	for (const [platform, day] of Object.entries(today || {})) {
		if ((day?.requests || 0) > 0 && (day?.outputTokens || 0) === 0) {
			warnings.push({
				level: 'info',
				code: `${platform}_missing_output_tokens`,
				message: `${CONFIG.PLATFORMS[platform]?.name || platform} has input usage but no output stream tokens recorded yet.`
			});
		}
	}
	const unknown = modelLeaderboard.filter(row => row.model === 'unknown').reduce((sum, row) => sum + row.requests, 0);
	if (unknown > 0) {
		warnings.push({
			level: 'warn',
			code: 'unknown_model',
			message: `${unknown} request${unknown === 1 ? '' : 's'} could not be mapped to a known model for precise pricing.`
		});
	}
	if (retentionPolicy.retentionDays <= 7) {
		warnings.push({
			level: 'info',
			code: 'short_retention',
			message: `Local retention is set to ${retentionPolicy.retentionDays} day${retentionPolicy.retentionDays === 1 ? '' : 's'}, so long-range charts may be sparse.`
		});
	}
	return warnings.slice(0, 8);
}

async function buildUsageInsights() {
	const today = await platformUsageStore.getAllPlatformsToday();
	const histories = {};
	const modelMap = new Map();

	for (const platform of Object.keys(CONFIG.PLATFORMS)) {
		histories[platform] = await platformUsageStore.getHistory(platform, 30);
		for (const day of histories[platform]) {
			for (const [model, bucket] of Object.entries(day.models || {})) {
				addModelEntry(modelMap, platform, model, bucket, day.date);
			}
		}
	}

	const providerMix = summarizeProviderMix(today);
	const modelLeaderboard = Array.from(modelMap.values())
		.sort((a, b) => b.estimatedCostUSD - a.estimatedCostUSD || b.requests - a.requests)
		.slice(0, 12);
	const topProvider = providerMix.rows.find(row => row.requests > 0 || row.estimatedCostUSD > 0) || null;
	const topModel = modelLeaderboard[0] || null;
	const retentionPolicy = await getRetentionPolicy();
	const captureReliability = summarizeCaptureReliability(histories, today);
	const budgets = await getBudgets();
	const budgetAlerts = await checkBudgets(today);
	const budgetStatus = summarizeBudgets(today, budgetAlerts, budgets);
	let planStatus = null;
	try {
		const plan = await getPlanInsights();
		planStatus = {
			key: plan.plan?.key || 'none',
			label: plan.plan?.label || 'None',
			monthlyUSD: plan.monthlyUSD || 0,
			apiEquivalentUSD: plan.apiEquivalentUSD || 0,
			projectedMonthEndUSD: plan.projectedMonthEndUSD || 0,
			percentageUsed: plan.percentageUsed,
			verdict: plan.verdict
		};
	} catch (error) {
		planStatus = { key: 'unknown', label: 'Unavailable', error: error?.message || 'unknown' };
	}
	const privacySnapshot = {
		localFirst: true,
		telemetryEnabled: false,
		rawContentStored: false,
		anthropicApiOptIn: Boolean(await getStorageValue('apiKey', '')),
		currency: await getCurrency(),
		networkByDefault: false,
		optionalNetworkCalls: ['api.anthropic.com when API key is set', 'api.frankfurter.app when non-USD currency is selected']
	};
	const sessionRollup = await sessionTracker.computePeriodRollup({ period: '7days' });
	const dataQualityWarnings = buildDataQualityWarnings({ today, captureReliability, modelLeaderboard, retentionPolicy });

	return {
		generatedAt: new Date().toISOString(),
		schemaVersion: 1,
		dailyDigest: {
			totalCostUSD: providerMix.totalCost,
			totalRequests: providerMix.totalRequests,
			totalTokens: providerMix.totalTokens,
			activePlatforms: providerMix.rows.filter(row => row.requests > 0 || row.estimatedCostUSD > 0).length,
			topProvider,
			topModel,
			sessionTurns7d: sessionRollup.overview.turns,
			oneShotRate7d: sessionRollup.overview.oneShotRate
		},
		providerMix,
		modelLeaderboard,
		captureReliability,
		dataQualityWarnings,
		budgetStatus,
		planStatus,
		retentionPolicy,
		privacySnapshot
	};
}

async function handleUsageInsights(message = {}) {
	const action = message.action || 'dashboard';
	if (action === 'setRetentionDays') return await setRetentionDays(message.days);
	if (action === 'cleanup') return await cleanupLocalUsage(message.days);
	return await buildUsageInsights();
}

export {
	buildUsageInsights,
	cleanupLocalUsage,
	getRetentionPolicy,
	handleUsageInsights,
	normalizeRetentionDays,
	setRetentionDays
};
