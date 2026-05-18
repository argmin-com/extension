// bg-components/daily-digest.js
// Local end-of-day digest. At a user-configurable hour each day, summarise
// today's tracked usage and fire a single Chrome notification. Local only:
// no telemetry, no off-device sync, no prompt content. The notification
// body is built from the same aggregates the popup already displays.
//
// State: a single `dailyDigest:lastFiredDayKey` storage value prevents
// double-firing if the user opens multiple browser windows on the same day.

import { getStorageValue, setStorageValue } from './utils.js';
import { platformUsageStore } from './platforms/platform-base.js';
import { sessionTracker } from './session-tracker.js';

const STATE_LAST_FIRED = 'dailyDigest:lastFiredDayKey';

function dayKey(date = new Date()) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, '0');
	const d = String(date.getDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

async function buildDigestText() {
	// Walk today's per-platform usage; pick the leader by cost.
	let totalCost = 0;
	let totalRequests = 0;
	let leader = null; // { id, cost }
	for (const id of ['claude', 'chatgpt', 'gemini', 'mistral', 'perplexity', 'grok', 'meta', 'copilot']) {
		const today = await platformUsageStore.getToday(id);
		if (!today) continue;
		const cost = today.estimatedCostUSD || 0;
		totalCost += cost;
		totalRequests += today.requests || 0;
		if (!leader || cost > leader.cost) leader = { id, cost };
	}
	if (totalRequests === 0) return null; // Nothing to report.

	// Top task class for today via session-tracker's rollup.
	let topTaskLabel = null;
	try {
		const rollup = await sessionTracker.computePeriodRollup({ period: 'today' });
		const top = (rollup.categories || []).sort((a, b) => b.turns - a.turns)[0];
		if (top && top.turns > 0) topTaskLabel = top.label || top.category;
	} catch (_e) { /* non-critical */ }

	const dollars = totalCost.toFixed(2);
	const parts = [`$${dollars} across ${totalRequests} prompt${totalRequests === 1 ? '' : 's'} today.`];
	if (leader && leader.id) parts.push(`Top platform: ${leader.id}.`);
	if (topTaskLabel) parts.push(`Top task: ${topTaskLabel}.`);
	parts.push('Open the popup for the breakdown.');
	return parts.join(' ');
}

/**
 * Should the digest fire right now? Checks user enablement, configured
 * hour, and whether we've already fired for this dayKey. Returns either
 * a fire decision with text, or a short reason for skipping.
 */
async function evaluateDailyDigest(now = new Date()) {
	const enabled = await getStorageValue('dailyDigestEnabled', false);
	if (!enabled) return { fire: false, reason: 'disabled' };
	const hour = await getStorageValue('dailyDigestHour', 18); // 6pm local
	if (now.getHours() < hour) return { fire: false, reason: 'too_early' };

	const today = dayKey(now);
	const lastFired = await getStorageValue(STATE_LAST_FIRED, null);
	if (lastFired === today) return { fire: false, reason: 'already_fired_today' };

	const text = await buildDigestText();
	if (!text) return { fire: false, reason: 'no_activity_today' };

	return { fire: true, text, today };
}

async function markDigestFired(dayKeyStr) {
	await setStorageValue(STATE_LAST_FIRED, dayKeyStr);
}

export { buildDigestText, evaluateDailyDigest, markDigestFired, dayKey };
