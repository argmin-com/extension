// bg-components/event-store.js
// Request-level event persistence for the decision system.
// Three storage layers: request events, session summaries, user profile.
// All local. Bounded retention.

import { getStorageValue, setStorageValue } from './utils.js';

const MAX_EVENTS = 500;
const EVENT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// ── Request Events ──

async function recordEvent(event) {
	const events = await getStorageValue('decision:events', []);

	events.push({
		...event,
		timestamp: Date.now()
	});

	// Prune: keep max events, drop expired
	const cutoff = Date.now() - EVENT_TTL_MS;
	const pruned = events.filter(e => e.timestamp > cutoff).slice(-MAX_EVENTS);

	await setStorageValue('decision:events', pruned);
	return event;
}

async function getRecentEvents(count = 50, filters = {}) {
	const events = await getStorageValue('decision:events', []);
	let filtered = events;

	if (filters.platform) filtered = filtered.filter(e => e.platform === filters.platform);
	if (filters.model) filtered = filtered.filter(e => e.model === filters.model);
	if (filters.taskClass) filtered = filtered.filter(e => e.taskClass === filters.taskClass);
	if (filters.sessionId) filtered = filtered.filter(e => e.sessionId === filters.sessionId);

	return filtered.slice(-count);
}

// ── Session Summaries ──

async function updateSessionSummary(sessionId, update) {
	const key = `decision:session:${sessionId}`;
	const existing = await getStorageValue(key, {
		sessionId,
		startedAt: Date.now(),
		requestCount: 0,
		totalCostUSD: 0,
		interventionCount: 0,
		acceptedCount: 0,
		dismissedCount: 0,
		savingsCapturedUSD: 0,
		savingsMissedUSD: 0,
		dominantTaskClass: null
	});

	const merged = { ...existing, ...update, lastUpdatedAt: Date.now() };
	if (update.requestCount !== undefined) merged.requestCount = existing.requestCount + 1;
	if (update.costUSD !== undefined) merged.totalCostUSD = existing.totalCostUSD + update.costUSD;
	if (update.intervened) merged.interventionCount = existing.interventionCount + 1;
	if (update.accepted) merged.acceptedCount = existing.acceptedCount + 1;
	if (update.dismissed) merged.dismissedCount = existing.dismissedCount + 1;
	if (update.savingsCaptured !== undefined) merged.savingsCapturedUSD = existing.savingsCapturedUSD + update.savingsCaptured;
	if (update.savingsMissed !== undefined) merged.savingsMissedUSD = existing.savingsMissedUSD + update.savingsMissed;

	await setStorageValue(key, merged);
	return merged;
}

async function getSessionSummary(sessionId) {
	return await getStorageValue(`decision:session:${sessionId}`, null);
}

// ── User Profile ──

async function getUserProfile() {
	return await getStorageValue('decision:userProfile', {
		suggestionFatigueScore: 0,
		recentDismissals: 0,
		lastDismissalAt: null,
		preferredModels: {},
		taskPreferences: {},
		totalSavingsCaptured: 0,
		totalSavingsMissed: 0,
		totalInterventions: 0,
		totalAccepted: 0
	});
}

async function updateUserProfile(update) {
	const profile = await getUserProfile();

	if (update.dismissed) {
		profile.recentDismissals = Math.min(10, profile.recentDismissals + 1);
		profile.lastDismissalAt = Date.now();
		profile.suggestionFatigueScore = Math.min(1.0, profile.suggestionFatigueScore + 0.15);
	}

	if (update.accepted) {
		profile.recentDismissals = Math.max(0, profile.recentDismissals - 1);
		profile.suggestionFatigueScore = Math.max(0, profile.suggestionFatigueScore - 0.1);
		profile.totalAccepted++;
		if (update.savingsCaptured) profile.totalSavingsCaptured += update.savingsCaptured;
	}

	if (update.intervened) profile.totalInterventions++;
	if (update.savingsMissed) profile.totalSavingsMissed += update.savingsMissed;

	// Decay fatigue over time (every 6 hours reduce by 0.1)
	if (profile.lastDismissalAt) {
		const hoursSince = (Date.now() - profile.lastDismissalAt) / 3600000;
		if (hoursSince > 6) {
			const decaySteps = Math.floor(hoursSince / 6);
			profile.suggestionFatigueScore = Math.max(0, profile.suggestionFatigueScore - decaySteps * 0.1);
			profile.recentDismissals = Math.max(0, profile.recentDismissals - decaySteps);
		}
	}

	await setStorageValue('decision:userProfile', profile);
	return profile;
}

// ── Helpers ──

function genRequestId() {
	return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function genSessionId() {
	return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export {
	recordEvent, getRecentEvents,
	updateSessionSummary, getSessionSummary,
	getUserProfile, updateUserProfile,
	genRequestId, genSessionId
};
