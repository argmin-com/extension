// bg-components/exporter.js
// CSV and JSON export inspired by codeburn `export`. Produces:
//   - Today rollup
//   - 7 day rollup
//   - 30 day rollup
//   - Per-session breakdown
// ...all in one payload, ready to be copied or downloaded by the popup.

import { sessionTracker } from './session-tracker.js';
import { platformUsageStore } from './platforms/platform-base.js';
import { CONFIG } from './utils.js';
import { buildUsageInsights } from './usage-insights.js';

function csvEscape(value) {
	if (value === null || value === undefined) return '';
	const s = String(value);
	if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

function rowsToCSV(rows) {
	if (!rows || rows.length === 0) return '';
	const headers = Object.keys(rows[0]);
	const lines = [headers.join(',')];
	for (const row of rows) {
		lines.push(headers.map(h => csvEscape(row[h])).join(','));
	}
	return lines.join('\n');
}

async function buildJSONExport() {
	const periods = ['today', '7days', '30days', 'month', 'all'];
	const rollups = {};
	for (const p of periods) {
		rollups[p] = await sessionTracker.computePeriodRollup({ period: p });
	}
	const sessions = await sessionTracker.getSessions({ period: '30days' });
	const perPlatform = {};
	for (const pid of Object.keys(CONFIG.PLATFORMS)) {
		perPlatform[pid] = {
			today: await platformUsageStore.getToday(pid),
			history7d: await platformUsageStore.getHistory(pid, 7),
			history30d: await platformUsageStore.getHistory(pid, 30),
			tier: await platformUsageStore.getSubscriptionTier(pid),
			velocity: await platformUsageStore.getVelocity(pid)
		};
	}
	return {
		generatedAt: new Date().toISOString(),
		schemaVersion: 1,
		rollups,
		sessions,
		perPlatform,
		insights: await buildUsageInsights()
	};
}

async function buildCSVExport() {
	const out = {};

	// Daily per-platform
	const dailyRows = [];
	for (const pid of Object.keys(CONFIG.PLATFORMS)) {
		const hist = await platformUsageStore.getHistory(pid, 30);
		for (const d of hist) {
			dailyRows.push({
				date: d.date,
				platform: pid,
				requests: d.requests || 0,
				inputTokens: d.inputTokens || 0,
				outputTokens: d.outputTokens || 0,
				costUSD: (d.estimatedCostUSD || 0).toFixed(6),
				energyWh: (d.totalEnergyWh || 0).toFixed(6),
				carbonGco2e: (d.totalCarbonGco2e || 0).toFixed(6)
			});
		}
	}
	dailyRows.sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform));
	out.daily = rowsToCSV(dailyRows);

	// Per-activity (30d)
	const rollup30 = await sessionTracker.computePeriodRollup({ period: '30days' });
	const activityRows = rollup30.categories.map(c => ({
		category: c.category,
		label: c.label,
		turns: c.turns,
		retries: c.retries,
		errors: c.errors,
		oneShotRate: c.oneShotRate === null ? '' : c.oneShotRate,
		inputTokens: c.inputTokens,
		outputTokens: c.outputTokens,
		costUSD: (c.cost || 0).toFixed(6)
	}));
	out.activity = rowsToCSV(activityRows);

	// Per-model (30d)
	out.models = rowsToCSV(rollup30.models.map(m => ({
		model: m.model,
		turns: m.turns,
		inputTokens: m.inputTokens,
		outputTokens: m.outputTokens,
		cacheReadTokens: m.cacheReadTokens,
		costUSD: (m.cost || 0).toFixed(6)
	})));

	// Sessions (top 30d)
	const sessions = await sessionTracker.getSessions({ period: '30days', limit: 100 });
	out.sessions = rowsToCSV(sessions.map(s => ({
		sessionId: s.sessionId,
		platform: s.platform,
		firstSeenAt: new Date(s.firstSeenAt).toISOString(),
		lastSeenAt: new Date(s.lastSeenAt).toISOString(),
		turnCount: s.turnCount,
		retryCount: s.retryCount,
		errorCount: s.errorCount,
		costUSD: (s.totalCostUSD || 0).toFixed(6),
		inputTokens: s.totalInputTokens,
		outputTokens: s.totalOutputTokens
	})));

	return out;
}

// Audit-log export. Single per-turn CSV with NO prompt-or-response content:
// only the metadata a compliance team needs to see who used what AI for how
// much. Each row corresponds to one recorded turn; columns are explicitly
// enumerated below so a future contributor adding a turn field to
// session-tracker doesn't accidentally leak it.
//
// AGENTS.md hard rule: this export must never include `promptText`,
// `promptHash`, `completion`, or any DOM/page content. The
// `release-hygiene` and `privacy-invariants` test suites assert that
// nothing in this output set crosses the boundary.
async function buildAuditExport({ period = '30days' } = {}) {
	const turns = await sessionTracker.getTurns({ period });
	const rows = turns.map(t => ({
		// ISO timestamp -- safe to share across timezones in a compliance
		// review.
		timestamp: new Date(t.ts).toISOString(),
		platform: t.platform,
		sessionId: t.sessionId,
		// `tag` is set by the user via the Sessions tab; absent on
		// pre-tagging turns. Persisted on session meta, joined in
		// downstream tooling.
		tag: t.tag || '',
		model: t.model,
		taskClass: t.category,
		inputTokens: t.inputTokens || 0,
		outputTokens: t.outputTokens || 0,
		cacheReadTokens: t.cacheReadTokens || 0,
		costUSD: (t.costUSD || 0).toFixed(6),
		isRetry: t.retryOf ? 'true' : 'false',
		hadError: t.hadError ? 'true' : 'false'
		// Deliberately NOT exported: promptHash, promptLength, similarity,
		// conversationUrl. Any of those would let a reviewer correlate
		// rows back to specific user content.
	}));
	return rowsToCSV(rows);
}

async function buildBillableExport({ period = '30days' } = {}) {
	// Per-session rollup with project tag + duration, suitable for
	// timesheet imports. Duration is wall-clock from first to last turn
	// in the session, capped at 8h to avoid charging clients for
	// abandoned tabs left open overnight.
	const MAX_BILLABLE_HOURS = 8;
	const sessions = await sessionTracker.getSessions({ period });
	const rows = sessions.map(s => {
		const startMs = s.firstSeenAt;
		const endMs = s.lastSeenAt;
		const rawMinutes = Math.max(0, (endMs - startMs) / 60000);
		const billableMinutes = Math.min(rawMinutes, MAX_BILLABLE_HOURS * 60);
		return {
			tag: s.tag || '',
			sessionId: s.sessionId,
			platform: s.platform,
			startedAt: new Date(startMs).toISOString(),
			lastSeenAt: new Date(endMs).toISOString(),
			billableMinutes: billableMinutes.toFixed(1),
			turns: s.turnCount,
			costUSD: (s.totalCostUSD || 0).toFixed(6),
			inputTokens: s.totalInputTokens,
			outputTokens: s.totalOutputTokens
		};
	});
	// Group rollup by tag for a quick summary row block.
	const byTag = new Map();
	for (const r of rows) {
		const k = r.tag || '(untagged)';
		const acc = byTag.get(k) || { tag: k, sessions: 0, totalMinutes: 0, totalCostUSD: 0 };
		acc.sessions += 1;
		acc.totalMinutes += Number(r.billableMinutes);
		acc.totalCostUSD += Number(r.costUSD);
		byTag.set(k, acc);
	}
	const summary = [...byTag.values()].map(g => ({
		tag: g.tag,
		sessions: g.sessions,
		totalMinutes: g.totalMinutes.toFixed(1),
		totalCostUSD: g.totalCostUSD.toFixed(6)
	}));
	return {
		summary: rowsToCSV(summary),
		sessions: rowsToCSV(rows)
	};
}

async function buildExport(format = 'json') {
	if (format === 'csv') return await buildCSVExport();
	if (format === 'audit') return await buildAuditExport();
	if (format === 'billable') return await buildBillableExport();
	return await buildJSONExport();
}

export { buildExport, buildJSONExport, buildCSVExport, buildAuditExport, buildBillableExport, rowsToCSV };
