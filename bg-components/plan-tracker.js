// bg-components/plan-tracker.js
// Subscription plan tracking inspired by codeburn's `plan` command.
// Lets the user declare their paid plan (Claude Pro, Claude Max, ChatGPT Plus,
// Gemini Advanced, Mistral Pro, or a custom monthly USD budget) and compares
// their API-equivalent spend against what they are already paying.
//
// Everything here is local: the plan is just a label + a monthly USD figure
// stored in browser.storage.local.

import { getStorageValue, setStorageValue, RawLog } from './utils.js';
import { sessionTracker } from './session-tracker.js';

async function Log(...args) { await RawLog('plan-tracker', ...args); }

// Monthly prices as of April 2026. These are the publicly stated prices and
// do not attempt to model exact token allowances -- vendors don't publish them.
const PLAN_PRESETS = {
	none:              { label: 'None',               provider: null,     monthlyUSD: 0 },
	claude_pro:        { label: 'Claude Pro',         provider: 'claude', monthlyUSD: 20 },
	claude_max_5x:     { label: 'Claude Max 5x',      provider: 'claude', monthlyUSD: 100 },
	claude_max_20x:    { label: 'Claude Max 20x',     provider: 'claude', monthlyUSD: 200 },
	chatgpt_plus:      { label: 'ChatGPT Plus',       provider: 'chatgpt', monthlyUSD: 20 },
	chatgpt_pro:       { label: 'ChatGPT Pro',        provider: 'chatgpt', monthlyUSD: 200 },
	chatgpt_team:      { label: 'ChatGPT Team',       provider: 'chatgpt', monthlyUSD: 30 },
	gemini_advanced:   { label: 'Gemini Advanced',    provider: 'gemini',  monthlyUSD: 20 },
	gemini_ultra:      { label: 'Gemini AI Ultra',    provider: 'gemini',  monthlyUSD: 250 },
	mistral_pro:       { label: 'Mistral Le Chat Pro', provider: 'mistral', monthlyUSD: 15 }
};

async function getPlan() {
	const plan = await getStorageValue('plan', { key: 'none' });
	if (plan.key === 'custom') return plan;
	const preset = PLAN_PRESETS[plan.key];
	if (!preset) return { key: 'none', ...PLAN_PRESETS.none };
	return { key: plan.key, ...preset };
}

async function setPlan({ key, monthlyUSD = null, provider = null, label = null } = {}) {
	if (!key) throw new Error('plan_key_required');
	if (key === 'custom') {
		if (!monthlyUSD || monthlyUSD <= 0) throw new Error('custom_plan_requires_monthly_usd');
		await setStorageValue('plan', {
			key: 'custom',
			label: label || 'Custom',
			provider: provider || null,
			monthlyUSD
		});
		return await getPlan();
	}
	if (!PLAN_PRESETS[key]) throw new Error(`unknown_plan:${key}`);
	await setStorageValue('plan', { key });
	return await getPlan();
}

async function resetPlan() {
	await setStorageValue('plan', { key: 'none' });
	return await getPlan();
}

async function getPlanInsights() {
	const plan = await getPlan();
	const rollup = await sessionTracker.computePeriodRollup({
		period: 'month',
		platform: plan.provider || null
	});

	const apiEquivalentUSD = rollup.overview.cost;
	const monthlyUSD = plan.monthlyUSD || 0;
	const pct = monthlyUSD > 0 ? (apiEquivalentUSD / monthlyUSD) * 100 : null;

	// Extrapolate to month end.
	const now = new Date();
	const dayOfMonth = now.getDate();
	const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
	const projectedUSD = dayOfMonth > 0 ? (apiEquivalentUSD / dayOfMonth) * daysInMonth : apiEquivalentUSD;

	let verdict;
	if (plan.key === 'none') {
		verdict = 'No plan set. Pick your subscription in the Plan tab to see how your API-equivalent spend compares.';
	} else if (apiEquivalentUSD === 0) {
		verdict = 'No tracked activity this month yet.';
	} else if (pct >= 100) {
		verdict = `Your plan is paying off: API-equivalent use is ${(pct - 100).toFixed(0)}% above the plan price.`;
	} else if (pct >= 60) {
		verdict = 'Your plan is roughly breaking even this month.';
	} else {
		verdict = `You are using a fraction of your plan (${pct.toFixed(0)}%). A cheaper tier would save money if this is a typical month.`;
	}

	return {
		plan,
		monthlyUSD,
		apiEquivalentUSD,
		percentageUsed: pct,
		projectedMonthEndUSD: projectedUSD,
		projectedPercentage: monthlyUSD > 0 ? (projectedUSD / monthlyUSD) * 100 : null,
		daysElapsed: dayOfMonth,
		daysInMonth,
		verdict,
		rollup
	};
}

function listPlans() {
	return Object.entries(PLAN_PRESETS).map(([key, meta]) => ({ key, ...meta }));
}

export { getPlan, setPlan, resetPlan, getPlanInsights, listPlans, PLAN_PRESETS };
