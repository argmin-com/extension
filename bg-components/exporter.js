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
		perPlatform
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

async function buildExport(format = 'json') {
	if (format === 'csv') return await buildCSVExport();
	return await buildJSONExport();
}

export { buildExport, buildJSONExport, buildCSVExport, rowsToCSV };
