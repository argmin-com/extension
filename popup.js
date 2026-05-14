// popup.js
function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

// Build a section heading <h3>title</h3><span class="helper-text">subtitle</span> safely.
function setHeading(el, title, subtitle) {
	el.textContent = '';
	const h = document.createElement('h3');
	h.textContent = title;
	el.appendChild(h);
	if (subtitle !== undefined && subtitle !== null && subtitle !== '') {
		const s = document.createElement('span');
		s.className = 'helper-text';
		s.textContent = subtitle;
		el.appendChild(s);
	}
}

// Append a series of span children, each described by [text, className?].
function appendSpans(parent, specs) {
	for (const spec of specs) {
		const [text, cls] = Array.isArray(spec) ? spec : [spec];
		const s = document.createElement('span');
		if (cls) s.className = cls;
		s.textContent = text;
		parent.appendChild(s);
	}
}

// Validate a CSS hex color (`#rgb` or `#rrggbb`) before injecting into a style attribute.
// Falls back to a neutral grey for any non-conforming input so attacker-controlled
// strings can't break out of the value position.
function safeColor(c) {
	return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(c || '') ? c : '#888888';
}

const PLATFORMS = {
	claude:  { name: 'Claude',  color: '#d97706', tiers: { claude_free: 'Free', claude_pro: 'Pro', claude_max_5x: 'Max 5x', claude_max_20x: 'Max 20x' } },
	chatgpt: { name: 'ChatGPT', color: '#10a37f', tiers: { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team' } },
	gemini:  { name: 'Gemini',  color: '#4285f4', tiers: { free: 'Free', advanced: 'Advanced' } },
	mistral: { name: 'Mistral', color: '#f97316', tiers: { free: 'Free', pro: 'Pro' } }
};

document.getElementById('debugLink').addEventListener('click', (e) => {
	e.preventDefault();
	browser.tabs.create({ url: browser.runtime.getURL('debug.html') });
	window.close();
});

function activateTab(tabName) {
	tabs.forEach(tab => {
		const isActive = tab.dataset.tab === tabName;
		tab.classList.toggle('active', isActive);
		tab.setAttribute('aria-selected', String(isActive));
		tab.tabIndex = isActive ? 0 : -1;
	});
	document.querySelectorAll('.tab-content').forEach(content => {
		content.classList.toggle('active', content.id === tabName + 'Content');
	});
	if (tabName === 'history') loadHistory();
	if (tabName === 'tools') loadTools();
	if (tabName === 'methodology') loadMethodology();
	if (tabName === 'sessions') loadSessions();
	if (tabName === 'optimize') loadOptimize();
	if (tabName === 'compare') loadCompare();
	if (tabName === 'plan') loadPlan();
}

const tabs = Array.from(document.querySelectorAll('.tab'));

tabs.forEach(tab => {
	tab.addEventListener('click', () => activateTab(tab.dataset.tab));
	tab.addEventListener('keydown', (event) => {
		if (event.currentTarget !== document.activeElement) return;

		const currentIndex = tabs.indexOf(tab);

		if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
			event.preventDefault();
			let nextIndex = currentIndex;
			if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
			if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
			if (event.key === 'Home') nextIndex = 0;
			if (event.key === 'End') nextIndex = tabs.length - 1;
			tabs[nextIndex].focus();
			activateTab(tabs[nextIndex].dataset.tab);
			return;
		}

		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			activateTab(tab.dataset.tab);
		}
	});
});

async function msg(type, extra = {}) {
	return await browser.runtime.sendMessage({ type, ...extra });
}

function pctColor(pct, accent) {
	if (pct >= 90) return '#ef4444';
	if (pct >= 70) return '#eab308';
	return accent;
}

function fmtNum(n) { return (n || 0).toLocaleString(); }

// Compact, single-line relative time for narrow columns. Avoids two-line wraps
// like "May 13,\n11:05 AM" that the Top Sessions row was suffering from.
function fmtRelativeTime(ts) {
	if (!ts) return '—';
	const now = Date.now();
	const diff = now - new Date(ts).getTime();
	const min = 60_000, hr = 60 * min, day = 24 * hr;
	if (diff < min) return 'just now';
	if (diff < hr) return `${Math.floor(diff / min)}m ago`;
	if (diff < day) return `${Math.floor(diff / hr)}h ago`;
	if (diff < 2 * day) return 'yesterday';
	if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
	const d = new Date(ts);
	return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtEnergy(wh) {
	if (!wh || wh === 0) return '0 Wh';
	if (wh < 0.001) return wh.toFixed(6) + ' Wh';
	if (wh < 0.1) return wh.toFixed(4) + ' Wh';
	if (wh < 10) return wh.toFixed(2) + ' Wh';
	if (wh < 1000) return wh.toFixed(1) + ' Wh';
	return (wh / 1000).toFixed(2) + ' kWh';
}

function fmtCarbon(gco2e) {
	if (!gco2e || gco2e === 0) return '0 gCO₂e';
	if (gco2e < 0.001) return gco2e.toFixed(6) + ' gCO₂e';
	if (gco2e < 0.1) return gco2e.toFixed(4) + ' gCO₂e';
	if (gco2e < 10) return gco2e.toFixed(2) + ' gCO₂e';
	if (gco2e < 1000) return gco2e.toFixed(1) + ' gCO₂e';
	return (gco2e / 1000).toFixed(2) + ' kgCO₂e';
}

// ==================== TODAY TAB ====================

async function loadToday() {
	const content = document.getElementById('todayContent');
	try {
		const [allUsage, allForecasts, velocityResults, tierResults] = await Promise.all([
			msg('getPlatformUsageToday'),
			msg('getAllForecasts'),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getVelocity', { platform: p })])),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getSubscriptionTier', { platform: p })]))
		]);

		if (!allUsage) {
			content.innerHTML = '<div class="empty-state"><div>No activity yet.</div><div>Open one of the supported AI apps and the tracker will start filling in usage here.</div></div>';
			return;
		}

		const velMap = Object.fromEntries(velocityResults);
		const tierMap = Object.fromEntries(tierResults);
		let totalCost = 0, totalReqs = 0, totalEnergy = 0, totalCarbon = 0;
		let activePlatforms = 0;
		const platformCards = [];

		for (const [id, cfg] of Object.entries(PLATFORMS)) {
			const d = allUsage[id] || { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0 };
			const vel = velMap[id] || {};
			const forecasts = allForecasts?.[id] || [];
			const tier = tierMap[id] || 'free';
			const active = d.requests > 0;
			if (active) activePlatforms++;
			totalCost += d.estimatedCostUSD || 0;
			totalReqs += d.requests || 0;
			totalEnergy += d.totalEnergyWh || 0;
			totalCarbon += d.totalCarbonGco2e || 0;

			let cardHtml = `<div class="platform ${active ? '' : 'inactive'}" style="border-left-color:${cfg.color};">`;
			cardHtml += `<div class="plat-head"><span class="plat-name">${escapeHtml(cfg.name)}</span>`;
			cardHtml += active
				? `<span class="plat-cost" style="color:${cfg.color};">$${(d.estimatedCostUSD || 0).toFixed(4)}</span>`
				: '<span class="status-pill">No activity yet</span>';
			cardHtml += `</div>`;

			if (active) {
				cardHtml += `<div class="stats">`;
				cardHtml += `<span>Requests</span><span class="v">${fmtNum(d.requests)}</span>`;
				cardHtml += `<span>Input tokens</span><span class="v">${fmtNum(d.inputTokens)}</span>`;
				cardHtml += `<span>Output tokens</span><span class="v">${fmtNum(d.outputTokens)}</span>`;
				if (d.totalEnergyWh > 0) {
					cardHtml += `<span title="AI Energy Score benchmarks + parametric FLOPs estimation. PUE 1.2, overhead 2.0, ±30% uncertainty.">Energy</span><span class="v">${fmtEnergy(d.totalEnergyWh)}</span>`;
					cardHtml += `<span title="Energy × regional grid intensity (EPA eGRID, EEA, IEA). Directional estimate, not measurement.">Carbon</span><span class="v">${fmtCarbon(d.totalCarbonGco2e)}</span>`;
				}
				cardHtml += `</div>`;

				if (vel.tokensPerHour > 0) {
					cardHtml += `<div class="velocity-row">`;
					cardHtml += `<span>${fmtNum(Math.round(vel.tokensPerHour))} tok/hr</span>`;
					cardHtml += `<span>${vel.requestsPerHour?.toFixed(1)} req/hr</span>`;
					cardHtml += `<span>$${vel.costPerHour?.toFixed(4)}/hr</span>`;
					cardHtml += `</div>`;
				}

				if (forecasts.length > 0) {
					cardHtml += `<div class="forecast-section"><div class="fc-label">Limit Forecast</div>`;
					for (const fc of forecasts) {
						const c = pctColor(fc.percentage, cfg.color);
						const etaColor = fc.exhaustionTime ? '#ef4444' : '#22c55e';
						cardHtml += `<div class="fc-item">`;
						cardHtml += `<div class="fc-row"><span>${escapeHtml(fc.limitName)}</span><span class="fc-val" style="color:${c}">${fc.percentage.toFixed(0)}%</span></div>`;
						cardHtml += `<div class="fc-bar"><div class="fc-fill" style="width:${Math.min(fc.percentage,100)}%;background:${c}"></div></div>`;
						cardHtml += `<div class="fc-eta">`;
						cardHtml += fc.exhaustionTime
							? `<span>Hits limit: <span style="color:${etaColor}">${escapeHtml(fc.exhaustionTimeFormatted)}</span></span>`
							: `<span>Within limits</span>`;
						cardHtml += `<span>Resets: ${escapeHtml(fc.cycleResetFormatted || 'N/A')}</span></div></div>`;
					}
					cardHtml += `</div>`;
				}
			}

			cardHtml += `<div class="tier-row"><span>Plan:</span><select class="tier-sel" data-platform="${id}">`;
			for (const [tv, tl] of Object.entries(cfg.tiers)) {
				cardHtml += `<option value="${escapeHtml(tv)}" ${tv === tier ? 'selected' : ''}>${escapeHtml(tl)}</option>`;
			}
			cardHtml += `</select></div></div>`;
			platformCards.push(cardHtml);
		}

		let html = `<div class="overview-card">`;
		html += `<div class="overview-top"><div><div class="overview-label">Today Overview</div><div class="overview-total">$${totalCost.toFixed(4)}</div></div>`;
		html += `<div class="overview-subtitle">${activePlatforms} active platform${activePlatforms === 1 ? '' : 's'}</div></div>`;
		html += `<div class="overview-grid">`;
		html += `<div class="overview-metric"><div class="overview-metric-label">Requests</div><div class="overview-metric-value">${fmtNum(totalReqs)}</div></div>`;
		html += `<div class="overview-metric"><div class="overview-metric-label">Platforms</div><div class="overview-metric-value">${activePlatforms}/4</div></div>`;
		html += `<div class="overview-metric"><div class="overview-metric-label">Energy</div><div class="overview-metric-value">${fmtEnergy(totalEnergy)}</div></div>`;
		html += `<div class="overview-metric"><div class="overview-metric-label">Carbon</div><div class="overview-metric-value">${fmtCarbon(totalCarbon)}</div></div>`;
		html += `</div></div>`;
		html += `<div class="platforms">${platformCards.join('')}</div>`;

		// Totals
		html += `<div class="total"><span>Today (${totalReqs} reqs)</span><span class="total-cost">$${totalCost.toFixed(4)}</span></div>`;
		if (totalEnergy > 0 || totalCarbon > 0) {
			html += `<div class="total" style="font-size:11px;color:var(--text-dim);">`;
			html += `<span>${fmtEnergy(totalEnergy)}</span><span>${fmtCarbon(totalCarbon)}</span></div>`;
		}

		content.innerHTML = html;

		content.querySelectorAll('.tier-sel').forEach(sel => {
			sel.addEventListener('change', async () => {
				await msg('setSubscriptionTier', { platform: sel.dataset.platform, tier: sel.value });
				await loadToday();
			});
		});

	} catch (error) {
		content.textContent = ''; const errDiv = document.createElement('div'); errDiv.className = 'loading'; errDiv.textContent = 'Error: ' + error.message; content.appendChild(errDiv);
	}
}

// ==================== HISTORY TAB ====================

async function loadHistory() {
	const content = document.getElementById('historyContent');
	content.innerHTML = '<div class="loading">Loading history...</div>';

	try {
		// Fetch all four platforms in parallel; serial awaits were adding ~3x latency
		// to History tab open since each round-trip blocked the next.
		const platformIds = Object.keys(PLATFORMS);
		const results = await Promise.all(platformIds.map(pid => msg('getPlatformHistory', { platform: pid, days: 7 })));
		const historyData = Object.fromEntries(platformIds.map((pid, i) => [pid, results[i]]));

		let html = '<div class="platforms">';
		let anyData = false;

		for (const [id, cfg] of Object.entries(PLATFORMS)) {
			const days = historyData[id] || [];
			const totalRequests = days.reduce((sum, day) => sum + (day.requests || 0), 0);
			const totalCost = days.reduce((sum, day) => sum + (day.estimatedCostUSD || 0), 0);
			html += `<div class="history-platform" style="border-left: 4px solid ${cfg.color};">`;
			html += `<div class="history-platform-head"><div class="history-platform-name" style="color:${cfg.color}">${escapeHtml(cfg.name)}</div>`;
			html += `<div class="history-platform-summary">${fmtNum(totalRequests)} reqs · $${totalCost.toFixed(2)}</div></div>`;

			if (days.length === 0) {
				html += `<div class="no-history">No data in the last 7 days.</div>`;
			} else {
				anyData = true;
				html += `<div class="history-day header"><span>Date</span><span class="num">Reqs</span><span class="num">In Tok</span><span class="num">Out Tok</span><span class="num">Cost</span><span class="num">CO₂</span></div>`;
				for (const day of days) {
					html += `<div class="history-day">`;
					html += `<span>${formatDate(day.date)}</span>`;
					html += `<span class="num">${fmtNum(day.requests)}</span>`;
					html += `<span class="num">${fmtNum(day.inputTokens)}</span>`;
					html += `<span class="num">${fmtNum(day.outputTokens)}</span>`;
					html += `<span class="num">$${(day.estimatedCostUSD || 0).toFixed(2)}</span>`;
					html += `<span class="num">${day.totalCarbonGco2e ? fmtCarbon(day.totalCarbonGco2e) : '-'}</span>`;
					html += `</div>`;
				}
			}
			html += `</div>`;
		}

		if (!anyData) {
			html = '<div class="empty-state"><div>No history data yet.</div><div>Usage data appears here after the tracker sees requests, and it is retained for 48 hours.</div></div>';
		}

		html += '</div>';
		content.innerHTML = html;
	} catch (error) {
		content.textContent = ''; const errDiv = document.createElement('div'); errDiv.className = 'loading'; errDiv.textContent = 'Error: ' + error.message; content.appendChild(errDiv);
	}
}

function formatDate(dateStr) {
	const d = new Date(dateStr + 'T00:00:00');
	const today = new Date();
	today.setHours(0,0,0,0);
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);

	if (d.getTime() === today.getTime()) return 'Today';
	if (d.getTime() === yesterday.getTime()) return 'Yesterday';
	return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// Initial load
activateTab('today');
loadToday();

// ==================== TOOLS TAB ====================

async function loadTools() {
	const content = document.getElementById('toolsContent');
	const budgets = await msg('getBudgets') || {};
	const currentRegion = await msg('getRegion') || 'us-average';
	const regions = await msg('getRegions') || [];

	content.innerHTML = `
		<div class="section-card">
			<div class="fc-label" style="margin-bottom:6px;">REGION</div>
			<div class="region-bar" style="padding:0; border:none; margin-top:0;">
				<span style="opacity:0.6">Region:</span>
				<select class="region-sel"></select>
			</div>
			<div class="helper-text" style="margin-top:8px;">Used for carbon estimates only. This does not reveal which datacenter served your request.</div>
		</div>
		<div class="section-card">
			<div class="section-heading">
				<h3>Token Counter</h3>
				<span class="helper-text">Quick local estimate</span>
			</div>
			<div class="helper-text">Paste text to estimate tokens without sending anything off-device.</div>
			<label class="input-label"><span>Text to estimate</span>
				<textarea id="tokenizerInput" class="form-textarea" placeholder="Paste text here to count tokens and estimate cost..."></textarea>
			</label>
			<div id="tokenizerResult" class="inline-status"></div>
		</div>
		<div class="section-card">
			<div class="section-heading">
				<h3>Daily Budgets</h3>
				<span class="helper-text">Optional guardrails</span>
			</div>
			<div class="field-grid">
				<label class="input-label"><span>Cost limit ($)</span>
					<input type="number" class="form-input" id="budgetCost" min="0" step="0.5" placeholder="None">
				</label>
				<label class="input-label"><span>Carbon limit (gCO₂e)</span>
					<input type="number" class="form-input" id="budgetCarbon" min="0" step="1" placeholder="None">
				</label>
			</div>
			<div class="btn-row">
				<button id="saveBudgets" class="btn btn-primary">Save budgets</button>
			</div>
			<div id="budgetStatus" class="inline-status"></div>
		</div>
		<div class="section-card">
			<div class="section-heading">
				<h3>Model Comparison</h3>
				<span class="helper-text">Cost, energy, and carbon</span>
			</div>
			<div class="helper-text">Enter a prompt size in tokens to compare estimated cost, energy, and carbon across the supported models.</div>
			<div class="btn-row" style="align-items:flex-end;">
				<label class="input-label" style="flex:1;"><span>Prompt tokens</span>
					<input type="number" class="form-input" id="compareTokens" min="100" value="5000">
				</label>
				<button id="runCompare" class="btn btn-secondary" style="width:auto; min-width:110px;">Compare</button>
			</div>
			<div id="compareResult" class="inline-status"></div>
		</div>
	`;

	const regionSel = content.querySelector('.region-sel');
	if (regionSel) {
		for (const r of regions) {
			const opt = document.createElement('option');
			opt.value = r.id;
			opt.textContent = `${r.name} (${r.intensity} gCO₂/kWh)`;
			if (r.id === currentRegion) opt.selected = true;
			regionSel.appendChild(opt);
		}
		regionSel.addEventListener('change', async () => {
			await msg('setRegion', { region: regionSel.value });
		});
	}

	// Tokenizer sandbox
	const tokInput = content.querySelector('#tokenizerInput');
	const tokResult = content.querySelector('#tokenizerResult');
	let tokDebounce;
	tokInput.addEventListener('input', () => {
		clearTimeout(tokDebounce);
		tokDebounce = setTimeout(async () => {
			const text = tokInput.value;
			if (!text || text.length < 2) { tokResult.textContent = ''; return; }
			const tokens = await msg('countTokensLocal', { text });
			const costSonnet = (tokens / 1e6) * 3.0;
			const costHaiku = (tokens / 1e6) * 0.25;
			tokResult.textContent = `${tokens.toLocaleString()} tokens | Sonnet: $${costSonnet.toFixed(4)} | Haiku: $${costHaiku.toFixed(4)}`;
		}, 300);
	});

	// Pre-fill budget inputs from stored values (value assignment is auto-escaped by the DOM).
	if (budgets.dailyCostLimit != null) content.querySelector('#budgetCost').value = String(budgets.dailyCostLimit);
	if (budgets.dailyCarbonLimit != null) content.querySelector('#budgetCarbon').value = String(budgets.dailyCarbonLimit);

	// Budget management
	content.querySelector('#saveBudgets').addEventListener('click', async () => {
		const costRaw = content.querySelector('#budgetCost').value;
		const costVal = costRaw !== '' ? parseFloat(costRaw) : null;
		const carbonRaw = content.querySelector('#budgetCarbon').value;
		const carbonVal = carbonRaw !== '' ? parseFloat(carbonRaw) : null;
		await msg('setBudgets', { budgets: { dailyCostLimit: costVal, dailyCarbonLimit: carbonVal } });
		content.querySelector('#budgetStatus').textContent = 'Budgets saved.';
		setTimeout(() => { content.querySelector('#budgetStatus').textContent = ''; }, 2000);
	});

	// Model comparison
	content.querySelector('#runCompare').addEventListener('click', async () => {
		const tokenCount = parseInt(content.querySelector('#compareTokens').value) || 5000;
		// All models from CONFIG.PRICING
		const models = [
			'Haiku', 'Sonnet', 'Opus',
			'gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'o3', 'o4-mini',
			'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro',
			'mistral-small', 'mistral-large', 'mistral-medium'
		];
		const results = await msg('compareModels', { models, tokenCount, region: 'us-average' });
		const resultDiv = content.querySelector('#compareResult');
		if (!results || results.length === 0) { resultDiv.textContent = 'No results.'; return; }

		// Sort by cost ascending
		results.sort((a, b) => (a.costUSD || 0) - (b.costUSD || 0));

		resultDiv.textContent = '';
		const grid = document.createElement('div');
		grid.className = 'compare-grid';
		appendSpans(grid, [
			['Model', 'compare-head'],
			['Cost', 'compare-head num'],
			['Energy', 'compare-head num'],
			['CO₂', 'compare-head num']
		]);
		for (const r of results) {
			const cost = r.costUSD != null ? '$' + r.costUSD.toFixed(4) : '-';
			const energy = r.energyWh < 0.1 ? r.energyWh.toFixed(4) + ' Wh' : r.energyWh.toFixed(2) + ' Wh';
			const carbon = r.carbonGco2e < 0.1 ? r.carbonGco2e.toFixed(4) + ' g' : r.carbonGco2e.toFixed(2) + ' g';
			appendSpans(grid, [
				[r.model, 'compare-cell'],
				[cost, 'compare-cell num'],
				[energy, 'compare-cell num'],
				[carbon, 'compare-cell num']
			]);
		}
		resultDiv.appendChild(grid);
	});
}

async function loadMethodology() {
	const content = document.getElementById('methodologyContent');
	content.innerHTML = '<div class="loading">Loading methodology...</div>';
	const regions = await msg('getRegions') || [];
	const currentRegion = await msg('getRegion') || 'us-average';
	const allUsage = await msg('getPlatformUsageToday');
	let totalCarbon = 0;
	for (const [, d] of Object.entries(allUsage || {})) totalCarbon += d.totalCarbonGco2e || 0;
	const regionData = regions.find(r => r.id === currentRegion);
	const intensity = regionData?.intensity || 388;

	const milesDriven = totalCarbon / 400;
	const smartphones = totalCarbon / 8.22;
	const ledSeconds = totalCarbon / (0.01 * intensity / 1000 / 3600);
	const searches = totalCarbon / 0.2;

	content.innerHTML = `
		<div class="platforms">
			<div class="methodology-section"><div class="fc-label">TOKEN COUNTING</div>
				Input tokens are counted from request bodies using the o200k_base tokenizer (same tokenizer used by OpenAI and Anthropic models). Output tokens are counted from intercepted SSE stream text, also tokenized with o200k_base. For Claude, an optional Anthropic API call provides server-verified counts. Platform-specific calibration factors adjust for tokenizer variance.
			</div>
			<div class="methodology-section"><div class="fc-label">COST ESTIMATION</div>
				Costs are estimated using published API pricing. These represent the equivalent API cost of your usage, not your actual bill (subscription plans have flat monthly fees). Pricing is updated manually; see the Model Comparison tool for current rates per model.
			</div>
			<div class="methodology-section"><div class="fc-label">ENERGY ESTIMATION</div>
				Two methods are used. For Claude models, energy estimates are based on AI Energy Score v2 benchmarks (Hugging Face, December 2025), which provide measured energy per prompt at a reference token count, scaled proportionally to actual usage. For all other models, a parametric estimate is used:<br>
				<span class="methodology-formula">E(Wh) = 0.0001 x (parameters_billions ^ 0.8) x (total_tokens / 500)</span><br>
				Reasoning models (o3, o4-mini) apply a 3x compute multiplier. All estimates are then adjusted by PUE 1.2 (datacenter power overhead) and an inference serving overhead factor of 2.0. Uncertainty bounds are +/-30% on all values.
			</div>
			<div class="methodology-section"><div class="fc-label">CARBON ESTIMATION</div>
				Carbon emissions are calculated as:<br>
				<span class="methodology-formula">gCO2e = energy_Wh x grid_intensity_gCO2_per_kWh / 1000</span><br>
				Grid intensity depends on your selected region. The extension does not know which datacenter served your request; the user-selected region is an approximation. Grid intensity sources: EPA eGRID 2022 (US regions), EEA 2022 (EU regions), IEA 2022 (APAC and global).
				<div class="methodology-regions-table"></div>
			</div>
			<div class="methodology-section"><div class="fc-label">YOUR CARBON IN CONTEXT</div>
				<div class="methodology-equivalencies"></div>
				<div class="methodology-footnote">Equivalency factors from the EPA Greenhouse Gas Equivalencies Calculator (epa.gov/energy/greenhouse-gas-equivalencies-calculator). These are approximate conversions for intuitive context, not precise lifecycle analyses.</div>
			</div>
			<div class="methodology-section"><div class="fc-label">FORECASTING</div>
				The extension tracks known rate limits per platform and subscription tier (e.g., Claude Pro's 5-hour session window, ChatGPT Plus message caps). Exhaustion time is estimated by extrapolating your current usage velocity (tokens/hour, requests/hour) against remaining capacity. Custom limits can be set per platform in the badge settings panel.
			</div>
			<div class="methodology-section"><div class="fc-label">DECISION INTELLIGENCE</div>
				Cost Preview: estimates the cost of your next message before you send it, based on the input token count and active model pricing.<br><br>
				Model Recommendations: when a cheaper or more energy-efficient model could handle your prompt at equivalent quality, a suggestion chip appears.<br><br>
				Anomaly Detection: flags unusual usage spikes relative to your historical pattern.<br><br>
				Budget Alerts: when daily cost or carbon limits are set (via the Tools tab), approaching thresholds trigger in-page warnings.
			</div>
			<div class="methodology-section"><div class="fc-label">PRIVACY</div>
				All tracking data stays in your browser's local storage. No usage data, prompts, or responses are transmitted anywhere. The only optional external calls are (1) the Anthropic API for more accurate Claude token counting (explicit opt-in, sends only the text to be tokenized), and (2) Frankfurter.app for daily currency exchange rates when the user picks a non-USD display currency. Both are off by default.
			</div>
		</div>
	`;

	const regionsTable = content.querySelector('.methodology-regions-table');
	if (regionsTable) {
		const mkSpan = (text, cls = '', weight = false) => {
			const s = document.createElement('span');
			if (cls) s.className = cls;
			if (weight) s.style.fontWeight = '600';
			s.textContent = text;
			return s;
		};
		regionsTable.appendChild(mkSpan('Region', '', true));
		regionsTable.appendChild(mkSpan('gCO₂/kWh', 'num', true));
		regionsTable.appendChild(mkSpan('Source', '', true));
		for (const r of regions) {
			regionsTable.appendChild(mkSpan(r.name));
			regionsTable.appendChild(mkSpan(String(r.intensity), 'num'));
			regionsTable.appendChild(mkSpan(r.source || ''));
		}
	}

	const eqEl = content.querySelector('.methodology-equivalencies');
	if (eqEl) {
		if (totalCarbon > 0) {
			const intro = document.createElement('div');
			intro.textContent = `Your AI usage today (${fmtCarbon(totalCarbon)}) is equivalent to:`;
			eqEl.appendChild(intro);
			const ul = document.createElement('ul');
			ul.style.margin = '6px 0 0 16px';
			const items = [
				`Driving ${milesDriven.toFixed(2)} miles in a gasoline car`,
				`Charging a smartphone ${smartphones.toFixed(1)} times`,
				`Running a 10W LED bulb for ${Math.round(ledSeconds)} seconds`,
				`Performing ${Math.round(searches)} Google searches`
			];
			for (const t of items) {
				const li = document.createElement('li');
				li.textContent = t;
				ul.appendChild(li);
			}
			eqEl.appendChild(ul);
		} else {
			eqEl.textContent = 'No carbon data yet today. Use an AI platform to see equivalencies.';
		}
	}
}

// ==================== codeburn-style helpers ====================

const PERIOD_LABELS = { today: 'Today', '7days': '7 Days', '30days': '30 Days', month: 'Month', all: 'All Time' };
const PERIODS = ['today', '7days', '30days', 'month', 'all'];

let currentPeriod = '7days';
let displayCurrency = { code: 'USD', symbol: '$', rate: 1 };

async function primeCurrency() {
	try {
		const code = await msg('getCurrency');
		if (code && code !== 'USD') {
			const conv = await msg('convertUSD', { amountUSD: 1 });
			displayCurrency = { code: conv.currency, symbol: conv.symbol, rate: conv.rate };
		} else {
			displayCurrency = { code: 'USD', symbol: '$', rate: 1 };
		}
	} catch (e) {
		displayCurrency = { code: 'USD', symbol: '$', rate: 1 };
	}
}

function fmtMoney(amountUSD, decimals = null) {
	const amt = amountUSD * displayCurrency.rate;
	const d = decimals !== null ? decimals : (displayCurrency.code === 'JPY' || displayCurrency.code === 'KRW') ? 0 : (amt < 1 ? 4 : 2);
	return `${displayCurrency.symbol}${amt.toFixed(d)}`;
}

function fmtPct(v, digits = 0) {
	if (v === null || v === undefined) return '—';
	return `${v.toFixed(digits)}%`;
}

function buildPeriodBar(onChange) {
	const wrap = document.createElement('div');
	wrap.className = 'period-bar';
	for (const p of PERIODS) {
		const b = document.createElement('button');
		b.className = 'period-btn' + (p === currentPeriod ? ' active' : '');
		b.textContent = PERIOD_LABELS[p];
		b.addEventListener('click', () => {
			currentPeriod = p;
			wrap.querySelectorAll('.period-btn').forEach(btn => btn.classList.toggle('active', btn.textContent === PERIOD_LABELS[p]));
			onChange(p);
		});
		wrap.appendChild(b);
	}
	return wrap;
}

function oneShotClass(rate) {
	if (rate === null || rate === undefined) return '';
	if (rate >= 75) return '';
	if (rate >= 50) return 'mid';
	return 'low';
}

// ==================== SESSIONS TAB ====================

async function loadSessions() {
	await primeCurrency();
	const content = document.getElementById('sessionsContent');
	content.textContent = '';
	content.appendChild(buildPeriodBar(() => loadSessions()));

	const loading = document.createElement('div');
	loading.className = 'loading';
	loading.textContent = 'Computing rollup...';
	content.appendChild(loading);

	let rollup;
	try { rollup = await msg('getPeriodRollup', { period: currentPeriod }); }
	catch (e) { loading.textContent = 'Error: ' + e.message; return; }

	const ov = rollup.overview;
	content.removeChild(loading);

	if (ov.turns === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		const line1 = document.createElement('div');
		line1.textContent = `No tracked turns for ${PERIOD_LABELS[currentPeriod]}.`;
		const line2 = document.createElement('div');
		line2.textContent = 'Chat on any supported platform and sessions will appear here.';
		empty.append(line1, line2);
		content.appendChild(empty);
		return;
	}

	// Overview cards
	const overview = document.createElement('div');
	overview.className = 'rollup-overview';
	const cards = [
		{ label: 'Cost', value: fmtMoney(ov.cost), sub: `${fmtNum(ov.turns)} turns · ${fmtNum(ov.sessions)} sessions` },
		{ label: 'One-shot rate', value: fmtPct(ov.oneShotRate), sub: `${fmtNum(ov.retries)} retries detected` },
		{ label: 'Cache hit', value: ov.cacheHitRate === null ? '—' : fmtPct(ov.cacheHitRate), sub: `${fmtNum(ov.cacheReadTokens)} cached / ${fmtNum(ov.inputTokens)} input` },
		{ label: 'Avg cost / session', value: fmtMoney(ov.avgCostPerSession), sub: `${fmtNum(ov.inputTokens + ov.outputTokens)} tokens total` }
	];
	for (const c of cards) {
		const card = document.createElement('div');
		card.className = 'rollup-card';
		const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = c.label;
		const val = document.createElement('div'); val.className = 'value'; val.textContent = c.value;
		const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = c.sub;
		card.append(lbl, val, sub);
		overview.appendChild(card);
	}
	content.appendChild(overview);

	// Daily chart
	if (rollup.daily.length > 0) {
		const section = document.createElement('div');
		section.className = 'section-card';
		const hdr = document.createElement('div');
		hdr.className = 'section-heading';
		setHeading(hdr, 'Daily Cost', `${fmtNum(rollup.daily.length)} days`);
		section.appendChild(hdr);

		const maxCost = Math.max(...rollup.daily.map(d => d.cost), 0.0001);
		const chart = document.createElement('div');
		chart.className = 'daily-chart';
		for (const d of rollup.daily) {
			const bar = document.createElement('div');
			bar.className = 'daily-bar';
			bar.style.height = `${Math.max(2, (d.cost / maxCost) * 100)}%`;
			bar.title = `${d.date}: ${fmtMoney(d.cost)} (${d.turns} turns)`;
			chart.appendChild(bar);
		}
		section.appendChild(chart);
		content.appendChild(section);
	}

	// Activity / category breakdown with one-shot rate
	if (rollup.categories.length > 0) {
		const section = document.createElement('div');
		section.className = 'section-card';
		section.style.marginTop = '12px';
		const hdr = document.createElement('div');
		hdr.className = 'section-heading';
		setHeading(hdr, 'Activity Breakdown', 'cost + one-shot rate');
		section.appendChild(hdr);

		const header = document.createElement('div');
		header.className = 'cat-row header';
		appendSpans(header, ['Activity', ['Turns', 'num'], ['Retry', 'num'], ['Cost', 'num'], ['1-shot', 'num']]);
		section.appendChild(header);

		for (const c of rollup.categories) {
			const row = document.createElement('div');
			row.className = 'cat-row';
			const oneShotPct = c.oneShotRate ?? 0;
			const cls = oneShotClass(c.oneShotRate);
			appendSpans(row, [
				[c.label, 'label'],
				[fmtNum(c.turns), 'num'],
				[fmtNum(c.retries), 'num'],
				[fmtMoney(c.cost), 'num']
			]);
			const lastCell = document.createElement('span');
			lastCell.className = 'num';
			lastCell.appendChild(document.createTextNode(fmtPct(c.oneShotRate) + ' '));
			const bar = document.createElement('div');
			bar.className = 'oneshot-bar';
			const fill = document.createElement('div');
			fill.className = 'oneshot-fill ' + cls;
			fill.style.width = `${Math.min(100, oneShotPct)}%`;
			bar.appendChild(fill);
			lastCell.appendChild(bar);
			row.appendChild(lastCell);
			section.appendChild(row);
		}
		content.appendChild(section);
	}

	// Top expensive sessions
	if (rollup.topSessions.length > 0) {
		const section = document.createElement('div');
		section.className = 'section-card';
		section.style.marginTop = '12px';
		const hdr = document.createElement('div');
		hdr.className = 'section-heading';
		setHeading(hdr, 'Top Sessions', 'highest cost in period');
		section.appendChild(hdr);

		const header = document.createElement('div');
		header.className = 'session-row header';
		appendSpans(header, ['Session', ['Turns', 'num'], ['Last', 'num'], ['Cost', 'num']]);
		section.appendChild(header);

		// Sessions are returned ranked by cost; show their rank (1-N) instead of a
		// raw-id suffix, which previously read as garbled fragments (e.g. "261582:t").
		// The full id is preserved as a tooltip for power users.
		let rank = 0;
		for (const s of rollup.topSessions) {
			rank += 1;
			const row = document.createElement('div');
			row.className = 'session-row';
			const platColor = safeColor(PLATFORMS[s.platform]?.color);

			const nameCell = document.createElement('span');
			const dot = document.createElement('span');
			dot.className = 'platform-dot';
			dot.style.background = platColor;
			nameCell.appendChild(dot);
			nameCell.appendChild(document.createTextNode((PLATFORMS[s.platform]?.name || s.platform) + ' · '));
			const idSpan = document.createElement('span');
			idSpan.style.color = 'var(--text-muted)';
			idSpan.textContent = `Session #${rank}`;
			if (s.sessionId) idSpan.title = s.sessionId;
			nameCell.appendChild(idSpan);
			row.appendChild(nameCell);

			const turnsSpan = document.createElement('span');
			turnsSpan.className = 'num';
			turnsSpan.textContent = fmtNum(s.turns);
			row.appendChild(turnsSpan);

			const whenSpan = document.createElement('span');
			whenSpan.className = 'num';
			whenSpan.style.fontSize = '10px';
			whenSpan.style.color = 'var(--text-muted)';
			whenSpan.textContent = fmtRelativeTime(s.lastSeenAt);
			whenSpan.title = new Date(s.lastSeenAt).toLocaleString();
			whenSpan.style.whiteSpace = 'nowrap';
			row.appendChild(whenSpan);

			const costSpan = document.createElement('span');
			costSpan.className = 'num';
			costSpan.style.fontWeight = '700';
			costSpan.textContent = fmtMoney(s.cost);
			row.appendChild(costSpan);

			section.appendChild(row);
		}
		content.appendChild(section);
	}

	// Models breakdown
	if (rollup.models.length > 0) {
		const section = document.createElement('div');
		section.className = 'section-card';
		section.style.marginTop = '12px';
		const hdr = document.createElement('div');
		hdr.className = 'section-heading';
		setHeading(hdr, 'Models', 'cost by model');
		section.appendChild(hdr);
		const header = document.createElement('div');
		header.className = 'cat-row header';
		appendSpans(header, ['Model', ['Turns', 'num'], ['In tok', 'num'], ['Out tok', 'num'], ['Cost', 'num']]);
		section.appendChild(header);
		for (const m of rollup.models) {
			const row = document.createElement('div');
			row.className = 'cat-row';
			appendSpans(row, [
				[m.model, 'label'],
				[fmtNum(m.turns), 'num'],
				[fmtNum(m.inputTokens), 'num'],
				[fmtNum(m.outputTokens), 'num'],
				[fmtMoney(m.cost), 'num']
			]);
			section.appendChild(row);
		}
		content.appendChild(section);
	}
}

// ==================== OPTIMIZE TAB ====================

async function loadOptimize() {
	await primeCurrency();
	const content = document.getElementById('optimizeContent');
	content.textContent = '';
	content.appendChild(buildPeriodBar(() => loadOptimize()));

	const loading = document.createElement('div');
	loading.className = 'loading';
	loading.textContent = 'Scanning for waste patterns...';
	content.appendChild(loading);

	let result;
	try { result = await msg('runOptimize', { period: currentPeriod }); }
	catch (e) { loading.textContent = 'Error: ' + e.message; return; }
	content.removeChild(loading);

	// Health grade
	const grade = result.health;
	const totalSavings = result.findings.reduce((a, f) => a + (f.estSavingsUSD || 0), 0);
	const gradeCard = document.createElement('div');
	gradeCard.className = 'health-grade';

	// Grade letters from optimize-engine are constrained to A-F. Constrain at the
	// boundary anyway so an unexpected value can't smuggle a class name.
	const gradeLetter = /^[A-F]$/.test(grade.grade) ? grade.grade : '?';
	const letterEl = document.createElement('div');
	letterEl.className = `grade-letter grade-${gradeLetter}`;
	letterEl.textContent = gradeLetter;
	gradeCard.appendChild(letterEl);

	const infoEl = document.createElement('div');
	infoEl.className = 'grade-info';

	const scoreEl = document.createElement('div');
	scoreEl.className = 'grade-score';
	scoreEl.textContent = `Setup health · ${grade.score !== null ? Number(grade.score) + '/100' : 'N/A'}`;
	infoEl.appendChild(scoreEl);

	const rationaleEl = document.createElement('div');
	rationaleEl.className = 'grade-rationale';
	rationaleEl.textContent = grade.rationale;
	infoEl.appendChild(rationaleEl);

	if (totalSavings > 0) {
		const savingsEl = document.createElement('div');
		savingsEl.className = 'grade-score';
		savingsEl.style.marginTop = '4px';
		savingsEl.appendChild(document.createTextNode('Potential savings: '));
		const strong = document.createElement('strong');
		strong.textContent = fmtMoney(totalSavings);
		savingsEl.appendChild(strong);
		infoEl.appendChild(savingsEl);
	}
	gradeCard.appendChild(infoEl);
	content.appendChild(gradeCard);

	// Waste signal heuristics summary (always show for context)
	const ov = result.rollup.overview;
	const signals = document.createElement('div');
	signals.className = 'waste-signals';
	const conversationShare = (result.rollup.categories.find(c => c.category === 'conversation')?.turns || 0) / Math.max(ov.turns, 1);
	const signalData = [
		{
			ok: ov.cacheHitRate === null || ov.cacheHitRate >= 70,
			label: 'Cache hit rate:',
			body: ` ${ov.cacheHitRate === null ? 'n/a' : fmtPct(ov.cacheHitRate)} — ${ov.cacheHitRate === null || ov.cacheHitRate >= 70 ? 'healthy' : 'system prompt or context may be changing between turns'}`
		},
		{
			ok: ov.oneShotRate === null || ov.oneShotRate >= 70,
			label: 'One-shot rate:',
			body: ` ${fmtPct(ov.oneShotRate)} — ${ov.oneShotRate === null || ov.oneShotRate >= 70 ? 'first-try success is strong' : 'model is retrying/rephrasing often'}`
		},
		{
			ok: ov.turns === 0 || conversationShare < 0.35,
			label: 'Conversation share:',
			body: ` agent is ${conversationShare < 0.35 ? 'mostly acting' : 'chatting more than doing'}`
		}
	];
	for (const s of signalData) {
		const row = document.createElement('div');
		row.className = 'waste-signal ' + (s.ok ? 'ok' : 'warn');
		const dot = document.createElement('div');
		dot.className = 'dot';
		const text = document.createElement('div');
		text.className = 'text';
		const strong = document.createElement('strong');
		strong.textContent = s.label;
		text.appendChild(strong);
		text.appendChild(document.createTextNode(s.body));
		row.append(dot, text);
		signals.appendChild(row);
	}
	content.appendChild(signals);

	// Findings
	const section = document.createElement('div');
	section.className = 'section-card';
	section.style.marginTop = '12px';
	const hdr = document.createElement('div');
	hdr.className = 'section-heading';
	setHeading(hdr, 'Findings', `${fmtNum(result.findings.length)} issue${result.findings.length === 1 ? '' : 's'}`);
	section.appendChild(hdr);

	if (result.findings.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'helper-text';
		empty.style.padding = '10px 0';
		empty.textContent = 'No waste patterns detected in this period. Keep an eye on the signals above as usage grows.';
		section.appendChild(empty);
	} else {
		for (const f of result.findings) {
			const card = document.createElement('div');
			card.className = 'finding sev-' + f.severity;

			const title = document.createElement('div');
			title.className = 'title';
			const titleSpan = document.createElement('span');
			titleSpan.textContent = f.title;
			title.appendChild(titleSpan);
			const badge = document.createElement('span');
			badge.className = f.status === 'new' ? 'badge new' : 'badge';
			badge.textContent = f.status === 'new' ? 'New' : 'Ongoing';
			title.appendChild(badge);
			card.appendChild(title);

			const detail = document.createElement('div');
			detail.className = 'detail';
			detail.textContent = f.detail;
			card.appendChild(detail);

			const fix = document.createElement('div');
			fix.className = 'fix';
			fix.textContent = f.fix;
			card.appendChild(fix);

			const savings = document.createElement('div');
			savings.className = 'savings';
			savings.appendChild(document.createTextNode('Estimated savings: '));
			const savingsStrong = document.createElement('strong');
			savingsStrong.textContent = fmtMoney(f.estSavingsUSD || 0);
			savings.appendChild(savingsStrong);
			savings.appendChild(document.createTextNode(` · severity ${f.severity} · tag `));
			const tag = document.createElement('code');
			tag.textContent = f.tag;
			savings.appendChild(tag);
			card.appendChild(savings);

			section.appendChild(card);
		}
	}
	content.appendChild(section);

	// Resolved findings note
	if (result.resolved && result.resolved.length > 0) {
		const resolved = document.createElement('div');
		resolved.className = 'helper-text';
		resolved.style.marginTop = '8px';
		resolved.textContent = `Resolved since last scan: ${result.resolved.length}`;
		content.appendChild(resolved);
	}
}

// ==================== COMPARE TAB ====================

async function loadCompare() {
	await primeCurrency();
	const content = document.getElementById('compareContent');
	content.textContent = '';
	content.appendChild(buildPeriodBar(() => loadCompare()));

	const loading = document.createElement('div');
	loading.className = 'loading';
	loading.textContent = 'Loading available models...';
	content.appendChild(loading);

	let models;
	try { models = await msg('getAvailableModels', { period: currentPeriod }); }
	catch (e) { loading.textContent = 'Error: ' + e.message; return; }

	content.removeChild(loading);

	if (!models || models.length < 2) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		const line1 = document.createElement('div');
		line1.textContent = 'Need at least two models with recorded turns in this period.';
		const line2 = document.createElement('div');
		line2.textContent = 'Try switching period or using a different model for a few prompts.';
		empty.append(line1, line2);
		content.appendChild(empty);
		return;
	}

	const section = document.createElement('div');
	section.className = 'section-card';
	const hdr = document.createElement('div');
	hdr.className = 'section-heading';
	setHeading(hdr, 'Model vs. Model', 'real local data');
	section.appendChild(hdr);

	const selRow = document.createElement('div');
	selRow.className = 'field-grid';
	const mkSelect = (label, defaultModel) => {
		const wrap = document.createElement('label');
		wrap.className = 'input-label';
		const labelSpan = document.createElement('span');
		labelSpan.textContent = label;
		wrap.appendChild(labelSpan);
		const s = document.createElement('select');
		s.className = 'form-input';
		for (const m of models) {
			const o = document.createElement('option');
			o.value = m.model;
			o.textContent = `${m.model} (${fmtNum(m.turns)} turns)`;
			if (m.model === defaultModel) o.selected = true;
			s.appendChild(o);
		}
		wrap.appendChild(s);
		return { wrap, select: s };
	};
	const a = mkSelect('Model A', models[0].model);
	const b = mkSelect('Model B', models[1].model);
	selRow.appendChild(a.wrap);
	selRow.appendChild(b.wrap);
	section.appendChild(selRow);
	content.appendChild(section);

	const resultDiv = document.createElement('div');
	content.appendChild(resultDiv);

	async function renderCompare() {
		resultDiv.textContent = '';
		if (a.select.value === b.select.value) {
			const help = document.createElement('div');
			help.className = 'helper-text';
			help.style.marginTop = '10px';
			help.textContent = 'Pick two different models.';
			resultDiv.appendChild(help);
			return;
		}
		const loading = document.createElement('div');
		loading.className = 'loading';
		loading.style.marginTop = '10px';
		loading.textContent = 'Comparing...';
		resultDiv.appendChild(loading);
		const data = await msg('compareModelsReal', { modelA: a.select.value, modelB: b.select.value, period: currentPeriod });
		resultDiv.textContent = '';

		const compare = document.createElement('div');
		compare.className = 'model-compare-card';
		for (const side of [data.a, data.b]) {
			const col = document.createElement('div');
			col.className = 'model-compare-col';
			const h = document.createElement('h4');
			h.textContent = side.model;
			col.appendChild(h);
			const rows = [
				['Turns', fmtNum(side.total.turns)],
				['One-shot', side.metrics.oneShotRate === null ? '—' : fmtPct(side.metrics.oneShotRate)],
				['Retry rate', `${(side.metrics.retryRate * 100).toFixed(1)}%`],
				['Cost / call', fmtMoney(side.metrics.costPerCall, 4)],
				['Output tok / call', Math.round(side.metrics.outputPerCall).toLocaleString()],
				['Cache hit', side.metrics.cacheHitRate === null ? '—' : fmtPct(side.metrics.cacheHitRate)],
				['Total cost', fmtMoney(side.total.costUSD)]
			];
			for (const [k, v] of rows) {
				const r = document.createElement('div');
				r.className = 'm-row';
				const ks = document.createElement('span');
				ks.textContent = k;
				const vs = document.createElement('span');
				vs.className = 'v';
				vs.textContent = v;
				r.append(ks, vs);
				col.appendChild(r);
			}
			compare.appendChild(col);
		}
		resultDiv.appendChild(compare);

		// Per-category diff
		if (data.categoryDiff.length > 0) {
			const catSec = document.createElement('div');
			catSec.className = 'section-card';
			catSec.style.marginTop = '10px';
			const catHdr = document.createElement('div');
			catHdr.className = 'section-heading';
			setHeading(catHdr, 'Per-activity one-shot', 'A vs B');
			catSec.appendChild(catHdr);
			const header = document.createElement('div');
			header.className = 'cat-row header';
			appendSpans(header, ['Activity', ['A turns', 'num'], ['A 1-shot', 'num'], ['B turns', 'num'], ['B 1-shot', 'num']]);
			catSec.appendChild(header);
			for (const d of data.categoryDiff) {
				const row = document.createElement('div');
				row.className = 'cat-row';
				appendSpans(row, [
					[d.label, 'label'],
					[fmtNum(d.a ? d.a.turns : 0), 'num'],
					[d.a && d.a.oneShotRate !== null ? fmtPct(d.a.oneShotRate) : '—', 'num'],
					[fmtNum(d.b ? d.b.turns : 0), 'num'],
					[d.b && d.b.oneShotRate !== null ? fmtPct(d.b.oneShotRate) : '—', 'num']
				]);
				catSec.appendChild(row);
			}
			resultDiv.appendChild(catSec);
		}
	}

	a.select.addEventListener('change', renderCompare);
	b.select.addEventListener('change', renderCompare);
	renderCompare();
}

// ==================== PLAN TAB ====================

async function loadPlan() {
	await primeCurrency();
	const content = document.getElementById('planContent');
	content.textContent = '';

	const loading = document.createElement('div');
	loading.className = 'loading';
	loading.textContent = 'Loading plan...';
	content.appendChild(loading);

	let insights, plans;
	try {
		[insights, plans] = await Promise.all([msg('getPlanInsights'), msg('listPlans')]);
	} catch (e) {
		loading.textContent = 'Error: ' + e.message;
		return;
	}
	content.removeChild(loading);

	const card = document.createElement('div');
	card.className = 'section-card';
	const hdr = document.createElement('div');
	hdr.className = 'section-heading';
	setHeading(hdr, 'Subscription plan', 'pick your paid tier');
	card.appendChild(hdr);

	const sel = document.createElement('select');
	sel.className = 'form-input';
	for (const p of plans) {
		const o = document.createElement('option');
		o.value = p.key;
		o.textContent = `${p.label}${p.monthlyUSD ? ` ($${p.monthlyUSD}/mo)` : ''}`;
		if (p.key === insights.plan.key) o.selected = true;
		sel.appendChild(o);
	}
	card.appendChild(sel);

	sel.addEventListener('change', async () => {
		if (sel.value === 'custom') {
			const monthly = parseFloat(prompt('Monthly USD budget for custom plan:', '100') || '');
			if (!monthly || monthly <= 0) { sel.value = insights.plan.key; return; }
			const provider = prompt('Which provider? (claude / chatgpt / gemini / mistral, blank for all)', '') || null;
			await msg('setPlan', { key: 'custom', monthlyUSD: monthly, provider });
		} else {
			await msg('setPlan', { key: sel.value });
		}
		loadPlan();
	});

	content.appendChild(card);

	// Progress block
	if (insights.monthlyUSD > 0) {
		const progCard = document.createElement('div');
		progCard.className = 'section-card';
		progCard.style.marginTop = '10px';
		const pct = insights.percentageUsed || 0;
		const cls = pct >= 100 ? 'high' : pct >= 50 ? 'mid' : '';

		const progHdr = document.createElement('div');
		progHdr.className = 'section-heading';
		setHeading(progHdr, insights.plan.label, 'month to date');
		progCard.appendChild(progHdr);

		const overview = document.createElement('div');
		overview.className = 'rollup-overview';
		const progCards = [
			{ label: 'API equivalent', value: fmtMoney(insights.apiEquivalentUSD), sub: `vs $${insights.monthlyUSD.toFixed(0)} plan price` },
			{ label: 'Projected EOM', value: fmtMoney(insights.projectedMonthEndUSD), sub: `${fmtNum(insights.daysElapsed)}/${fmtNum(insights.daysInMonth)} days elapsed` }
		];
		for (const c of progCards) {
			const rc = document.createElement('div');
			rc.className = 'rollup-card';
			const lbl = document.createElement('div'); lbl.className = 'label'; lbl.textContent = c.label;
			const val = document.createElement('div'); val.className = 'value'; val.textContent = c.value;
			const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = c.sub;
			rc.append(lbl, val, sub);
			overview.appendChild(rc);
		}
		progCard.appendChild(overview);

		const prog = document.createElement('div');
		prog.className = 'plan-progress';
		const fill = document.createElement('div');
		fill.className = 'plan-progress-fill ' + cls;
		fill.style.width = `${Math.min(200, pct)}%`;
		prog.appendChild(fill);
		progCard.appendChild(prog);

		const verdict = document.createElement('div');
		verdict.className = 'helper-text';
		verdict.textContent = insights.verdict;
		progCard.appendChild(verdict);

		content.appendChild(progCard);
	} else {
		const none = document.createElement('div');
		none.className = 'helper-text';
		none.style.marginTop = '10px';
		none.textContent = insights.verdict;
		content.appendChild(none);
	}
}

// ==================== TOOLS TAB EXTENSIONS ====================
// Extend the existing loadTools with currency picker + export + aliases.
// We hook after the original renders so we can append without conflicting.
const _origLoadTools = loadTools;
loadTools = async function() {
	await _origLoadTools();
	await primeCurrency();
	const content = document.getElementById('toolsContent');

	// Currency picker
	let currencies = [];
	try { currencies = await msg('listCurrencies') || []; } catch {}
	const currentCurrency = await msg('getCurrency') || 'USD';

	const curCard = document.createElement('div');
	curCard.className = 'section-card';
	curCard.innerHTML = `
		<div class="section-heading"><h3>Display currency</h3><span class="helper-text">rates via Frankfurter, cached 24h</span></div>
		<div class="helper-text">Costs throughout the extension display in this currency. USD is the default and requires no network call; other currencies trigger a single rate fetch from Frankfurter.app (European Central Bank data).</div>
		<div class="btn-row" style="align-items:flex-end;">
			<label class="input-label" style="flex:1;"><span>Currency</span>
				<select id="currencySelect" class="form-input"></select>
			</label>
			<button id="resetCurrency" class="btn btn-ghost" style="width:auto; min-width:80px;">Reset</button>
		</div>
		<div id="currencyStatus" class="inline-status"></div>
	`;
	const currencySelect = curCard.querySelector('#currencySelect');
	for (const c of currencies) {
		const opt = document.createElement('option');
		opt.value = c.code;
		opt.textContent = `${c.code} — ${c.name}`;
		if (c.code === currentCurrency) opt.selected = true;
		currencySelect.appendChild(opt);
	}
	content.appendChild(curCard);

	curCard.querySelector('#currencySelect').addEventListener('change', async (e) => {
		try {
			await msg('setCurrency', { code: e.target.value });
			await msg('refreshCurrencyRate');
			curCard.querySelector('#currencyStatus').textContent = `Set to ${e.target.value}.`;
			setTimeout(() => curCard.querySelector('#currencyStatus').textContent = '', 2000);
		} catch (err) {
			curCard.querySelector('#currencyStatus').textContent = 'Error: ' + err.message;
		}
	});
	curCard.querySelector('#resetCurrency').addEventListener('click', async () => {
		await msg('resetCurrency');
		curCard.querySelector('#currencySelect').value = 'USD';
		curCard.querySelector('#currencyStatus').textContent = 'Reset to USD.';
		setTimeout(() => curCard.querySelector('#currencyStatus').textContent = '', 2000);
	});

	// Export card
	const expCard = document.createElement('div');
	expCard.className = 'section-card';
	expCard.innerHTML = `
		<div class="section-heading"><h3>Export</h3><span class="helper-text">CSV or JSON</span></div>
		<div class="helper-text">Download your tracked sessions, daily rollups, and activity breakdown for the last 30 days. The file is generated locally; no data leaves the browser.</div>
		<div class="export-actions">
			<button id="exportJSON" class="btn btn-secondary">JSON</button>
			<button id="exportCSV" class="btn btn-primary">CSV</button>
		</div>
		<div id="exportStatus" class="inline-status"></div>
	`;
	content.appendChild(expCard);

	expCard.querySelector('#exportJSON').addEventListener('click', async () => {
		const data = await msg('buildExport', { format: 'json' });
		downloadFile(`ai-cost-tracker-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data, null, 2), 'application/json');
		expCard.querySelector('#exportStatus').textContent = 'JSON exported.';
	});
	expCard.querySelector('#exportCSV').addEventListener('click', async () => {
		const data = await msg('buildExport', { format: 'csv' });
		for (const [name, text] of Object.entries(data || {})) {
			if (text) downloadFile(`ai-cost-tracker-${name}-${new Date().toISOString().slice(0,10)}.csv`, text, 'text/csv');
		}
		expCard.querySelector('#exportStatus').textContent = 'CSV exported.';
	});

	// Model aliases
	const aliasCard = document.createElement('div');
	aliasCard.className = 'section-card';
	aliasCard.innerHTML = `
		<div class="section-heading"><h3>Model aliases</h3><span class="helper-text">rewrite proxy model names for pricing</span></div>
		<div class="helper-text">If a platform reports a custom or proxy model name (e.g. <code>anthropic--claude-opus-4</code>), map it to a canonical name so cost estimates stay accurate.</div>
		<div id="aliasList"></div>
		<div class="alias-row" style="margin-top:8px;">
			<input type="text" class="form-input" id="aliasFrom" placeholder="e.g. my-proxy-sonnet">
			<input type="text" class="form-input" id="aliasTo" placeholder="e.g. Sonnet">
			<button class="btn btn-primary del" id="aliasAdd" style="color:var(--text)">+</button>
		</div>
	`;
	content.appendChild(aliasCard);

	async function renderAliases() {
		const aliases = await msg('listModelAliases') || {};
		const list = aliasCard.querySelector('#aliasList');
		list.textContent = '';
		const entries = Object.entries(aliases);
		if (entries.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'helper-text';
			empty.textContent = 'No custom aliases yet. Built-in aliases cover common proxy names automatically.';
			list.appendChild(empty);
			return;
		}
		for (const [from, to] of entries) {
			const row = document.createElement('div');
			row.className = 'alias-row';
			const fromEl = document.createElement('div');
			fromEl.textContent = from;
			fromEl.style.color = 'var(--text-dim)';
			const toEl = document.createElement('div');
			toEl.textContent = '→ ' + to;
			toEl.style.color = 'var(--text)';
			const del = document.createElement('button');
			del.className = 'del';
			del.textContent = '×';
			del.addEventListener('click', async () => {
				await msg('removeModelAlias', { alias: from });
				renderAliases();
			});
			row.appendChild(fromEl);
			row.appendChild(toEl);
			row.appendChild(del);
			list.appendChild(row);
		}
	}
	renderAliases();

	aliasCard.querySelector('#aliasAdd').addEventListener('click', async () => {
		const from = aliasCard.querySelector('#aliasFrom').value.trim();
		const to = aliasCard.querySelector('#aliasTo').value.trim();
		if (!from || !to) return;
		await msg('setModelAlias', { alias: from, canonical: to });
		aliasCard.querySelector('#aliasFrom').value = '';
		aliasCard.querySelector('#aliasTo').value = '';
		renderAliases();
	});
};

function downloadFile(name, content, mime) {
	const blob = new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
