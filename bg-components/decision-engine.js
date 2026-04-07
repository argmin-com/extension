// bg-components/decision-engine.js
// Local decision intelligence: recommendations, anomaly detection, budget alerts.
// No external APIs. All heuristics run against locally stored usage data.

import { CONFIG, getStorageValue, setStorageValue } from './utils.js';
import { estimateImpact } from './carbon-energy.js';

// ── Model Recommendation Engine ──

const MODEL_TIERS = {
	claude:  [
		{ model: 'Haiku',  tier: 'low',    costPerMTokIn: 0.25 },
		{ model: 'Sonnet', tier: 'medium', costPerMTokIn: 3.0 },
		{ model: 'Opus',   tier: 'high',   costPerMTokIn: 15.0 }
	],
	chatgpt: [
		{ model: 'gpt-4o-mini', tier: 'low',    costPerMTokIn: 0.15 },
		{ model: 'gpt-4.1',    tier: 'medium', costPerMTokIn: 2.0 },
		{ model: 'gpt-4o',     tier: 'medium', costPerMTokIn: 2.5 },
		{ model: 'o4-mini',    tier: 'medium', costPerMTokIn: 1.1 },
		{ model: 'o3',         tier: 'high',   costPerMTokIn: 2.0 }
	],
	gemini: [
		{ model: 'gemini-2.0-flash', tier: 'low',    costPerMTokIn: 0.10 },
		{ model: 'gemini-2.5-flash', tier: 'low',    costPerMTokIn: 0.15 },
		{ model: 'gemini-2.5-pro',   tier: 'high',   costPerMTokIn: 1.25 }
	],
	mistral: [
		{ model: 'mistral-small',  tier: 'low',    costPerMTokIn: 0.20 },
		{ model: 'mistral-large',  tier: 'medium', costPerMTokIn: 2.0 },
		{ model: 'mistral-medium', tier: 'medium', costPerMTokIn: 2.7 }
	]
};

/**
 * Recommend a cheaper model for the same platform.
 * Returns null if the current model is already the cheapest.
 */
function getModelRecommendation(platform, currentModel, inputTokens) {
	const tiers = MODEL_TIERS[platform];
	if (!tiers) return null;

	const current = tiers.find(t => t.model === currentModel);
	if (!current) return null;

	// Find cheapest model on same platform
	const cheapest = tiers.reduce((a, b) => a.costPerMTokIn < b.costPerMTokIn ? a : b);
	if (cheapest.model === currentModel) return null;

	const currentCost = (inputTokens / 1e6) * current.costPerMTokIn;
	const cheaperCost = (inputTokens / 1e6) * cheapest.costPerMTokIn;
	const savingsPct = ((currentCost - cheaperCost) / currentCost) * 100;

	if (savingsPct < 20) return null; // Not worth recommending

	// Heuristic: short prompts (<2000 tokens) rarely need expensive models
	const isShortPrompt = inputTokens < 2000;
	const rationale = isShortPrompt
		? 'Short prompts rarely need high-capability models'
		: `${cheapest.model} costs ${savingsPct.toFixed(0)}% less for similar tasks`;

	return {
		cheaperModel: cheapest.model,
		estimatedSavingsUSD: currentCost - cheaperCost,
		estimatedSavingsPct: savingsPct,
		rationale,
		isShortPrompt
	};
}

// ── Anomaly Detection ──

/**
 * Detect anomalies by comparing today's usage to the 7-day rolling baseline.
 * Returns null if no anomaly, or an anomaly object with details.
 */
async function detectAnomaly(platform, todayUsage, usageStore) {
	if (!todayUsage || todayUsage.requests < 3) return null;

	// Get 7-day history
	const history = [];
	for (let i = 1; i <= 7; i++) {
		const d = new Date();
		d.setDate(d.getDate() - i);
		const key = `${platform}:${d.toISOString().slice(0, 10)}`;
		const day = await usageStore.store.get(key);
		if (day && day.requests > 0) history.push(day);
	}

	if (history.length < 2) return null; // Need baseline

	// Compute mean and standard deviation for cost
	const costs = history.map(d => d.estimatedCostUSD || 0);
	const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
	const variance = costs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / costs.length;
	const stdDev = Math.sqrt(variance);

	const todayCost = todayUsage.estimatedCostUSD || 0;
	if (mean === 0) return null;

	const zScore = stdDev > 0 ? (todayCost - mean) / stdDev : 0;
	const multiplier = todayCost / mean;

	if (multiplier < 2.0 && zScore < 2.0) return null;

	// Identify primary driver
	const avgTokens = history.reduce((a, d) => a + (d.inputTokens + d.outputTokens), 0) / history.length;
	const todayTokens = todayUsage.inputTokens + todayUsage.outputTokens;
	const tokenMultiplier = avgTokens > 0 ? todayTokens / avgTokens : 1;

	let driver = 'higher overall usage';
	if (tokenMultiplier > 1.5) driver = `token volume up ${((tokenMultiplier - 1) * 100).toFixed(0)}%`;

	const severity = multiplier >= 5 ? 'high' : multiplier >= 3 ? 'medium' : 'mild';

	return {
		severity,
		multiplier: multiplier.toFixed(1),
		todayCost: todayCost.toFixed(4),
		baselineCost: mean.toFixed(4),
		driver,
		detail: `Today's cost is ${multiplier.toFixed(1)}x your ${history.length}-day average`
	};
}

// ── Budget System ──


async function getBudgets() {
	return await getStorageValue('userBudgets', {
		dailyCostLimit: null,
		weeklyCostLimit: null,
		dailyCarbonLimit: null,
		weeklyCarbonLimit: null
	});
}

async function setBudgets(budgets) {
	await setStorageValue('userBudgets', budgets);
}

/**
 * Check if any budget threshold is approached or exceeded.
 * Returns array of alerts (empty if within budget).
 */
async function checkBudgets(allPlatformUsage) {
	const budgets = await getBudgets();
	const alerts = [];

	// Sum across all platforms for today
	let dailyCost = 0, dailyCarbon = 0;
	for (const [platform, usage] of Object.entries(allPlatformUsage)) {
		dailyCost += usage.estimatedCostUSD || 0;
		dailyCarbon += usage.totalCarbonGco2e || 0;
	}

	if (budgets.dailyCostLimit && dailyCost > 0) {
		const pct = (dailyCost / budgets.dailyCostLimit) * 100;
		if (pct >= 80) {
			alerts.push({
				type: 'cost',
				period: 'daily',
				current: dailyCost,
				limit: budgets.dailyCostLimit,
				percentage: pct,
				exceeded: pct >= 100
			});
		}
	}

	if (budgets.dailyCarbonLimit && dailyCarbon > 0) {
		const pct = (dailyCarbon / budgets.dailyCarbonLimit) * 100;
		if (pct >= 80) {
			alerts.push({
				type: 'carbon',
				period: 'daily',
				current: dailyCarbon,
				limit: budgets.dailyCarbonLimit,
				percentage: pct,
				exceeded: pct >= 100
			});
		}
	}

	return alerts;
}

// ── Prompt Efficiency Scoring ──

function computeEfficiency(inputTokens, outputTokens, costUSD) {
	if (inputTokens === 0) return null;
	const ratio = outputTokens / inputTokens;
	const costPerOutputToken = outputTokens > 0 ? costUSD / outputTokens : 0;

	let grade, label;
	if (ratio >= 2.0) { grade = 'high'; label = 'High efficiency'; }
	else if (ratio >= 0.5) { grade = 'medium'; label = 'Normal efficiency'; }
	else { grade = 'low'; label = 'Low efficiency (verbose input)'; }

	return { ratio: ratio.toFixed(2), grade, label, costPerOutputToken };
}

// ── Pre-Send Cost Preview ──

function previewCost(platform, model, estimatedInputTokens) {
	const pricing = CONFIG.PRICING[platform];
	if (!pricing) return null;

	// Find matching model pricing
	let mp = pricing[model];
	if (!mp) {
		// Fuzzy match
		for (const [key, val] of Object.entries(pricing)) {
			if (model.toLowerCase().includes(key.toLowerCase())) { mp = val; break; }
		}
	}
	if (!mp) mp = Object.values(pricing)[0]; // fallback to first

	const inputCostUSD = (estimatedInputTokens / 1e6) * mp.input;
	const region = 'us-average'; // Will use stored region
	const impact = estimateImpact(model, estimatedInputTokens, 0, region);

	const recommendation = getModelRecommendation(platform, model, estimatedInputTokens);

	return {
		estimatedInputTokens,
		estimatedCostUSD: inputCostUSD,
		estimatedEnergyWh: impact.energy.estimateWh,
		estimatedCarbonGco2e: impact.carbon.estimateGco2e,
		model,
		recommendation
	};
}

export {
	getModelRecommendation,
	detectAnomaly,
	getBudgets,
	setBudgets,
	checkBudgets,
	computeEfficiency,
	previewCost,
	MODEL_TIERS
};
