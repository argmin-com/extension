// bg-components/policy-engine.js
// Convert estimates, recommendations, and risk into a single action class.
// This is the control layer that makes the extension a decision system, not a dashboard.

const ACTION_CLASSES = {
	SILENT_PASS: 'silent_pass',
	PASSIVE_HINT: 'passive_hint',
	INLINE_RECOMMENDATION: 'inline_recommendation',
	CONFIRMATION_GATE: 'confirmation_gate',
	REWRITE_FIRST: 'rewrite_first'
};

/**
 * Resolve what action the UI should take for a given decision context.
 *
 * @param {object} params
 * @param {object} params.estimates - { inputTokens, costRangeUSD, confidence }
 * @param {object} params.recommendations - array of { type, savingsPct, qualityRisk }
 * @param {object} params.budgetState - { dailyConsumedPct, weeklyConsumedPct }
 * @param {object} params.rateLimitState - { risk: 'low'|'medium'|'high' }
 * @param {object} params.taskClass - { taskClass, confidence }
 * @param {object} params.userProfile - { suggestionFatigueScore, recentDismissals }
 * @param {string} params.phase - 'typing' | 'pre_send'
 * @returns {object} { action, reasonCode, priority }
 */
function resolvePolicy(params) {
	const {
		estimates = {},
		recommendations = [],
		budgetState = {},
		rateLimitState = {},
		taskClass = {},
		userProfile = {},
		phase = 'typing'
	} = params;

	const budgetPct = budgetState.dailyConsumedPct || 0;
	const costUSD = estimates.costEstimateUSD || 0;
	const bestRec = recommendations[0] || null;
	const savingsPct = bestRec?.savingsPct || 0;
	const qualityRisk = bestRec?.qualityRisk || 'unknown';
	const fatigue = userProfile.suggestionFatigueScore || 0;
	const recentDismissals = userProfile.recentDismissals || 0;
	const rateLimitRisk = rateLimitState.risk || 'low';
	const inputTokens = estimates.inputTokens || 0;

	// During typing phase, only show passive signals
	if (phase === 'typing') {
		if (costUSD < 0.01) {
			return { action: ACTION_CLASSES.SILENT_PASS, reasonCode: 'low_cost', priority: 'none' };
		}
		if (savingsPct >= 40 && budgetPct > 50) {
			return { action: ACTION_CLASSES.PASSIVE_HINT, reasonCode: 'savings_available_while_typing', priority: 'low' };
		}
		return { action: ACTION_CLASSES.SILENT_PASS, reasonCode: 'typing_phase_no_action', priority: 'none' };
	}

	// Pre-send phase: full policy evaluation

	// Rewrite-first: very long prompts with detectable redundancy
	if (inputTokens > 3000 && savingsPct >= 30 && taskClass.taskClass !== 'coding') {
		if (budgetPct > 60 || costUSD > 0.10) {
			return {
				action: ACTION_CLASSES.REWRITE_FIRST,
				reasonCode: 'long_prompt_with_savings_opportunity',
				priority: 'medium'
			};
		}
	}

	// Confirmation gate: budget nearly exhausted + expensive request
	if (budgetPct > 90 && costUSD > 0.05) {
		return {
			action: ACTION_CLASSES.CONFIRMATION_GATE,
			reasonCode: 'budget_nearly_exhausted',
			priority: 'high'
		};
	}

	// Confirmation gate: rate limit danger
	if (rateLimitRisk === 'high') {
		return {
			action: ACTION_CLASSES.CONFIRMATION_GATE,
			reasonCode: 'rate_limit_danger',
			priority: 'high'
		};
	}

	// Inline recommendation: material savings with acceptable quality risk
	if (savingsPct >= 40 && qualityRisk !== 'high') {
		// But respect fatigue: if user has dismissed 3+ times recently, downshift
		if (recentDismissals >= 3 && fatigue > 0.5) {
			return {
				action: ACTION_CLASSES.PASSIVE_HINT,
				reasonCode: 'savings_available_but_user_fatigued',
				priority: 'low'
			};
		}

		// Budget pressure amplifies intervention
		if (budgetPct > 70 || costUSD > 0.05) {
			return {
				action: ACTION_CLASSES.INLINE_RECOMMENDATION,
				reasonCode: 'large_savings_with_budget_pressure',
				priority: 'medium'
			};
		}

		return {
			action: ACTION_CLASSES.INLINE_RECOMMENDATION,
			reasonCode: 'large_savings_available',
			priority: 'low'
		};
	}

	// Passive hint: moderate savings or moderate budget pressure
	if (savingsPct >= 20 || (budgetPct > 60 && costUSD > 0.03)) {
		return {
			action: ACTION_CLASSES.PASSIVE_HINT,
			reasonCode: 'moderate_savings_or_budget_pressure',
			priority: 'low'
		};
	}

	// Default: silent pass
	return { action: ACTION_CLASSES.SILENT_PASS, reasonCode: 'no_intervention_needed', priority: 'none' };
}

export { resolvePolicy, ACTION_CLASSES };
