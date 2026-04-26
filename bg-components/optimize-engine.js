// bg-components/optimize-engine.js
// Browser-adapted version of codeburn `optimize`: scan recent turns and sessions
// for common waste patterns, emit findings with estimated savings and concrete
// fixes, then roll everything up into an A-F setup health grade.
//
// Because a browser extension cannot read CLAUDE.md / MCP config / agent files,
// findings here focus on patterns observable through intercepted traffic:
//   - Overpowered model for activity class
//   - Low cache hit rate
//   - High retry / low one-shot rate in a category
//   - Repeated near-duplicate prompts across sessions (re-asking the same thing)
//   - Conversation-heavy sessions (agent talking instead of doing)
//   - Low Read:Edit-style activity ratio on Claude (exploration without action)
//   - Exploratory model (Opus on tiny prompts)
//   - Very long prompts without cache
//   - Missing cache reads despite long multi-turn sessions

import { sessionTracker } from './session-tracker.js';
import { getActivityModelFit } from './codeburn-classifier.js';
import { CONFIG, getStorageValue, setStorageValue, RawLog } from './utils.js';

async function Log(...args) { await RawLog('optimize', ...args); }

const SEVERITY_WEIGHTS = { high: 3, medium: 2, low: 1 };

function modelTier(model) {
	if (!model) return 'medium';
	const m = model.toLowerCase();
	if (m.includes('opus') || m === 'o3' || m.includes('gemini-2.5-pro')) return 'expensive';
	if (m.includes('haiku') || m.includes('mini') || m.includes('flash') || m.includes('small')) return 'cheap';
	return 'medium';
}

function cheaperPeerForPlatform(platform, currentModel) {
	const pricing = CONFIG.PRICING[platform];
	if (!pricing) return null;
	let cheapest = null;
	let cheapestPrice = Infinity;
	for (const [model, p] of Object.entries(pricing)) {
		const price = (p.input || 0) + (p.output || 0) * 0.3;
		if (price < cheapestPrice) { cheapestPrice = price; cheapest = model; }
	}
	if (!cheapest || cheapest === currentModel) return null;
	return cheapest;
}

function priceFor(platform, model) {
	const pricing = CONFIG.PRICING[platform] || {};
	const hit = pricing[model] || Object.values(pricing).find(x => x) || { input: 0, output: 0 };
	return hit;
}

// Normalize a prompt for duplicate detection across sessions.
function dupKey(turn) {
	return `${turn.category}::${turn.promptHash}`;
}

async function scanOverpoweredModel(turns) {
	const findings = [];
	const overByCat = {};
	for (const t of turns) {
		const fit = getActivityModelFit(t.category);
		const tier = modelTier(t.model);
		// Flag turns where cheap fits >= 0.7 but user is on expensive model.
		if (tier === 'expensive' && fit.cheap >= 0.7) {
			const entry = overByCat[t.category] ||= { category: t.category, count: 0, cost: 0, platform: t.platform, sampleModel: t.model };
			entry.count++;
			entry.cost += t.costUSD || 0;
		}
	}
	for (const entry of Object.values(overByCat)) {
		if (entry.count < 3 || entry.cost < 0.01) continue;
		const cheaper = cheaperPeerForPlatform(entry.platform, entry.sampleModel) || 'a cheaper tier';
		const cheaperPrice = priceFor(entry.platform, cheaper);
		const currPrice = priceFor(entry.platform, entry.sampleModel);
		const inputRatio = (cheaperPrice.input && currPrice.input) ? cheaperPrice.input / currPrice.input : 0.1;
		const estSavings = entry.cost * (1 - inputRatio) * 0.9;
		findings.push({
			id: `overpowered:${entry.platform}:${entry.category}`,
			severity: estSavings > 1 ? 'high' : estSavings > 0.2 ? 'medium' : 'low',
			title: `Overpowered model on ${entry.category}`,
			detail: `${entry.count} turns on ${entry.sampleModel} for ${entry.category}, where a cheaper model typically holds up fine.`,
			estSavingsUSD: estSavings,
			fix: `Switch to ${cheaper} for ${entry.category} tasks. You can keep ${entry.sampleModel} for planning or complex refactors.`,
			tag: 'model'
		});
	}
	return findings;
}

async function scanCacheHit(rollup) {
	const findings = [];
	const rate = rollup.overview.cacheHitRate;
	const read = rollup.overview.cacheReadTokens || 0;
	const input = rollup.overview.inputTokens || 0;
	if (rate === null || (read + input) < 50000) return findings;
	if (rate < 60) {
		findings.push({
			id: 'cache:low',
			severity: rate < 30 ? 'high' : 'medium',
			title: `Cache hit rate is ${rate.toFixed(0)}%`,
			detail: 'A healthy conversational cache hit rate is 80%+. Low numbers usually mean the system prompt, tool list, or a long preamble is changing between turns.',
			estSavingsUSD: (input / 1e6) * 2.5 * 0.4, // rough
			fix: 'Stabilize system prompts, pin tool definitions, and avoid reshuffling conversation history. On Claude, enable cache_control on stable preamble blocks.',
			tag: 'cache'
		});
	}
	return findings;
}

async function scanOneShot(rollup) {
	const findings = [];
	for (const cat of rollup.categories) {
		if (cat.turns < 5) continue;
		if (['conversation', 'exploration', 'brainstorming'].includes(cat.category)) continue;
		if (cat.oneShotRate === null) continue;
		if (cat.oneShotRate < 55) {
			const retryCost = cat.cost * (cat.retries / Math.max(cat.turns, 1));
			findings.push({
				id: `oneshot:${cat.category}`,
				severity: cat.oneShotRate < 35 ? 'high' : 'medium',
				title: `Low one-shot rate on ${cat.label} (${cat.oneShotRate.toFixed(0)}%)`,
				detail: `${cat.retries}/${cat.turns} turns looked like retries or rephrasings. That usually means the first prompt is underspecified or the model is struggling on this task type.`,
				estSavingsUSD: retryCost,
				fix: `Add concrete context up front for ${cat.label} prompts: paste the exact error, the file path, the expected vs. actual behaviour. Consider a stronger model just for this category if retries persist.`,
				tag: 'one_shot'
			});
		}
	}
	return findings;
}

async function scanDuplicatePrompts(turns) {
	const findings = [];
	const byKey = new Map();
	for (const t of turns) {
		const k = dupKey(t);
		if (!byKey.has(k)) byKey.set(k, []);
		byKey.get(k).push(t);
	}
	for (const [key, group] of byKey.entries()) {
		if (group.length < 3) continue;
		// Skip tiny / short prompts -- they're usually just "thanks"
		if ((group[0].promptLength || 0) < 120) continue;
		// Count distinct sessions
		const sessions = new Set(group.map(t => t.sessionId));
		if (sessions.size < 2) continue;
		const totalCost = group.reduce((a, t) => a + (t.costUSD || 0), 0);
		findings.push({
			id: `dup:${key}`,
			severity: sessions.size >= 4 ? 'high' : 'medium',
			title: `Re-asking the same ${group[0].categoryLabel} prompt across ${sessions.size} sessions`,
			detail: `${group.length} turns with near-identical wording, spread over ${sessions.size} conversations. You are re-paying for the same context every time.`,
			estSavingsUSD: totalCost * 0.6,
			fix: 'Save the answer as a note, project rule, or Claude Project-style memory. Alternatively, pin the answer into your system prompt so future turns can reference it via cache.',
			tag: 'dup'
		});
	}
	return findings;
}

async function scanConversationDominant(rollup) {
	const findings = [];
	const convo = rollup.categories.find(c => c.category === 'conversation');
	if (!convo) return findings;
	const share = rollup.overview.turns > 0 ? convo.turns / rollup.overview.turns : 0;
	if (share > 0.35 && rollup.overview.turns >= 20) {
		findings.push({
			id: 'convo:dominant',
			severity: share > 0.5 ? 'medium' : 'low',
			title: `Conversation turns dominate (${(share * 100).toFixed(0)}%)`,
			detail: 'The agent is chatting more than acting. On coding-focused sessions this is usually sign of unclear direction or confirmation loops.',
			estSavingsUSD: convo.cost * 0.5,
			fix: 'Give the agent a concrete goal per message and skip confirmation turns. Switch to a cheap model for pure back-and-forth, or disable auto-acks in your workflow.',
			tag: 'conversation'
		});
	}
	return findings;
}

async function scanExplorationHeavy(rollup) {
	const findings = [];
	const explore = rollup.categories.find(c => c.category === 'exploration');
	const coding = rollup.categories.find(c => c.category === 'coding');
	if (!explore || !coding) return findings;
	const ratio = explore.turns / Math.max(coding.turns, 1);
	if (ratio > 2.5 && explore.turns >= 10) {
		findings.push({
			id: 'explore:heavy',
			severity: ratio > 4 ? 'medium' : 'low',
			title: `Exploration/coding ratio is ${ratio.toFixed(1)}:1`,
			detail: 'The agent is reading and summarizing way more than it\'s editing. That often means context is missing and each edit starts with a from-scratch tour.',
			estSavingsUSD: explore.cost * 0.4,
			fix: 'Front-load the relevant files or paste the key snippets directly. Pre-answer "where is X?" questions in the first message.',
			tag: 'exploration'
		});
	}
	return findings;
}

async function scanOpusOnShort(turns) {
	const findings = [];
	let count = 0;
	let cost = 0;
	for (const t of turns) {
		if (modelTier(t.model) !== 'expensive') continue;
		if ((t.inputTokens || 0) + (t.outputTokens || 0) > 2000) continue;
		if (['coding', 'debugging', 'feature_dev', 'refactoring', 'planning'].includes(t.category)) continue;
		count++;
		cost += t.costUSD || 0;
	}
	if (count >= 5 && cost > 0.05) {
		findings.push({
			id: 'opus:short',
			severity: cost > 0.5 ? 'high' : 'medium',
			title: `${count} short turns used a top-tier model`,
			detail: 'High-cost reasoning models rarely pay off for short non-coding prompts. You are paying premium rates for turns that a cheap model would answer identically.',
			estSavingsUSD: cost * 0.85,
			fix: 'Set a cheaper default model for short prompts, or create a keyboard shortcut / preset for "quick mode".',
			tag: 'model'
		});
	}
	return findings;
}

async function scanLongUncachedPrompts(turns) {
	const findings = [];
	const bigUncached = turns.filter(t =>
		(t.inputTokens || 0) > 20000 &&
		(t.cacheReadTokens || 0) < (t.inputTokens || 0) * 0.1
	);
	if (bigUncached.length < 3) return findings;
	const cost = bigUncached.reduce((a, t) => a + (t.costUSD || 0), 0);
	findings.push({
		id: 'cache:big_uncached',
		severity: cost > 1 ? 'high' : 'medium',
		title: `${bigUncached.length} long prompts ran without a cache hit`,
		detail: 'Messages with 20k+ input tokens and <10% cache read are paying full input price every time.',
		estSavingsUSD: cost * 0.5,
		fix: 'Move large stable context (docs, file dumps, specs) into a system prompt or cache-enabled block and reference it, instead of re-pasting it each turn.',
		tag: 'cache'
	});
	return findings;
}

function rollupGrade(findings, rollup) {
	if (rollup.overview.turns === 0) return { grade: 'N/A', score: null, rationale: 'No activity in this period yet.' };
	let penalty = 0;
	for (const f of findings) penalty += SEVERITY_WEIGHTS[f.severity] || 1;
	// Start at 100. Each severity point knocks off roughly 6.
	const score = Math.max(0, 100 - penalty * 6);
	let grade;
	if (score >= 90) grade = 'A';
	else if (score >= 80) grade = 'B';
	else if (score >= 65) grade = 'C';
	else if (score >= 50) grade = 'D';
	else grade = 'F';
	const rationale = findings.length === 0
		? 'Usage looks clean: model choice and cache behaviour are healthy for this period.'
		: `${findings.length} optimization opportunities totaling an estimated $${findings.reduce((a, f) => a + (f.estSavingsUSD || 0), 0).toFixed(2)} in avoidable spend.`;
	return { grade, score, rationale };
}

async function runOptimize({ period = '30days', platform = null } = {}) {
	const rollup = await sessionTracker.computePeriodRollup({ period, platform });
	const turns = await sessionTracker.getTurns({ period, platform });

	const scans = [
		await scanOverpoweredModel(turns),
		await scanCacheHit(rollup),
		await scanOneShot(rollup),
		await scanDuplicatePrompts(turns),
		await scanConversationDominant(rollup),
		await scanExplorationHeavy(rollup),
		await scanOpusOnShort(turns),
		await scanLongUncachedPrompts(turns)
	];

	let findings = scans.flat();

	// Rank: severity then est savings
	findings.sort((a, b) => (SEVERITY_WEIGHTS[b.severity] || 0) - (SEVERITY_WEIGHTS[a.severity] || 0) || (b.estSavingsUSD || 0) - (a.estSavingsUSD || 0));

	// Classify vs last run
	const prev = await getStorageValue('optimize:lastFindings', { ts: 0, ids: [] });
	const prevIds = new Set(prev.ids || []);
	for (const f of findings) {
		f.status = prevIds.has(f.id) ? 'ongoing' : 'new';
	}
	// Resolved: appeared last run, not this one. Emit as ghost entries.
	const currentIds = new Set(findings.map(f => f.id));
	const resolved = [...prevIds].filter(id => !currentIds.has(id));

	await setStorageValue('optimize:lastFindings', {
		ts: Date.now(),
		ids: findings.map(f => f.id)
	});

	const health = rollupGrade(findings, rollup);

	await Log('Optimize scan complete', { period, platform, findings: findings.length, grade: health.grade });

	return {
		period,
		platform,
		rollup,
		findings,
		resolved,
		health,
		generatedAt: Date.now()
	};
}

export { runOptimize };
