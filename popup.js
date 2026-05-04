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

// First-run welcome card. The flag lives in chrome.storage.local; we never
// show the card if storage access fails (fail-open).
(async () => {
	const card = document.getElementById('onboarding');
	const dismiss = document.getElementById('onboardingDismiss');
	if (!card || !dismiss) return;
	try {
		const { onboardingDismissed } = await browser.storage.local.get('onboardingDismissed');
		if (!onboardingDismissed) {
			card.hidden = false;
			dismiss.focus();
		}
	} catch (_e) { /* fail-open: don't block popup if storage is unavailable */ }
	dismiss.addEventListener('click', async () => {
		card.hidden = true;
		try { await browser.storage.local.set({ onboardingDismissed: true }); } catch (_e) { /* non-critical */ }
	});
})();

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

// Render a friendly error block in place of a loading indicator. Includes
// role="alert" so screen readers announce the failure, and a Retry button
// that re-runs the original loader.
function renderError(loadingEl, error, retryFn) {
	const parent = loadingEl.parentNode;
	const block = document.createElement('div');
	block.className = 'error-state';
	block.setAttribute('role', 'alert');
	const heading = document.createElement('div');
	heading.className = 'error-heading';
	heading.textContent = 'Something went wrong';
	block.appendChild(heading);
	const detail = document.createElement('div');
	detail.className = 'error-detail';
	detail.textContent = error?.message || String(error || 'Unknown error');
	block.appendChild(detail);
	if (retryFn) {
		const retryBtn = document.createElement('button');
		retryBtn.type = 'button';
		retryBtn.className = 'btn btn-ghost';
		retryBtn.textContent = 'Try again';
		retryBtn.addEventListener('click', () => {
			block.remove();
			retryFn();
		});
		block.appendChild(retryBtn);
	}
	if (parent) parent.replaceChild(block, loadingEl);
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
					<input type="number" class="form-input" id="budgetCost" min="0" step="0.5" value="${escapeHtml(budgets.dailyCostLimit || '')}" placeholder="None">
				</label>
				<label class="input-label"><span>Carbon limit (gCO₂e)</span>
					<input type="number" class="form-input" id="budgetCarbon" min="0" step="1" value="${escapeHtml(budgets.dailyCarbonLimit || '')}" placeholder="None">
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

	const eqEl = content.querySelector('.methodology-equivalencies');
	if (eqEl) {
		if (totalCarbon > 0) {
			eqEl.appendChild(document.createTextNode(`Your AI usage today (${fmtCarbon(totalCarbon)}) is equivalent to:`));
			const ul = document.createElement('ul');
			ul.style.cssText = 'margin:6px 0 0 16px;';
			const items = [
				`Driving ${milesDriven.toFixed(2)} miles in a gasoline car`,
				`Charging a smartphone ${smartphones.toFixed(1)} times`,
				`Running a 10W LED bulb for ${Math.round(ledSeconds)} seconds`,
				`Performing ${Math.round(searches)} Google searches`
			];
			for (const text of items) {
				const li = document.createElement('li');
				li.textContent = text;
				ul.appendChild(li);
			}
			eqEl.appendChild(ul);
		} else {
			eqEl.textContent = 'No carbon data yet today. Use an AI platform to see equivalencies.';
		}
	}

	// Populate the regions table via DOM after the static HTML is set so
	// no untrusted HTML is interpolated into innerHTML.
	const regionsTable = content.querySelector('.methodology-regions-table');
	if (regionsTable) {
		const headers = ['Region', 'gCO₂/kWh', 'Source'];
		for (let i = 0; i < headers.length; i++) {
			const cell = document.createElement('span');
			if (i === 1) cell.className = 'num';
			cell.style.fontWeight = '600';
			cell.textContent = headers[i];
			regionsTable.appendChild(cell);
		}
		for (const r of regions) {
			const nameCell = document.createElement('span');
			nameCell.textContent = r.name;
			regionsTable.appendChild(nameCell);
			const intensityCell = document.createElement('span');
			intensityCell.className = 'num';
			intensityCell.textContent = String(r.intensity);
			regionsTable.appendChild(intensityCell);
			const sourceCell = document.createElement('span');
			sourceCell.textContent = r.source || '';
			regionsTable.appendChild(sourceCell);
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
	catch (e) { renderError(loading, e, () => loadSessions()); return; }

	const ov = rollup.overview;
	content.removeChild(loading);

	if (ov.turns === 0) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.innerHTML = `<div>No tracked turns for ${escapeHtml(PERIOD_LABELS[currentPeriod])}.</div><div>Chat on any supported platform and sessions will appear here.</div>`;
		content.appendChild(empty);
		return;
	}

	// Overview cards
	const overview = document.createElement('div');
	overview.className = 'rollup-overview';
	overview.innerHTML = `
		<div class="rollup-card"><div class="label">Cost</div><div class="value">${fmtMoney(ov.cost)}</div><div class="sub">${Number(ov.turns)} turns · ${Number(ov.sessions)} sessions</div></div>
		<div class="rollup-card"><div class="label">One-shot rate</div><div class="value">${fmtPct(ov.oneShotRate)}</div><div class="sub">${Number(ov.retries)} retries detected</div></div>
		<div class="rollup-card"><div class="label">Cache hit</div><div class="value">${fmtPct(ov.cacheHitRate)}</div><div class="sub">${fmtNum(ov.cacheReadTokens)} cached / ${fmtNum(ov.inputTokens)} input</div></div>
		<div class="rollup-card"><div class="label">Avg cost / session</div><div class="value">${fmtMoney(ov.avgCostPerSession)}</div><div class="sub">${fmtNum(ov.inputTokens + ov.outputTokens)} tokens total</div></div>
	`;
	content.appendChild(overview);

	// Daily chart
	if (rollup.daily.length > 0) {
		const section = document.createElement('div');
		section.className = 'section-card';
		const hdr = document.createElement('div');
		hdr.className = 'section-heading';
		hdr.innerHTML = `<h3>Daily Cost</h3><span class="helper-text">${Number(rollup.daily.length)} days</span>`;
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
		hdr.innerHTML = `<h3>Activity Breakdown</h3><span class="helper-text">cost + one-shot rate</span>`;
		section.appendChild(hdr);

		const header = document.createElement('div');
		header.className = 'cat-row header';
		header.innerHTML = `<span>Activity</span><span class="num">Turns</span><span class="num">Retry</span><span class="num">Cost</span><span class="num">1-shot</span>`;
		section.appendChild(header);

		for (const c of rollup.categories) {
			const row = document.createElement('div');
			row.className = 'cat-row';
			const oneShotPct = c.oneShotRate ?? 0;
			const cls = oneShotClass(c.oneShotRate);
			row.innerHTML = `
				<span class="label">${escapeHtml(c.label)}</span>
				<span class="num">${Number(c.turns)}</span>
				<span class="num">${Number(c.retries)}</span>
				<span class="num">${fmtMoney(c.cost)}</span>
				<span class="num">${fmtPct(c.oneShotRate)}
					<div class="oneshot-bar"><div class="oneshot-fill ${escapeHtml(cls)}" style="width:${Math.min(100, oneShotPct)}%"></div></div>
				</span>`;
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
		hdr.innerHTML = `<h3>Top Sessions</h3><span class="helper-text">highest cost in period</span>`;
		section.appendChild(hdr);

		const header = document.createElement('div');
		header.className = 'session-row header';
		header.innerHTML = `<span>Session</span><span class="num">Turns</span><span class="num">Last</span><span class="num">Cost</span>`;
		section.appendChild(header);

		for (const s of rollup.topSessions) {
			const row = document.createElement('div');
			row.className = 'session-row';
			const platColor = PLATFORMS[s.platform]?.color || '#888';
			const when = new Date(s.lastSeenAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
			const shortId = (s.sessionId || '').slice(-8);
			row.innerHTML = `
				<span><span class="platform-dot" style="background:${escapeHtml(platColor)}"></span>${escapeHtml(PLATFORMS[s.platform]?.name || s.platform)} · <span style="color:var(--text-muted);">${escapeHtml(shortId)}</span></span>
				<span class="num">${Number(s.turns)}</span>
				<span class="num" style="font-size:10px;color:var(--text-muted)">${escapeHtml(when)}</span>
				<span class="num" style="font-weight:700">${fmtMoney(s.cost)}</span>`;
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
		hdr.innerHTML = `<h3>Models</h3><span class="helper-text">cost by model</span>`;
		section.appendChild(hdr);
		const header = document.createElement('div');
		header.className = 'cat-row header';
		header.innerHTML = `<span>Model</span><span class="num">Turns</span><span class="num">In tok</span><span class="num">Out tok</span><span class="num">Cost</span>`;
		section.appendChild(header);
		for (const m of rollup.models) {
			const row = document.createElement('div');
			row.className = 'cat-row';
			row.innerHTML = `
				<span class="label">${escapeHtml(m.model)}</span>
				<span class="num">${Number(m.turns)}</span>
				<span class="num">${fmtNum(m.inputTokens)}</span>
				<span class="num">${fmtNum(m.outputTokens)}</span>
				<span class="num">${fmtMoney(m.cost)}</span>`;
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
	catch (e) { renderError(loading, e, () => loadOptimize()); return; }
	content.removeChild(loading);

	// Health grade
	const grade = result.health;
	const totalSavings = result.findings.reduce((a, f) => a + (f.estSavingsUSD || 0), 0);
	const gradeCard = document.createElement('div');
	gradeCard.className = 'health-grade';
	gradeCard.innerHTML = `
		<div class="grade-letter grade-${escapeHtml(grade.grade)}">${escapeHtml(grade.grade)}</div>
		<div class="grade-info">
			<div class="grade-score">Setup health · ${escapeHtml(grade.score !== null ? grade.score + '/100' : 'N/A')}</div>
			<div class="grade-rationale">${escapeHtml(grade.rationale)}</div>
			${totalSavings > 0 ? `<div class="grade-score" style="margin-top:4px">Potential savings: <strong>${fmtMoney(totalSavings)}</strong></div>` : ''}
		</div>
	`;
	content.appendChild(gradeCard);

	// Waste signal heuristics summary (always show for context)
	const ov = result.rollup.overview;
	const signals = document.createElement('div');
	signals.className = 'waste-signals';
	const convoShare = (result.rollup.categories.find(c => c.category === 'conversation')?.turns || 0) / Math.max(ov.turns, 1);
	const signalData = [
		{
			ok: ov.cacheHitRate === null || ov.cacheHitRate >= 70,
			label: 'Cache hit rate:',
			value: `${ov.cacheHitRate === null ? 'n/a' : fmtPct(ov.cacheHitRate)} — ${ov.cacheHitRate === null || ov.cacheHitRate >= 70 ? 'healthy' : 'system prompt or context may be changing between turns'}`
		},
		{
			ok: ov.oneShotRate === null || ov.oneShotRate >= 70,
			label: 'One-shot rate:',
			value: `${fmtPct(ov.oneShotRate)} — ${ov.oneShotRate === null || ov.oneShotRate >= 70 ? 'first-try success is strong' : 'model is retrying/rephrasing often'}`
		},
		{
			ok: ov.turns === 0 || convoShare < 0.35,
			label: 'Conversation share:',
			value: `agent is ${convoShare < 0.35 ? 'mostly acting' : 'chatting more than doing'}`
		}
	];
	for (const s of signalData) {
		const row = document.createElement('div');
		row.className = 'waste-signal ' + (s.ok ? 'ok' : 'warn');
		const dot = document.createElement('div');
		dot.className = 'dot';
		row.appendChild(dot);
		const text = document.createElement('div');
		text.className = 'text';
		const strong = document.createElement('strong');
		strong.textContent = s.label;
		text.appendChild(strong);
		text.appendChild(document.createTextNode(' ' + s.value));
		row.appendChild(text);
		signals.appendChild(row);
	}
	content.appendChild(signals);

	// Findings
	const section = document.createElement('div');
	section.className = 'section-card';
	section.style.marginTop = '12px';
	const hdr = document.createElement('div');
	hdr.className = 'section-heading';
	hdr.innerHTML = `<h3>Findings</h3><span class="helper-text">${Number(result.findings.length)} issue${escapeHtml(result.findings.length === 1 ? '' : 's')}</span>`;
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
			card.innerHTML = `
				<div class="title"><span>${escapeHtml(f.title)}</span><span class="badge ${escapeHtml(f.status === 'new' ? 'new' : '')}">${escapeHtml(f.status === 'new' ? 'New' : 'Ongoing')}</span></div>
				<div class="detail">${escapeHtml(f.detail)}</div>
				<div class="fix">${escapeHtml(f.fix)}</div>
				<div class="savings">Estimated savings: <strong>${fmtMoney(f.estSavingsUSD || 0)}</strong> · severity ${escapeHtml(f.severity)} · tag <code>${escapeHtml(f.tag)}</code></div>
			`;
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
	catch (e) { renderError(loading, e, () => loadCompare()); return; }

	content.removeChild(loading);

	if (!models || models.length < 2) {
		const empty = document.createElement('div');
		empty.className = 'empty-state';
		empty.innerHTML = '<div>Need at least two models with recorded turns in this period.</div><div>Try switching period or using a different model for a few prompts.</div>';
		content.appendChild(empty);
		return;
	}

	const section = document.createElement('div');
	section.className = 'section-card';
	const hdr = document.createElement('div');
	hdr.className = 'section-heading';
	hdr.innerHTML = `<h3>Model vs. Model</h3><span class="helper-text">real local data</span>`;
	section.appendChild(hdr);

	const selRow = document.createElement('div');
	selRow.className = 'field-grid';
	const mkSelect = (label, defaultModel) => {
		const wrap = document.createElement('label');
		wrap.className = 'input-label';
		wrap.innerHTML = `<span>${escapeHtml(label)}</span>`;
		const s = document.createElement('select');
		s.className = 'form-input';
		for (const m of models) {
			const o = document.createElement('option');
			o.value = m.model;
			o.textContent = `${m.model} (${m.turns} turns)`;
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
		if (a.select.value === b.select.value) {
			resultDiv.innerHTML = '<div class="helper-text" style="margin-top:10px">Pick two different models.</div>';
			return;
		}
		resultDiv.innerHTML = '<div class="loading" style="margin-top:10px">Comparing...</div>';
		const data = await msg('compareModelsReal', { modelA: a.select.value, modelB: b.select.value, period: currentPeriod });
		resultDiv.innerHTML = '';

		const compare = document.createElement('div');
		compare.className = 'model-compare-card';
		for (const side of [data.a, data.b]) {
			const col = document.createElement('div');
			col.className = 'model-compare-col';
			col.innerHTML = `
				<h4>${escapeHtml(side.model)}</h4>
				<div class="m-row"><span>Turns</span><span class="v">${Number(side.total.turns)}</span></div>
				<div class="m-row"><span>One-shot</span><span class="v">${fmtPct(side.metrics.oneShotRate)}</span></div>
				<div class="m-row"><span>Retry rate</span><span class="v">${(side.metrics.retryRate * 100).toFixed(1)}%</span></div>
				<div class="m-row"><span>Cost / call</span><span class="v">${fmtMoney(side.metrics.costPerCall, 4)}</span></div>
				<div class="m-row"><span>Output tok / call</span><span class="v">${Math.round(side.metrics.outputPerCall).toLocaleString()}</span></div>
				<div class="m-row"><span>Cache hit</span><span class="v">${fmtPct(side.metrics.cacheHitRate)}</span></div>
				<div class="m-row"><span>Total cost</span><span class="v">${fmtMoney(side.total.costUSD)}</span></div>
			`;
			compare.appendChild(col);
		}
		resultDiv.appendChild(compare);

		// Per-category diff
		if (data.categoryDiff.length > 0) {
			const catSec = document.createElement('div');
			catSec.className = 'section-card';
			catSec.style.marginTop = '10px';
			catSec.innerHTML = `<div class="section-heading"><h3>Per-activity one-shot</h3><span class="helper-text">A vs B</span></div>`;
			const header = document.createElement('div');
			header.className = 'cat-row header';
			header.innerHTML = `<span>Activity</span><span class="num">A turns</span><span class="num">A 1-shot</span><span class="num">B turns</span><span class="num">B 1-shot</span>`;
			catSec.appendChild(header);
			for (const d of data.categoryDiff) {
				const row = document.createElement('div');
				row.className = 'cat-row';
				row.innerHTML = `
					<span class="label">${escapeHtml(d.label)}</span>
					<span class="num">${Number(d.a ? d.a.turns : 0)}</span>
					<span class="num">${fmtPct(d.a ? d.a.oneShotRate : null)}</span>
					<span class="num">${Number(d.b ? d.b.turns : 0)}</span>
					<span class="num">${fmtPct(d.b ? d.b.oneShotRate : null)}</span>`;
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
		renderError(loading, e, () => loadPlan());
		return;
	}
	content.removeChild(loading);

	const card = document.createElement('div');
	card.className = 'section-card';
	const hdr = document.createElement('div');
	hdr.className = 'section-heading';
	hdr.innerHTML = `<h3>Subscription plan</h3><span class="helper-text">pick your paid tier</span>`;
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
		progCard.innerHTML = `
			<div class="section-heading"><h3>${escapeHtml(insights.plan.label)}</h3><span class="helper-text">month to date</span></div>
			<div class="rollup-overview">
				<div class="rollup-card"><div class="label">API equivalent</div><div class="value">${fmtMoney(insights.apiEquivalentUSD)}</div><div class="sub">vs $${insights.monthlyUSD.toFixed(0)} plan price</div></div>
				<div class="rollup-card"><div class="label">Projected EOM</div><div class="value">${fmtMoney(insights.projectedMonthEndUSD)}</div><div class="sub">${Number(insights.daysElapsed)}/${Number(insights.daysInMonth)} days elapsed</div></div>
			</div>
			<div class="plan-progress"><div class="plan-progress-fill ${escapeHtml(cls)}" style="width:${Math.min(200, pct)}%"></div></div>
			<div class="helper-text">${escapeHtml(insights.verdict)}</div>
		`;
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

	// Theme picker (Auto / Light / Dark). Stored in popup-origin localStorage
	// so theme-init.js can read it synchronously before paint.
	const themeCard = document.createElement('div');
	themeCard.className = 'section-card';
	themeCard.innerHTML = `
		<div class="section-heading"><h3>Appearance</h3><span class="helper-text">popup theme</span></div>
		<div class="helper-text">Auto follows your OS color scheme. The selected platform pages keep their own theme; this only affects the extension popup.</div>
		<div class="btn-row" style="align-items:flex-end;">
			<label class="input-label" style="flex:1;"><span>Theme</span>
				<select id="themeSelect" class="form-input">
					<option value="auto">Auto (follow OS)</option>
					<option value="dark">Dark</option>
					<option value="light">Light</option>
				</select>
			</label>
		</div>
	`;
	const themeSel = themeCard.querySelector('#themeSelect');
	const currentTheme = (() => { try { return localStorage.getItem('themePref') || 'auto'; } catch (_e) { return 'auto'; } })();
	themeSel.value = currentTheme;
	themeSel.addEventListener('change', () => {
		const v = themeSel.value;
		try { localStorage.setItem('themePref', v); } catch (_e) { /* fail open */ }
		const sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
		const applied = v === 'auto' ? (sysLight ? 'light' : 'dark') : v;
		document.documentElement.setAttribute('data-theme', applied);
	});
	content.appendChild(themeCard);

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
	const currencySel = curCard.querySelector('#currencySelect');
	for (const c of currencies) {
		const opt = document.createElement('option');
		opt.value = c.code;
		opt.textContent = `${c.code} — ${c.name}`;
		if (c.code === currentCurrency) opt.selected = true;
		currencySel.appendChild(opt);
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
