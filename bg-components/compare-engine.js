// bg-components/compare-engine.js
// Side-by-side model comparison inspired by codeburn's `compare` command.
// Given two model names, aggregate per-activity one-shot rates, cost metrics,
// cache behaviour, and working-style signals from the local turn log.

import { sessionTracker } from './session-tracker.js';
import { CATEGORY_LABELS } from './codeburn-classifier.js';

function aggregateFor(turns, model) {
	const picked = turns.filter(t => t.model === model);
	const total = {
		turns: picked.length,
		retries: 0,
		errors: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		costUSD: 0
	};
	const perCategory = {};
	for (const t of picked) {
		total.inputTokens += t.inputTokens || 0;
		total.outputTokens += t.outputTokens || 0;
		total.cacheReadTokens += t.cacheReadTokens || 0;
		total.cacheWriteTokens += t.cacheWriteTokens || 0;
		total.costUSD += t.costUSD || 0;
		if (t.retryOf) total.retries++;
		if (t.hadError) total.errors++;
		const cat = t.category || 'general';
		const e = perCategory[cat] ||= { category: cat, label: CATEGORY_LABELS[cat] || cat, turns: 0, retries: 0, cost: 0 };
		e.turns++;
		e.cost += t.costUSD || 0;
		if (t.retryOf) e.retries++;
	}

	// Derived metrics
	const oneShotRate = total.turns > 0 ? ((total.turns - total.retries) / total.turns) * 100 : null;
	const retryRate = total.turns > 0 ? (total.retries / total.turns) : 0;
	const costPerCall = total.turns > 0 ? total.costUSD / total.turns : 0;
	const outputPerCall = total.turns > 0 ? total.outputTokens / total.turns : 0;
	const cacheHitRate = (total.inputTokens + total.cacheReadTokens) > 0
		? (total.cacheReadTokens / (total.inputTokens + total.cacheReadTokens)) * 100
		: null;

	for (const c of Object.values(perCategory)) {
		c.oneShotRate = c.turns > 0 ? ((c.turns - c.retries) / c.turns) * 100 : null;
	}

	return {
		model,
		total,
		perCategory: Object.values(perCategory).sort((a, b) => b.turns - a.turns),
		metrics: {
			oneShotRate,
			retryRate,
			costPerCall,
			outputPerCall,
			cacheHitRate
		}
	};
}

async function compareModelsReal({ modelA, modelB, period = 'all', platform = null } = {}) {
	if (!modelA || !modelB) throw new Error('need_two_models');
	const turns = await sessionTracker.getTurns({ period, platform });
	const a = aggregateFor(turns, modelA);
	const b = aggregateFor(turns, modelB);

	// Diff table for the UI
	const categoryKeys = new Set([
		...a.perCategory.map(c => c.category),
		...b.perCategory.map(c => c.category)
	]);
	const categoryDiff = [];
	for (const cat of categoryKeys) {
		const ac = a.perCategory.find(c => c.category === cat);
		const bc = b.perCategory.find(c => c.category === cat);
		categoryDiff.push({
			category: cat,
			label: CATEGORY_LABELS[cat] || cat,
			a: ac || null,
			b: bc || null
		});
	}

	return {
		period,
		platform,
		a,
		b,
		categoryDiff,
		generatedAt: Date.now()
	};
}

async function availableModels({ period = '30days', platform = null } = {}) {
	const turns = await sessionTracker.getTurns({ period, platform });
	const counts = {};
	for (const t of turns) {
		counts[t.model] = (counts[t.model] || 0) + 1;
	}
	return Object.entries(counts)
		.sort((a, b) => b[1] - a[1])
		.map(([model, turns]) => ({ model, turns }));
}

export { compareModelsReal, availableModels };
