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

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
	tab.addEventListener('click', () => {
		document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
		document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
		tab.classList.add('active');
		document.getElementById(tab.dataset.tab + 'Content').classList.add('active');

		if (tab.dataset.tab === 'history') loadHistory();
		if (tab.dataset.tab === 'tools') loadTools();
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
		const [allUsage, allForecasts, velocityResults, tierResults] = await Promise.all([
			msg('getPlatformUsageToday'),
			msg('getAllForecasts'),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getVelocity', { platform: p })])),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getSubscriptionTier', { platform: p })]))  
		]);

		if (!allUsage) { content.innerHTML = '<div class="loading">No data yet.</div>'; return; }

		const velMap = Object.fromEntries(velocityResults);
		const tierMap = Object.fromEntries(tierResults);
		let totalCost = 0, totalReqs = 0, totalEnergy = 0, totalCarbon = 0;
		let html = '<div class="platforms">';

		for (const [id, cfg] of Object.entries(PLATFORMS)) {
			const d = allUsage[id] || { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0 };
			const vel = velMap[id] || {};
			const forecasts = allForecasts?.[id] || [];
			const tier = tierMap[id] || 'free';
			const active = d.requests > 0;
			totalCost += d.estimatedCostUSD || 0;
			totalReqs += d.requests || 0;
			totalEnergy += d.totalEnergyWh || 0;
			totalCarbon += d.totalCarbonGco2e || 0;

			html += `<div class="platform ${active ? '' : 'inactive'}" style="border-left-color:${cfg.color};">`;
			html += `<div class="plat-head"><span class="plat-name">${escapeHtml(cfg.name)}</span>`;
			html += `<span class="plat-cost" style="color:${cfg.color};">${active ? '$' + (d.estimatedCostUSD || 0).toFixed(4) : 'No activity'}</span></div>`;

			if (active) {
				html += `<div class="stats">`;
				html += `<span>Requests</span><span class="v">${fmtNum(d.requests)}</span>`;
				html += `<span>Input tokens</span><span class="v">${fmtNum(d.inputTokens)}</span>`;
				html += `<span>Output tokens</span><span class="v">${fmtNum(d.outputTokens)}</span>`;
				if (d.totalEnergyWh > 0) {
					html += `<span title="AI Energy Score benchmarks + parametric FLOPs estimation. PUE 1.2, overhead 2.0, ±30% uncertainty.">Energy</span><span class="v">${fmtEnergy(d.totalEnergyWh)}</span>`;
					html += `<span title="Energy × regional grid intensity (EPA eGRID, EEA, IEA). Directional estimate, not measurement.">Carbon</span><span class="v">${fmtCarbon(d.totalCarbonGco2e)}</span>`;
				}
				html += `</div>`;

				if (vel.tokensPerHour > 0) {
					html += `<div class="velocity-row">`;
					html += `<span>${fmtNum(Math.round(vel.tokensPerHour))} tok/hr</span>`;
					html += `<span>${vel.requestsPerHour?.toFixed(1)} req/hr</span>`;
					html += `<span>$${vel.costPerHour?.toFixed(4)}/hr</span>`;
					html += `</div>`;
				}

				if (forecasts.length > 0) {
					html += `<div class="forecast-section"><div class="fc-label">Limit Forecast</div>`;
					for (const fc of forecasts) {
						const c = pctColor(fc.percentage, cfg.color);
						const etaColor = fc.exhaustionTime ? '#ef4444' : '#22c55e';
						html += `<div class="fc-item">`;
						html += `<div class="fc-row"><span>${escapeHtml(fc.limitName)}</span><span class="fc-val" style="color:${c}">${fc.percentage.toFixed(0)}%</span></div>`;
						html += `<div class="fc-bar"><div class="fc-fill" style="width:${Math.min(fc.percentage,100)}%;background:${c}"></div></div>`;
						html += `<div class="fc-eta">`;
						html += fc.exhaustionTime
							? `<span>Hits limit: <span style="color:${etaColor}">${escapeHtml(fc.exhaustionTimeFormatted)}</span></span>`
							: `<span>Within limits</span>`;
						html += `<span>Resets: ${escapeHtml(fc.cycleResetFormatted || 'N/A')}</span></div></div>`;
					}
					html += `</div>`;
				}
			}

			html += `<div class="tier-row"><span>Plan:</span><select class="tier-sel" data-platform="${id}">`;
			for (const [tv, tl] of Object.entries(cfg.tiers)) {
				html += `<option value="${escapeHtml(tv)}" ${tv === tier ? 'selected' : ''}>${escapeHtml(tl)}</option>`;
			}
			html += `</select></div></div>`;
		}
		html += '</div>';

		// Region selector
		const currentRegion = await msg('getRegion') || 'us-average';
		const regions = await msg('getRegions') || [];
		html += `<div class="region-bar"><span style="opacity:0.6">Region:</span> <select class="region-sel">`;
		for (const r of regions) {
			html += `<option value="${escapeHtml(r.id)}" ${r.id === currentRegion ? 'selected' : ''}>${escapeHtml(r.name)} (${r.intensity} gCO₂/kWh)</option>`;
		}
		html += `</select></div>`;

		// Totals
		html += `<div class="total"><span>Today (${totalReqs} reqs)</span><span class="total-cost">$${totalCost.toFixed(4)}</span></div>`;
		if (totalEnergy > 0 || totalCarbon > 0) {
			html += `<div class="total" style="border-top:none;padding-top:0;font-size:11px;color:var(--text-dim);">`;
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
			html += `<div class="history-platform" style="border-left: 3px solid ${cfg.color}; padding-left: 8px; margin: 8px 10px;">`;
			html += `<div class="history-platform-name" style="color:${cfg.color}">${escapeHtml(cfg.name)}</div>`;

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
			html = '<div class="loading">No history data yet. Usage data is retained for 48 hours.</div>';
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
loadToday();

// ==================== TOOLS TAB ====================

async function loadTools() {
	const content = document.getElementById('toolsContent');
	const budgets = await msg('getBudgets') || {};

	content.innerHTML = `
		<div class="platforms" style="padding:10px;">
			<div style="margin-bottom:12px;">
				<div class="fc-label" style="margin-bottom:6px;">TOKEN COUNTER</div>
				<textarea id="tokenizerInput" placeholder="Paste text here to count tokens and estimate cost..." style="width:100%;height:60px;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px;font-size:11px;resize:vertical;font-family:inherit;box-sizing:border-box;"></textarea>
				<div id="tokenizerResult" style="font-size:11px;color:var(--text-dim);margin-top:4px;"></div>
			</div>
			<div style="margin-bottom:12px;">
				<div class="fc-label" style="margin-bottom:6px;">DAILY BUDGETS</div>
				<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
					<label style="font-size:10px;color:var(--text-dim);">Cost limit ($)
						<input type="number" id="budgetCost" min="0" step="0.5" value="${budgets.dailyCostLimit || ''}" placeholder="None" style="width:100%;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:11px;box-sizing:border-box;margin-top:2px;">
					</label>
					<label style="font-size:10px;color:var(--text-dim);">Carbon limit (gCO₂e)
						<input type="number" id="budgetCarbon" min="0" step="1" value="${budgets.dailyCarbonLimit || ''}" placeholder="None" style="width:100%;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:11px;box-sizing:border-box;margin-top:2px;">
					</label>
				</div>
				<button id="saveBudgets" style="margin-top:6px;background:var(--chatgpt);color:white;border:none;border-radius:4px;padding:5px 12px;font-size:11px;cursor:pointer;width:100%;">Save Budgets</button>
				<div id="budgetStatus" style="font-size:10px;color:var(--text-dim);margin-top:4px;"></div>
			</div>
			<div>
				<div class="fc-label" style="margin-bottom:6px;">MODEL COMPARISON</div>
				<div style="font-size:10px;color:var(--text-dim);margin-bottom:6px;">Enter a prompt size (in tokens) to compare cost, energy, and carbon across all models.</div>
				<div style="display:flex;gap:6px;align-items:center;">
					<label style="font-size:10px;color:var(--text-dim);flex:1;">Prompt tokens
						<input type="number" id="compareTokens" min="100" value="5000" style="width:100%;background:var(--bg-card);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:4px 6px;font-size:11px;box-sizing:border-box;margin-top:2px;">
					</label>
					<button id="runCompare" style="background:var(--gemini);color:white;border:none;border-radius:4px;padding:5px 12px;font-size:11px;cursor:pointer;margin-top:14px;">Compare</button>
				</div>
				<div id="compareResult" style="font-size:10px;margin-top:6px;"></div>
			</div>
			<div style="margin-top:12px;padding-top:8px;border-top:1px solid var(--border);">
				<div class="fc-label" style="margin-bottom:4px;">METHODOLOGY</div>
				<div style="font-size:10px;color:var(--text-dim);line-height:1.4;">
					Energy estimates use <strong>AI Energy Score</strong> benchmarks (Hugging Face, Dec 2025) for Claude models and parametric FLOPs scaling for others. Carbon = energy × regional grid intensity (EPA eGRID, EEA, IEA). PUE 1.2, overhead 2.0, ±30% uncertainty. These are directional estimates, not measurements. The extension does not know which datacenter served your request.
				</div>
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
		const costVal = parseFloat(content.querySelector('#budgetCost').value) || null;
		const carbonVal = parseFloat(content.querySelector('#budgetCarbon').value) || null;
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

		let html = '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:2px;font-size:10px;">';
		html += '<span style="font-weight:600;">Model</span><span style="font-weight:600;" class="num">Cost</span><span style="font-weight:600;" class="num">Energy</span><span style="font-weight:600;" class="num">CO₂</span>';
		for (const r of results) {
			const cost = r.costUSD != null ? '$' + r.costUSD.toFixed(4) : '-';
			const energy = r.energyWh < 0.1 ? r.energyWh.toFixed(4) + ' Wh' : r.energyWh.toFixed(2) + ' Wh';
			const carbon = r.carbonGco2e < 0.1 ? r.carbonGco2e.toFixed(4) + ' g' : r.carbonGco2e.toFixed(2) + ' g';
			html += `<span>${escapeHtml(r.model)}</span><span class="num">${cost}</span><span class="num">${energy}</span><span class="num">${carbon}</span>`;
		}
		html += '</div>';
		resultDiv.innerHTML = html;
	});
}
