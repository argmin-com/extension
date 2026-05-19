// bg-components/decision-orchestrator.js
// Central decision coordinator. One function evaluates everything.
// Returns a single structured decision object that the UI renders.

import { CONFIG, getStorageValue } from './utils.js';
import { classifyTask, getTaskModelFit } from './task-classifier.js';
import { resolvePolicy, ACTION_CLASSES } from './policy-engine.js';
import { getUserProfile, getRecentEvents, recordEvent, genRequestId } from './event-store.js';
import { estimateImpact } from './carbon-energy.js';
import { getModelRecommendation, getBudgets, detectAnomaly } from './decision-engine.js';
import { platformUsageStore } from './platforms/platform-base.js';
import { scanForSensitiveContent } from './sensitive-scanner.js';
import { analyseContextBloat } from './context-bloat.js';
import { sessionTracker } from './session-tracker.js';

// Model cost tier classification
const MODEL_COST_TIER = {
	'Haiku': 'cheap', 'gpt-4o-mini': 'cheap', 'gemini-2.0-flash': 'cheap', 'gemini-2.5-flash': 'cheap', 'mistral-small': 'cheap',
	'Sonnet': 'medium', 'gpt-4o': 'medium', 'gpt-4.1': 'medium', 'o4-mini': 'medium', 'mistral-large': 'medium', 'mistral-medium': 'medium',
	'Opus': 'expensive', 'o3': 'expensive', 'gemini-2.5-pro': 'expensive'
};

function getModelCostTier(model) {
	return MODEL_COST_TIER[model] || 'medium';
}

// Cache today's total spend across platforms; recompute at most once a second.
// evaluateDecision() runs on every keystroke; without this it re-reads
// platformUsageToday from storage and sums every entry on each call.
let _spendCache = { value: 0, fetchedAt: 0 };
const SPEND_CACHE_TTL_MS = 1000;
async function getTodaysTotalSpendUSD() {
	const now = Date.now();
	if (now - _spendCache.fetchedAt < SPEND_CACHE_TTL_MS) return _spendCache.value;
	const allUsage = await platformUsageStore.getAllPlatformsToday();
	let total = 0;
	for (const usage of Object.values(allUsage)) total += usage?.estimatedCostUSD || 0;
	_spendCache = { value: total, fetchedAt: now };
	return total;
}

// User-config cache. evaluateDecision() also reads carbonRegion,
// sensitiveScannerEnabled, sensitiveScannerCodeMode, the user profile,
// and the budgets object on every keystroke. None of these change
// unless the user opens Settings and toggles, so a 5s TTL is plenty
// for sub-1s perceived latency on a setting change while saving 5+
// async storage reads on every debounced composer tick.
let _settingsCache = { value: null, fetchedAt: 0 };
const SETTINGS_CACHE_TTL_MS = 5000;
async function getCachedSettings() {
	const now = Date.now();
	if (_settingsCache.value && now - _settingsCache.fetchedAt < SETTINGS_CACHE_TTL_MS) {
		return _settingsCache.value;
	}
	const [region, scannerEnabled, scannerCodeMode, budgets, userProfile] = await Promise.all([
		getStorageValue('carbonRegion', 'us-average'),
		getStorageValue('sensitiveScannerEnabled', true),
		getStorageValue('sensitiveScannerCodeMode', false),
		getBudgets(),
		getUserProfile()
	]);
	_settingsCache = {
		value: { region, scannerEnabled, scannerCodeMode, budgets, userProfile },
		fetchedAt: now
	};
	return _settingsCache.value;
}

// Test hook: callers (or unit tests) can force a refresh after mutating
// a setting from the popup. Background `setStorageValue` paths that
// touch any cached key call this so the next keystroke sees fresh state.
function invalidateSettingsCache() { _settingsCache = { value: null, fetchedAt: 0 }; }

/**
 * Evaluate a decision for a prompt before or during send.
 * This is the single entry point that replaces previewCost, getRecommendation,
 * checkBudgets, checkAnomaly, and computeEfficiency.
 *
 * @param {object} context
 * @param {string} context.platform
 * @param {string} context.model
 * @param {string} context.promptText - the current prompt text
 * @param {number} context.inputTokens - estimated input tokens
 * @param {string} context.phase - 'typing' | 'pre_send'
 * @param {string} context.sessionId
 * @param {number} context.tabId
 * @returns {object} structured decision result
 */
async function evaluateDecision(context) {
	const { platform, model, promptText, inputTokens, phase = 'typing', sessionId, tabId } = context;

	const requestId = genRequestId();

	// 1. Task classification
	const task = classifyTask(promptText || '');

	// 2. Cost estimation
	const pricing = CONFIG.PRICING[platform];
	let costEstimateUSD = 0;
	if (pricing) {
		const mp = pricing[model] || Object.values(pricing)[0];
		if (mp) {
			// Estimate output as 1.5x input for cost range (conservative)
			const estOutputTokens = Math.round(inputTokens * 1.5);
			costEstimateUSD = (inputTokens / 1e6) * mp.input + (estOutputTokens / 1e6) * mp.output;
		}
	}

	// One batched cache read covers carbonRegion + scanner flags + budgets
	// + userProfile -- all stable across keystrokes (5s TTL). The popup's
	// setSettings handlers call invalidateSettingsCache() on change so a
	// toggle is reflected within the next debounce window.
	const settings = await getCachedSettings();

	// 3. Carbon estimation
	const impact = estimateImpact(model, inputTokens, 0, settings.region);

	// 4. Model recommendation
	const recommendation = getModelRecommendation(platform, model, inputTokens);

	// 5. Budget state
	const budgets = settings.budgets;
	let budgetState = { dailyConsumedPct: 0 };
	if (budgets.dailyCostLimit && budgets.dailyCostLimit > 0) {
		const totalSpent = await getTodaysTotalSpendUSD();
		budgetState.dailyConsumedPct = (totalSpent / budgets.dailyCostLimit) * 100;
	}

	// 6. Rate limit state (simplified)
	const rateLimitState = { risk: 'low' };

	// 7. User profile (from settings cache)
	const userProfile = settings.userProfile;

	// 7b. Sensitive-content scan. Returns counts + categories only -- the
	// matched substrings never leave the scanner. The scan is opt-out via
	// `sensitiveScannerEnabled` (default ON) and opts into the noisier
	// code-shape patterns via `sensitiveScannerCodeMode` (default OFF).
	let sensitivity = { findings: [], maxSeverity: 'none' };
	if (settings.scannerEnabled) {
		sensitivity = scanForSensitiveContent(promptText || '', { codeMode: settings.scannerCodeMode });
	}

	// 7c. Context-bloat detection. Bounded to today's turns for the
	// current session (cheap; the bloat threshold is 30k input tokens
	// which a same-day session reaches in well under 24h). Avoids the
	// 7-day full scan the prior implementation did on every keystroke.
	let contextBloat = { bloated: false, reason: null, sessionTokens: 0 };
	if (sessionId) {
		try {
			const recent = await sessionTracker.getTurns({ period: 'today', sessionId });
			contextBloat = analyseContextBloat(recent);
		} catch (_e) { /* fail-open: no warning if turns are unavailable */ }
	}

	// 8. Build recommendations array
	const recommendations = [];
	if (recommendation) {
		const modelTier = getModelCostTier(model);
		const taskFit = getTaskModelFit(task.taskClass);
		const cheapFit = taskFit.cheap;
		const qualityRisk = cheapFit >= 0.7 ? 'low' : cheapFit >= 0.4 ? 'medium' : 'high';

		// "Good enough" framing: when the task-fit for the cheap tier is
		// high, lead with the concrete confidence instead of generic
		// "X is Y% cheaper" copy. Falls back to the engine's rationale
		// when fit is uncertain or task is `chat`. Numbers are rounded to
		// the nearest 5% so the UI doesn't look spuriously precise.
		const fitPct = Math.round(cheapFit * 20) * 5;
		const taskLabel = task.taskClass && task.taskClass !== 'chat' ? task.taskClass : null;
		let goodEnoughRationale = recommendation.rationale;
		if (qualityRisk === 'low' && taskLabel) {
			goodEnoughRationale = `${recommendation.cheaperModel} handles ${taskLabel} prompts well in about ${fitPct}% of cases.`;
		} else if (qualityRisk === 'medium' && taskLabel) {
			goodEnoughRationale = `${recommendation.cheaperModel} handles ${taskLabel} adequately in about ${fitPct}% of cases -- worth trying first.`;
		}

		recommendations.push({
			type: 'model_switch',
			candidateModel: recommendation.cheaperModel,
			savingsPct: recommendation.estimatedSavingsPct,
			savingsUSD: recommendation.estimatedSavingsUSD,
			qualityRisk,
			reason: goodEnoughRationale,
			taskClass: task.taskClass,
			taskConfidence: task.confidence,
			goodEnoughConfidence: cheapFit
		});
	}

	// 9. Policy decision
	const policy = resolvePolicy({
		estimates: { inputTokens, costEstimateUSD, confidence: task.confidence },
		recommendations,
		budgetState,
		rateLimitState,
		taskClass: task,
		userProfile,
		phase
	});

	// 10. Assemble decision result
	const decision = {
		requestId,
		context: { platform, model, phase, sessionId, tabId },
		task,
		estimates: {
			inputTokens,
			costEstimateUSD,
			energyWh: impact.energy.estimateWh,
			carbonGco2e: impact.carbon.estimateGco2e,
			confidence: task.confidence
		},
		recommendations,
		budgetState,
		rateLimitState,
		policy,
		sensitivity,
		contextBloat
	};

	// 11. Record event (non-blocking)
	recordEvent({
		requestId,
		platform,
		model,
		taskClass: task.taskClass,
		phase,
		inputTokens,
		costEstimateUSD,
		policyAction: policy.action,
		sessionId
	}).catch(() => {});

	return decision;
}

/**
 * Record what the user did with a decision (accepted, dismissed, sent anyway).
 */
async function recordUserAction(requestId, action, details = {}) {
	await recordEvent({
		requestId,
		eventType: 'user_action',
		action, // 'accepted', 'dismissed', 'sent_anyway', 'switched_model', 'rewrote_prompt'
		...details
	});
}

export { evaluateDecision, recordUserAction, invalidateSettingsCache, ACTION_CLASSES };
