// popup.js
function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
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
		const [allUsage, allForecasts, velocityResults, tierResults, currentRegion, regions] = await Promise.all([
			msg('getPlatformUsageToday'),
			msg('getAllForecasts'),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getVelocity', { platform: p })])),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getSubscriptionTier', { platform: p })])),
			msg('getRegion'),
			msg('getRegions')
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

		// Region selector
		const selectedRegion = currentRegion || 'us-average';
		const availableRegions = regions || [];
		html += `<div class="region-bar"><span style="opacity:0.6">Region:</span> <select class="region-sel">`;
		for (const r of availableRegions) {
			html += `<option value="${escapeHtml(r.id)}" ${r.id === selectedRegion ? 'selected' : ''}>${escapeHtml(r.name)} (${escapeHtml(r.intensity)} gCO₂/kWh)</option>`;
		}
		html += `</select></div>`;

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

		const regionSel = content.querySelector('.region-sel');
		if (regionSel) {
			regionSel.addEventListener('change', async () => {
				await msg('setRegion', { region: regionSel.value });
				await loadToday();
			});
		}
	} catch (error) {
		content.textContent = ''; const errDiv = document.createElement('div'); errDiv.className = 'loading'; errDiv.textContent = 'Error: ' + error.message; content.appendChild(errDiv);
	}
}

// ==================== HISTORY TAB ====================

async function loadHistory() {
	const content = document.getElementById('historyContent');
	content.innerHTML = '<div class="loading">Loading history...</div>';

	try {
		const historyData = {};
		for (const pid of Object.keys(PLATFORMS)) {
			historyData[pid] = await msg('getPlatformHistory', { platform: pid, days: 7 });
		}

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

	content.innerHTML = `
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
					<input type="number" class="form-input" id="budgetCost" min="0" step="0.5" value="${budgets.dailyCostLimit || ''}" placeholder="None">
				</label>
				<label class="input-label"><span>Carbon limit (gCO₂e)</span>
					<input type="number" class="form-input" id="budgetCarbon" min="0" step="1" value="${budgets.dailyCarbonLimit || ''}" placeholder="None">
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
		<div class="section-card">
			<div class="section-heading">
				<h3>Methodology</h3>
				<span class="helper-text">Directional estimates</span>
			</div>
			<div class="helper-text">
				Energy estimates use <strong>AI Energy Score</strong> benchmarks (Hugging Face, Dec 2025) for Claude models and parametric FLOPs scaling for others. Carbon = energy × regional grid intensity (EPA eGRID, EEA, IEA). PUE 1.2, overhead 2.0, ±30% uncertainty. These are directional estimates, not measurements. The extension does not know which datacenter served your request.
			</div>
		</div>
	`;

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

		let html = '<div class="compare-grid">';
		html += '<span class="compare-head">Model</span>';
		html += '<span class="compare-head num">Cost</span>';
		html += '<span class="compare-head num">Energy</span>';
		html += '<span class="compare-head num">CO₂</span>';
		for (const r of results) {
			const cost = r.costUSD != null ? '$' + r.costUSD.toFixed(4) : '-';
			const energy = r.energyWh < 0.1 ? r.energyWh.toFixed(4) + ' Wh' : r.energyWh.toFixed(2) + ' Wh';
			const carbon = r.carbonGco2e < 0.1 ? r.carbonGco2e.toFixed(4) + ' g' : r.carbonGco2e.toFixed(2) + ' g';
			html += `<span class="compare-cell">${escapeHtml(r.model)}</span>`;
			html += `<span class="compare-cell num">${cost}</span>`;
			html += `<span class="compare-cell num">${energy}</span>`;
			html += `<span class="compare-cell num">${carbon}</span>`;
		}
		html += '</div>';
		resultDiv.innerHTML = html;
	});
}
