// bg-components/session-tracker.js
// Per-conversation session tracking inspired by codeburn's session/turn model.
// Records each user turn with its activity category, cost, retry/regeneration
// signals, cache info, and model. Aggregates into per-activity one-shot rates,
// top expensive sessions, and period-scoped roll-ups.

import { StoredMap, getStorageValue, setStorageValue, RawLog } from './utils.js';
import { classifyCodeburn, CATEGORY_LABELS, CODEBURN_CATEGORIES } from './codeburn-classifier.js';

async function Log(...args) { await RawLog('session-tracker', ...args); }

const TURN_TTL_MS = 35 * 24 * 60 * 60 * 1000; // 35 days of turn history
const MAX_TURNS_PER_SESSION = 400;
const RETRY_WINDOW_MS = 3 * 60 * 1000; // two user turns within 3 minutes + similar text => retry

function hashText(text) {
	if (!text) return '';
	let h = 2166136261 >>> 0;
	const s = text.slice(0, 4000);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h.toString(36);
}

function normalizeForSimilarity(text) {
	return (text || '')
		.toLowerCase()
		.replace(/```[\s\S]*?```/g, ' CODEBLOCK ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 1200);
}

function jaccardTokens(a, b) {
	if (!a || !b) return 0;
	const sa = new Set(a.split(' ').filter(t => t.length > 2));
	const sb = new Set(b.split(' ').filter(t => t.length > 2));
	if (sa.size === 0 || sb.size === 0) return 0;
	let inter = 0;
	for (const t of sa) if (sb.has(t)) inter++;
	const union = sa.size + sb.size - inter;
	return union === 0 ? 0 : inter / union;
}

class SessionTracker {
	constructor() {
		this.turns = new StoredMap('sessionTurns');
		this.sessionMeta = new StoredMap('sessionMeta');
		// In-memory cache of the last turn per session for fast retry detection.
		this._recentBySession = new Map();
	}

	_dayKey(ts) {
		return new Date(ts).toISOString().slice(0, 10);
	}

	_turnKey(sessionId, ts) {
		return `${sessionId}:${ts}`;
	}

	async recordTurn({ platform, sessionId, promptText, model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, costUSD = 0, hadError = false, tabId = null }) {
		if (!platform || !sessionId) return null;
		const ts = Date.now();
		const classification = classifyCodeburn(promptText || '', { isRetry: false });

		// Retry detection: compare against the last turn in this session.
		const prev = this._recentBySession.get(sessionId);
		let retryOf = null;
		let similarity = 0;
		if (prev && (ts - prev.ts) <= RETRY_WINDOW_MS) {
			similarity = jaccardTokens(normalizeForSimilarity(promptText), prev.normalized);
			if (similarity >= 0.55) retryOf = prev.ts;
		}

		const turn = {
			ts,
			sessionId,
			platform,
			model: model || 'unknown',
			category: classification.category,
			categoryLabel: classification.label,
			confidence: classification.confidence,
			promptHash: hashText(promptText),
			promptLength: (promptText || '').length,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens,
			costUSD,
			hadError,
			retryOf,
			similarity: Math.round(similarity * 100) / 100,
			dayKey: this._dayKey(ts)
		};

		// Persist turn
		const key = this._turnKey(sessionId, ts);
		await this.turns.set(key, turn, TURN_TTL_MS);

		// Update session meta
		const existing = (await this.sessionMeta.get(sessionId)) || {
			sessionId,
			platform,
			firstSeenAt: ts,
			lastSeenAt: ts,
			turnCount: 0,
			totalCostUSD: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			retryCount: 0,
			errorCount: 0,
			categories: {},
			models: {},
			title: null
		};

		existing.lastSeenAt = ts;
		existing.turnCount += 1;
		existing.totalCostUSD += costUSD;
		existing.totalInputTokens += inputTokens;
		existing.totalOutputTokens += outputTokens;
		existing.totalCacheReadTokens += cacheReadTokens;
		existing.totalCacheWriteTokens += cacheWriteTokens;
		if (retryOf) existing.retryCount += 1;
		if (hadError) existing.errorCount += 1;
		existing.categories[classification.category] = (existing.categories[classification.category] || 0) + 1;
		existing.models[turn.model] = (existing.models[turn.model] || 0) + 1;
		await this.sessionMeta.set(sessionId, existing, TURN_TTL_MS);

		this._recentBySession.set(sessionId, {
			ts,
			normalized: normalizeForSimilarity(promptText),
			category: classification.category
		});

		await Log('Recorded turn', { platform, sessionId: sessionId.slice(0, 8) + '...', category: classification.category, retry: !!retryOf });
		return turn;
	}

	async setSessionTitle(sessionId, title) {
		const existing = (await this.sessionMeta.get(sessionId)) || null;
		if (!existing) return false;
		existing.title = (title || '').slice(0, 200);
		await this.sessionMeta.set(sessionId, existing, TURN_TTL_MS);
		return true;
	}

	_matchesPeriod(ts, period) {
		if (!period || period === 'all') return true;
		const now = Date.now();
		const start = new Date();
		start.setHours(0, 0, 0, 0);
		switch (period) {
			case 'today':
				return ts >= start.getTime();
			case '7days':
				return ts >= (now - 7 * 24 * 3600000);
			case '30days':
				return ts >= (now - 30 * 24 * 3600000);
			case 'month': {
				const m = new Date(); m.setDate(1); m.setHours(0, 0, 0, 0);
				return ts >= m.getTime();
			}
			default:
				if (typeof period === 'object' && period.from) {
					const from = new Date(period.from + 'T00:00:00').getTime();
					const to = period.to ? new Date(period.to + 'T23:59:59').getTime() : now;
					return ts >= from && ts <= to;
				}
				return true;
		}
	}

	async getTurns({ period = '7days', platform = null, sessionId = null, category = null } = {}) {
		const entries = await this.turns.entries();
		const out = [];
		for (const [, turn] of entries) {
			if (!turn || !turn.ts) continue;
			if (!this._matchesPeriod(turn.ts, period)) continue;
			if (platform && turn.platform !== platform) continue;
			if (sessionId && turn.sessionId !== sessionId) continue;
			if (category && turn.category !== category) continue;
			out.push(turn);
		}
		out.sort((a, b) => a.ts - b.ts);
		return out;
	}

	async getSessions({ period = '7days', platform = null, limit = null } = {}) {
		const entries = await this.sessionMeta.entries();
		const out = [];
		for (const [, meta] of entries) {
			if (!meta) continue;
			if (!this._matchesPeriod(meta.lastSeenAt, period)) continue;
			if (platform && meta.platform !== platform) continue;
			out.push(meta);
		}
		out.sort((a, b) => b.totalCostUSD - a.totalCostUSD);
		return limit ? out.slice(0, limit) : out;
	}

	async computePeriodRollup({ period = '7days', platform = null } = {}) {
		const turns = await this.getTurns({ period, platform });

		const total = {
			cost: 0, inputTokens: 0, outputTokens: 0,
			cacheReadTokens: 0, cacheWriteTokens: 0,
			turns: 0, retries: 0, errors: 0, sessions: 0
		};
		const perCategory = {};
		const perModel = {};
		const perSession = {};
		const daily = {};

		for (const t of turns) {
			total.cost += t.costUSD || 0;
			total.inputTokens += t.inputTokens || 0;
			total.outputTokens += t.outputTokens || 0;
			total.cacheReadTokens += t.cacheReadTokens || 0;
			total.cacheWriteTokens += t.cacheWriteTokens || 0;
			total.turns++;
			if (t.retryOf) total.retries++;
			if (t.hadError) total.errors++;

			const cat = t.category || 'general';
			const catEntry = perCategory[cat] ||= { category: cat, label: CATEGORY_LABELS[cat] || cat, cost: 0, turns: 0, retries: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
			catEntry.cost += t.costUSD || 0;
			catEntry.turns++;
			if (t.retryOf) catEntry.retries++;
			if (t.hadError) catEntry.errors++;
			catEntry.inputTokens += t.inputTokens || 0;
			catEntry.outputTokens += t.outputTokens || 0;

			const model = t.model || 'unknown';
			const modelEntry = perModel[model] ||= { model, cost: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
			modelEntry.cost += t.costUSD || 0;
			modelEntry.turns++;
			modelEntry.inputTokens += t.inputTokens || 0;
			modelEntry.outputTokens += t.outputTokens || 0;
			modelEntry.cacheReadTokens += t.cacheReadTokens || 0;

			const sid = t.sessionId;
			const sess = perSession[sid] ||= { sessionId: sid, platform: t.platform, cost: 0, turns: 0, firstSeenAt: t.ts, lastSeenAt: t.ts };
			sess.cost += t.costUSD || 0;
			sess.turns++;
			sess.firstSeenAt = Math.min(sess.firstSeenAt, t.ts);
			sess.lastSeenAt = Math.max(sess.lastSeenAt, t.ts);

			const day = t.dayKey || new Date(t.ts).toISOString().slice(0, 10);
			const dayEntry = daily[day] ||= { date: day, cost: 0, turns: 0, inputTokens: 0, outputTokens: 0 };
			dayEntry.cost += t.costUSD || 0;
			dayEntry.turns++;
			dayEntry.inputTokens += t.inputTokens || 0;
			dayEntry.outputTokens += t.outputTokens || 0;
		}

		total.sessions = Object.keys(perSession).length;

		// One-shot rate per category: fraction of non-retry turns that had no
		// retry/error chase. For categories where retries make less sense
		// (conversation, exploration) the value is still meaningful but lower weighted.
		for (const cat of Object.values(perCategory)) {
			const nonRetryTurns = Math.max(0, cat.turns - cat.retries);
			cat.oneShotRate = cat.turns === 0 ? null : Math.round((nonRetryTurns / cat.turns) * 10000) / 100;
		}

		// Cache hit rate: cache_read / (input + cache_read). Only meaningful if cache used.
		const totalRead = total.cacheReadTokens;
		const totalInputInclCache = total.inputTokens + totalRead;
		const cacheHitRate = totalInputInclCache > 0 ? Math.round((totalRead / totalInputInclCache) * 10000) / 100 : null;

		// Overall one-shot rate
		const oneShotRate = total.turns > 0 ? Math.round(((total.turns - total.retries) / total.turns) * 10000) / 100 : null;

		// Top expensive sessions
		const topSessions = Object.values(perSession)
			.sort((a, b) => b.cost - a.cost)
			.slice(0, 5);

		// Average cost per session
		const avgCostPerSession = total.sessions > 0 ? total.cost / total.sessions : 0;

		// Daily sorted
		const dailyArray = Object.values(daily).sort((a, b) => a.date.localeCompare(b.date));

		// Category sorted by cost desc
		const categoriesArray = CODEBURN_CATEGORIES
			.map(c => perCategory[c])
			.filter(Boolean)
			.sort((a, b) => b.cost - a.cost);

		const modelsArray = Object.values(perModel).sort((a, b) => b.cost - a.cost);

		return {
			period,
			platform,
			overview: {
				cost: total.cost,
				turns: total.turns,
				sessions: total.sessions,
				retries: total.retries,
				errors: total.errors,
				inputTokens: total.inputTokens,
				outputTokens: total.outputTokens,
				cacheReadTokens: total.cacheReadTokens,
				cacheWriteTokens: total.cacheWriteTokens,
				cacheHitRate,
				oneShotRate,
				avgCostPerSession
			},
			categories: categoriesArray,
			models: modelsArray,
			daily: dailyArray,
			topSessions
		};
	}

	async prune(maxTurns = 4000) {
		// Defensive: if the stored map grows beyond maxTurns, keep the newest.
		const entries = await this.turns.entries();
		if (entries.length <= maxTurns) return 0;
		entries.sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
		const dropCount = entries.length - maxTurns;
		for (let i = 0; i < dropCount; i++) {
			await this.turns.delete(entries[i][0]);
		}
		return dropCount;
	}

	async clear() {
		await this.turns.clear();
		await this.sessionMeta.clear();
		this._recentBySession.clear();
	}
}

const sessionTracker = new SessionTracker();

export { sessionTracker, SessionTracker };
