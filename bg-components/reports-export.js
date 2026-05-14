// bg-components/reports-export.js
//
// Business-user exports surfaced under Tools -> Reports in the popup. All
// functions here are PURE so they can be unit-tested in node without a
// browser. The popup wires them up to download buttons via the message
// registry; the actual Blob + anchor-click side effect lives there.
//
// Privacy: all inputs are already-rolled-up usage records and findings.
// Nothing here reads from chrome.storage directly. Nothing leaves the
// device.

import { platformUsageStore } from './platforms/platform-base.js';
import { runOptimize } from './optimize-engine.js';
import { CONFIG } from './utils.js';

const USAGE_CSV_HEADERS = [
	'date',
	'platform',
	'model',
	'requests',
	'input_tokens',
	'output_tokens',
	'cost_usd',
	'energy_wh',
	'carbon_gco2e'
];

const FINDINGS_CSV_HEADERS = [
	'severity',
	'title',
	'detail',
	'fix',
	'est_savings_usd',
	'tag',
	'status',
	'platforms',
	'source_conversations'
];

// Escape a single CSV cell value. Values with commas, newlines, carriage
// returns, or double quotes get wrapped in double quotes; embedded quotes
// are doubled per RFC 4180.
function csvEscape(value) {
	if (value === null || value === undefined) return '';
	const s = String(value);
	if (s === '') return '';
	if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

function csvRow(values) {
	return values.map(csvEscape).join(',');
}

function pad2(n) { return String(n).padStart(2, '0'); }

function toYYYYMMDD(date) {
	const d = (date instanceof Date) ? date : new Date(date);
	return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}`;
}

function toISODate(date) {
	const d = (date instanceof Date) ? date : new Date(date);
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Numbers in CSV stay as plain decimals; never wrap with quotes so finance
// tools parse them as numbers. Returns '' for null/undefined so empty cells
// stay empty.
function fmtNumberCell(n, decimals = 6) {
	if (n === null || n === undefined || Number.isNaN(n)) return '';
	const num = Number(n);
	if (!Number.isFinite(num)) return '';
	return num.toFixed(decimals).replace(/\.?0+$/, '');
}

// Stable, recursive key-sort for deterministic JSON output. Arrays keep
// their order; objects get their keys sorted alphabetically. Round-trip
// tests rely on this being deterministic for the same input.
function sortKeys(value) {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
		return out;
	}
	return value;
}

// Build per-model rows for the usage CSV. Each daily rollup contains a
// `models` map; we explode it so each (date, platform, model) gets one
// line. Falls back to a single row labeled `(unknown)` when a day has
// usage but no per-model breakdown.
function rowsFromDailyRollups(dailyRollups) {
	const rows = [];
	for (const day of dailyRollups) {
		const date = day.date;
		const platform = day.platform;
		const models = day.models && typeof day.models === 'object' ? day.models : {};
		const modelKeys = Object.keys(models);

		// Day-level totals for energy and carbon. We attribute them to the
		// model rows proportionally by request count; if there is no model
		// breakdown we emit a single (unknown) row that carries the totals.
		const totalRequests = day.requests || 0;
		const totalEnergy = Number(day.totalEnergyWh || 0);
		const totalCarbon = Number(day.totalCarbonGco2e || 0);

		if (modelKeys.length === 0) {
			rows.push({
				date,
				platform,
				model: '(unknown)',
				requests: totalRequests,
				input_tokens: day.inputTokens || 0,
				output_tokens: day.outputTokens || 0,
				cost_usd: Number(day.estimatedCostUSD || 0),
				energy_wh: totalEnergy,
				carbon_gco2e: totalCarbon
			});
			continue;
		}

		// We don't carry per-model cost in the stored rollup, so reconstruct
		// it from PRICING. If pricing is missing, leave cost at 0 rather
		// than crashing.
		const pricing = (CONFIG && CONFIG.PRICING && CONFIG.PRICING[platform]) || {};

		// Sort models alphabetically for deterministic output (handy for
		// diff-driven workflows the user mentioned: finance/IT).
		for (const model of modelKeys.sort()) {
			const m = models[model] || {};
			const reqs = m.requests || 0;
			const input = m.inputTokens || 0;
			const output = m.outputTokens || 0;
			let cost = 0;
			const price = pricing[model] || null;
			if (price) {
				cost = (input / 1e6) * (price.input || 0)
					+ (output / 1e6) * (price.output || 0)
					+ (price.request || 0) * reqs;
			}
			const share = totalRequests > 0 ? reqs / totalRequests : 0;
			rows.push({
				date,
				platform,
				model,
				requests: reqs,
				input_tokens: input,
				output_tokens: output,
				cost_usd: cost,
				energy_wh: totalEnergy * share,
				carbon_gco2e: totalCarbon * share
			});
		}
	}
	return rows;
}

// Serialize rows produced by rowsFromDailyRollups into CSV text. Always
// emits the header even when there are no data rows (empty input still
// yields a valid CSV).
function serializeUsageCSV(rows) {
	const lines = [USAGE_CSV_HEADERS.join(',')];
	for (const r of rows) {
		lines.push(csvRow([
			r.date,
			r.platform,
			r.model,
			r.requests,
			r.input_tokens,
			r.output_tokens,
			fmtNumberCell(r.cost_usd, 6),
			fmtNumberCell(r.energy_wh, 6),
			fmtNumberCell(r.carbon_gco2e, 6)
		]));
	}
	return lines.join('\n');
}

function serializeFindingsCSV(findings) {
	const lines = [FINDINGS_CSV_HEADERS.join(',')];
	for (const f of findings || []) {
		// Graceful fallback: another agent is adding `platforms[]` and
		// `conversationUrls[]` to findings in parallel. If they are not
		// present, emit empty columns rather than crashing.
		const platforms = Array.isArray(f.platforms) ? f.platforms.join('+') : '';
		const convoSrc = Array.isArray(f.conversationUrls)
			? f.conversationUrls.slice(0, 3).join('; ')
			: '';
		lines.push(csvRow([
			f.severity || '',
			f.title || '',
			f.detail || '',
			f.fix || '',
			fmtNumberCell(f.estSavingsUSD || 0, 4),
			f.tag || '',
			f.status || '',
			platforms,
			convoSrc
		]));
	}
	return lines.join('\n');
}

// Filename helpers. Keep the (start,end) range in the filename so finance
// can sort multiple exports without opening them.
function usageFilename(startDate, endDate) {
	return `ai-cost-usage-${toYYYYMMDD(startDate)}-${toYYYYMMDD(endDate)}.csv`;
}

function findingsFilename(date = new Date()) {
	return `ai-cost-findings-${toISODate(date)}.csv`;
}

function fullJsonFilename(date = new Date()) {
	return `ai-cost-export-${toISODate(date)}.json`;
}

// Read daily rollups for a date range and (optionally) one platform. The
// store keys daily records under `${platform}:${YYYY-MM-DD}`; we walk the
// requested range so we don't depend on `getHistory(days)` rounding.
async function readDailyRollups({ startDate, endDate, platform = null, store = platformUsageStore } = {}) {
	const start = new Date(startDate);
	const end = new Date(endDate);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
	if (end < start) return [];

	const platforms = platform ? [platform] : Object.keys((CONFIG && CONFIG.PLATFORMS) || {});
	const rows = [];

	// Walk day-by-day so a 31-day month always produces at most 31 reads
	// per platform, regardless of getHistory implementation specifics.
	const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
	const finish = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
	while (cursor <= finish) {
		const dateKey = toISODate(cursor);
		for (const pid of platforms) {
			const rec = await store.store.get(`${pid}:${dateKey}`);
			if (rec) rows.push({ date: dateKey, platform: pid, ...rec });
		}
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return rows;
}

// PUBLIC API ───────────────────────────────────────────────────────────

async function exportUsageCSV({ startDate, endDate, platform = null } = {}) {
	const daily = await readDailyRollups({ startDate, endDate, platform });
	const rows = rowsFromDailyRollups(daily);
	return {
		filename: usageFilename(startDate, endDate),
		content: serializeUsageCSV(rows),
		mime: 'text/csv'
	};
}

async function exportFindingsCSV({ period = '30days' } = {}) {
	const result = await runOptimize({ period });
	return {
		filename: findingsFilename(new Date()),
		content: serializeFindingsCSV(result.findings || []),
		mime: 'text/csv'
	};
}

async function exportAllJSON({ period = '30days' } = {}) {
	// Pull current rollups for the configured period plus the full
	// findings result. Recommended actions surface alongside findings so
	// downstream tooling can drive an action queue without re-querying.
	const optimize = await runOptimize({ period });
	const daily = await readDailyRollups({
		startDate: lastNDaysStart(30),
		endDate: new Date()
	});
	const payload = {
		generatedAt: new Date().toISOString(),
		schemaVersion: 1,
		period,
		dailyRollups: daily,
		findings: optimize.findings || [],
		resolved: optimize.resolved || [],
		health: optimize.health || null,
		// "Recommended actions" in this codebase are surfaced as the
		// findings' `fix` field; we project them out to a flat list so
		// downstream tools can render a checklist without nesting.
		recommendedActions: (optimize.findings || []).map(f => ({
			id: f.id,
			severity: f.severity,
			title: f.title,
			action: f.fix,
			estSavingsUSD: f.estSavingsUSD || 0,
			tag: f.tag,
			status: f.status || ''
		}))
	};
	return {
		filename: fullJsonFilename(new Date()),
		content: JSON.stringify(sortKeys(payload), null, 2),
		mime: 'application/json'
	};
}

function lastNDaysStart(n) {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - (n - 1));
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

// Small derived summary the popup renders in a <details> block. Pure so
// the same logic can be exercised from a test.
function buildMonthlySummaryFromData({ dailyRollups, findings }) {
	let totalCostMTD = 0;
	const modelCosts = new Map();
	const platformPricing = (CONFIG && CONFIG.PRICING) || {};

	for (const day of dailyRollups || []) {
		totalCostMTD += Number(day.estimatedCostUSD || 0);
		const models = day.models && typeof day.models === 'object' ? day.models : {};
		const pricing = platformPricing[day.platform] || {};
		for (const [model, m] of Object.entries(models)) {
			const price = pricing[model];
			if (!price) continue;
			const cost = ((m.inputTokens || 0) / 1e6) * (price.input || 0)
				+ ((m.outputTokens || 0) / 1e6) * (price.output || 0);
			modelCosts.set(model, (modelCosts.get(model) || 0) + cost);
		}
	}

	const topModels = [...modelCosts.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([model, cost]) => ({ model, cost }));

	const safeFindings = Array.isArray(findings) ? findings : [];
	const topFinding = safeFindings.length === 0
		? null
		: [...safeFindings].sort((a, b) => (b.estSavingsUSD || 0) - (a.estSavingsUSD || 0))[0];

	return {
		totalCostMTD,
		topModels,
		findingsCount: safeFindings.length,
		topFinding: topFinding
			? {
				title: topFinding.title || '',
				estSavingsUSD: topFinding.estSavingsUSD || 0,
				severity: topFinding.severity || ''
			}
			: null
	};
}

async function buildMonthlySummary() {
	const start = startOfMonth(new Date());
	const end = new Date();
	const dailyRollups = await readDailyRollups({ startDate: start, endDate: end });
	const optimize = await runOptimize({ period: 'month' });
	return buildMonthlySummaryFromData({ dailyRollups, findings: optimize.findings || [] });
}

function startOfMonth(date) {
	return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export {
	exportUsageCSV,
	exportFindingsCSV,
	exportAllJSON,
	buildMonthlySummary,
	// Exposed for unit tests:
	csvEscape,
	serializeUsageCSV,
	serializeFindingsCSV,
	rowsFromDailyRollups,
	sortKeys,
	usageFilename,
	findingsFilename,
	fullJsonFilename,
	buildMonthlySummaryFromData,
	USAGE_CSV_HEADERS,
	FINDINGS_CSV_HEADERS
};
