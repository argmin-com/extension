// bg-components/decision-orchestrator.js
// Central decision coordinator. One function evaluates everything.
// Returns a single structured decision object that the UI renders.

import { CONFIG, getStorageValue } from './utils.js';
import { classifyTask, getTaskModelFit } from './task-classifier.js';
import { resolvePolicy, ACTION_CLASSES } from './policy-engine.js';
import { getUserProfile, getRecentEvents, recordEvent, genRequestId } from './event-store.js';
import { estimateImpact } from './carbon-energy.js';
import { getModelRecommendation, getBudgets, detectAnomaly } from './decision-engine.js';

// Model cost tier classification
const MODEL_COST_TIER = {
	'Haiku': 'cheap', 'gpt-4o-mini': 'cheap', 'gemini-2.0-flash': 'cheap', 'gemini-2.5-flash': 'cheap', 'mistral-small': 'cheap',
	'Sonnet': 'medium', 'gpt-4o': 'medium', 'gpt-4.1': 'medium', 'o4-mini': 'medium', 'mistral-large': 'medium', 'mistral-medium': 'medium',
	'Opus': 'expensive', 'o3': 'expensive', 'gemini-2.5-pro': 'expensive'
};

function getModelCostTier(model) {
	return MODEL_COST_TIER[model] || 'medium';
}

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

	// 3. Carbon estimation
	const region = await getStorageValue('carbonRegion', 'us-average');
	const impact = estimateImpact(model, inputTokens, 0, region);

	// 4. Model recommendation
	const recommendation = getModelRecommendation(platform, model, inputTokens);

	// 5. Budget state
	const budgets = await getBudgets();
	let budgetState = { dailyConsumedPct: 0 };
	if (budgets.dailyCostLimit && budgets.dailyCostLimit > 0) {
		// Get today's spend across all platforms
		const allUsage = await getStorageValue('platformUsageToday', {});
		let totalSpent = 0;
		for (const usage of Object.values(allUsage)) {
			totalSpent += usage?.estimatedCostUSD || 0;
		}
		budgetState.dailyConsumedPct = (totalSpent / budgets.dailyCostLimit) * 100;
	}

	// 6. Rate limit state (simplified)
	const rateLimitState = { risk: 'low' };

	// 7. User profile
	const userProfile = await getUserProfile();

	// 8. Build recommendations array
	const recommendations = [];
	if (recommendation) {
		const modelTier = getModelCostTier(model);
		const taskFit = getTaskModelFit(task.taskClass);
		const cheapFit = taskFit.cheap;
		const qualityRisk = cheapFit >= 0.7 ? 'low' : cheapFit >= 0.4 ? 'medium' : 'high';

		recommendations.push({
			type: 'model_switch',
			candidateModel: recommendation.cheaperModel,
			savingsPct: recommendation.estimatedSavingsPct,
			savingsUSD: recommendation.estimatedSavingsUSD,
			qualityRisk,
			reason: recommendation.rationale,
			taskClass: task.taskClass,
			taskConfidence: task.confidence
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
		policy
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

export { evaluateDecision, recordUserAction, ACTION_CLASSES };
