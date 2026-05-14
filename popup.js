// popup.js
function escapeHtml(text) {
	const div = document.createElement('div');
	div.textContent = text;
	return div.innerHTML;
}

function setSafeHtml(element, html) {
	const parsed = new DOMParser().parseFromString(html, 'text/html');
	element.replaceChildren(...Array.from(parsed.body.childNodes));
}

const PLATFORMS = {
	claude:  { name: 'Claude',  color: '#d97706', tiers: { claude_free: 'Free', claude_pro: 'Pro', claude_team: 'Team', claude_enterprise: 'Enterprise', claude_max_5x: 'Max 5x', claude_max_20x: 'Max 20x' } },
	chatgpt: { name: 'ChatGPT', color: '#10a37f', tiers: { free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' } },
	gemini:  { name: 'Gemini',  color: '#4285f4', tiers: { free: 'Free', advanced: 'Advanced' } },
	mistral: { name: 'Mistral', color: '#f97316', tiers: { free: 'Free', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' } },
	perplexity: { name: 'Perplexity', color: '#14b8a6', tiers: { free: 'Free', pro: 'Pro', max: 'Max', enterprise: 'Enterprise' } },
	grok: { name: 'Grok', color: '#111827', tiers: { free: 'Free', x_premium: 'X Premium', x_premium_plus: 'X Premium+', supergrok: 'SuperGrok', supergrok_heavy: 'SuperGrok Heavy', enterprise: 'Enterprise' } }
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
	if (tabName === 'insights') loadInsights();
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

function fmtUSD(amountUSD, decimals = 4) {
	return '$' + (amountUSD || 0).toFixed(decimals);
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
		const [allUsage, allForecasts, velocityResults, tierResults, tierSourceResults] = await Promise.all([
			msg('getPlatformUsageToday'),
			msg('getAllForecasts'),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getVelocity', { platform: p })])),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getSubscriptionTier', { platform: p })])),
			Promise.all(Object.keys(PLATFORMS).map(async p => [p, await msg('getSubscriptionTierSource', { platform: p })]))
		]);

		if (!allUsage) {
			setSafeHtml(content, `<div class="empty-state">
				<div class="empty-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3.6-7.2"/><polyline points="21 4 21 9 16 9"/></svg></div>
				<div class="empty-title">No activity yet</div>
				<div class="empty-detail">Open one of the supported AI apps and tracking will start automatically.</div>
			</div>`);
			return;
		}

		const velMap = Object.fromEntries(velocityResults);
		const tierMap = Object.fromEntries(tierResults);
		const tierSourceMap = Object.fromEntries(tierSourceResults);
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

			const initial = (cfg.name[0] || '?').toUpperCase();
			let cardHtml = `<div class="platform ${active ? '' : 'inactive'}" style="--plat-color:${escapeHtml(cfg.color)};">`;
			cardHtml += `<div class="plat-head"><div class="plat-identity">`;
			cardHtml += `<span class="plat-glyph" aria-hidden="true">${escapeHtml(initial)}</span>`;
			cardHtml += `<span class="plat-name">${escapeHtml(cfg.name)}</span>`;
			cardHtml += `</div>`;
			cardHtml += active
				? `<span class="plat-cost">${fmtUSD(d.estimatedCostUSD)}</span>`
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
					cardHtml += `<span>${vel.requestsPerHour != null ? vel.requestsPerHour.toFixed(1) : '-'} req/hr</span>`;
					cardHtml += `<span>${vel.costPerHour != null ? fmtUSD(vel.costPerHour) : '-'}/hr</span>`;
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

			const tierSource = tierSourceMap[id] || 'unset';
			const sourceLabel = tierSource === 'manual' ? 'manual' : tierSource === 'auto' ? 'auto' : '';
			const sourceTitle = tierSource === 'manual'
				? 'You set this. Auto-detection will not overwrite it.'
				: tierSource === 'auto'
					? 'Auto-detected from the provider. Change to override.'
					: 'Not yet detected; defaulting to free.';
			cardHtml += `<div class="tier-row"><span>Plan:</span><select class="tier-sel" data-platform="${id}">`;
			for (const [tv, tl] of Object.entries(cfg.tiers)) {
				cardHtml += `<option value="${escapeHtml(tv)}" ${tv === tier ? 'selected' : ''}>${escapeHtml(tl)}</option>`;
			}
			cardHtml += `</select>`;
			if (sourceLabel) {
				cardHtml += `<span class="tier-source tier-source-${escapeHtml(sourceLabel)}" title="${escapeHtml(sourceTitle)}">${escapeHtml(sourceLabel)}</span>`;
			}
			cardHtml += `</div></div>`;
			platformCards.push(cardHtml);
		}

		let html = `<div class="overview-card">`;
		html += `<div class="overview-top"><div><div class="overview-label">Today Overview</div><div class="overview-total">${fmtUSD(totalCost)}</div></div>`;
		html += `<div class="overview-subtitle">${activePlatforms} active platform${activePlatforms === 1 ? '' : 's'}</div></div>`;
		html += `<div class="overview-grid">`;
		html += `<div class="overview-metric"><div class="overview-metric-label">Requests</div><div class="overview-metric-value">${fmtNum(totalReqs)}</div></div>`;
		html += `<div class="overview-metric"><div class="overview-metric-label">Platforms</div><div class="overview-metric-value">${activePlatforms}/${Object.keys(PLATFORMS).length}</div></div>`;
		html += `<div class="overview-metric"><div class="overview-metric-label">Energy</div><div class="overview-metric-value">${fmtEnergy(totalEnergy)}</div></div>`;
		html += `<div class="overview-metric"><div class="overview-metric-label">Carbon</div><div class="overview-metric-value">${fmtCarbon(totalCarbon)}</div></div>`;
		html += `</div></div>`;
		html += `<div class="platforms">${platformCards.join('')}</div>`;

		// Totals
		html += `<div class="total"><span>Today (${totalReqs} reqs)</span><span class="total-cost">${fmtUSD(totalCost)}</span></div>`;
		if (totalEnergy > 0 || totalCarbon > 0) {
			html += `<div class="total" style="font-size:11px;color:var(--text-dim);">`;
			html += `<span>${fmtEnergy(totalEnergy)}</span><span>${fmtCarbon(totalCarbon)}</span></div>`;
		}

		setSafeHtml(content, html);

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

// ==================== INSIGHTS TAB ====================

function fmtInsightPct(value) {
	if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'N/A';
	return Number(value).toFixed(0) + '%';
}

function providerName(platform) {
	return PLATFORMS[platform]?.name || platform || 'Unknown';
}

async function loadInsights() {
	const content = document.getElementById('insightsContent');
	setSafeHtml(content, '<div class="loading">Building local insights...</div>');

	let data;
	try {
		data = await msg('usageInsights', { action: 'dashboard' });
	} catch (error) {
		content.textContent = '';
		const loading = document.createElement('div');
		loading.className = 'loading';
		loading.textContent = 'Loading failed';
		content.appendChild(loading);
		renderError(loading, error, () => loadInsights());
		return;
	}

	const digest = data.dailyDigest || {};
	const topProvider = digest.topProvider;
	const topModel = digest.topModel;
	const providerRows = (data.providerMix?.rows || []).filter(row => row.requests > 0 || row.estimatedCostUSD > 0);
	const modelRows = data.modelLeaderboard || [];
	const captureSources = Object.entries(data.captureReliability?.sources || {}).sort((a, b) => b[1] - a[1]);
	const warnings = data.dataQualityWarnings || [];
	const privacy = data.privacySnapshot || {};
	const retention = data.retentionPolicy || { retentionDays: 35, minDays: 1, maxDays: 90 };
	const budget = data.budgetStatus || {};
	const plan = data.planStatus || {};

	let html = `<div class="overview-card">`;
	html += `<div class="overview-top"><div><div class="overview-label">Daily Digest</div><div class="overview-total">${fmtUSD(digest.totalCostUSD || 0)}</div></div>`;
	html += `<div class="overview-subtitle">${fmtNum(digest.totalRequests)} requests · ${fmtNum(digest.totalTokens)} tokens</div></div>`;
	html += `<div class="overview-grid">`;
	html += `<div class="overview-metric"><div class="overview-metric-label">Top provider</div><div class="overview-metric-value">${escapeHtml(providerName(topProvider?.platform))}</div></div>`;
	html += `<div class="overview-metric"><div class="overview-metric-label">Top model</div><div class="overview-metric-value">${escapeHtml(topModel?.model || 'None')}</div></div>`;
	html += `<div class="overview-metric"><div class="overview-metric-label">7d turns</div><div class="overview-metric-value">${fmtNum(digest.sessionTurns7d)}</div></div>`;
	html += `<div class="overview-metric"><div class="overview-metric-label">1-shot</div><div class="overview-metric-value">${fmtInsightPct(digest.oneShotRate7d)}</div></div>`;
	html += `</div></div>`;

	html += `<div class="section-card"><div class="section-heading"><h3>Provider Mix</h3><span class="helper-text">today</span></div>`;
	if (providerRows.length === 0) {
		html += `<div class="helper-text">No provider activity recorded yet today.</div>`;
	} else {
		html += `<div class="insight-list">`;
		for (const row of providerRows) {
			html += `<div class="insight-row"><span class="label">${escapeHtml(providerName(row.platform))} · ${fmtNum(row.requests)} reqs · ${fmtInsightPct(row.costSharePct)} cost share</span><span class="value">${fmtUSD(row.estimatedCostUSD)}</span></div>`;
		}
		html += `</div>`;
	}
	html += `</div>`;

	html += `<div class="section-card"><div class="section-heading"><h3>Model Leaderboard</h3><span class="helper-text">30 day local history</span></div>`;
	if (modelRows.length === 0) {
		html += `<div class="helper-text">No model-level records yet.</div>`;
	} else {
		html += `<div class="insight-list">`;
		for (const row of modelRows.slice(0, 6)) {
			html += `<div class="insight-row"><span class="label">${escapeHtml(row.model)} · ${escapeHtml(providerName(row.platform))} · ${fmtNum(row.requests)} reqs</span><span class="value">${fmtUSD(row.estimatedCostUSD)}</span></div>`;
		}
		html += `</div>`;
	}
	html += `</div>`;

	html += `<div class="section-card"><div class="section-heading"><h3>Capture Reliability</h3><span class="helper-text">${fmtNum(data.captureReliability?.eventCount || 0)} attributed events</span></div>`;
	if (captureSources.length === 0) {
		html += `<div class="helper-text">No capture-source attribution yet. New records will identify webRequest, page-context, stream, Claude API, fallback, or legacy sources.</div>`;
	} else {
		html += `<div class="insight-pill-row">`;
		for (const [source, count] of captureSources) {
			html += `<span class="insight-pill">${escapeHtml(source)} <strong>${fmtNum(count)}</strong></span>`;
		}
		html += `</div>`;
	}
	html += `</div>`;

	html += `<div class="section-card"><div class="section-heading"><h3>Data Quality</h3><span class="helper-text">${fmtNum(warnings.length)} signal${warnings.length === 1 ? '' : 's'}</span></div>`;
	if (warnings.length === 0) {
		html += `<div class="helper-text">No data-quality warnings for the current local dataset.</div>`;
	} else {
		html += `<div class="insight-list">`;
		for (const warning of warnings) {
			html += `<div class="insight-row ${warning.level === 'warn' ? 'warn' : ''}"><span class="label">${escapeHtml(warning.message)}</span><span class="value">${escapeHtml(warning.level)}</span></div>`;
		}
		html += `</div>`;
	}
	html += `</div>`;

	html += `<div class="section-card"><div class="section-heading"><h3>Plan & Budget</h3><span class="helper-text">local forecast</span></div>`;
	html += `<div class="insight-list">`;
	html += `<div class="insight-row"><span class="label">${escapeHtml(plan.label || 'No plan set')} · projected month end</span><span class="value">${fmtUSD(plan.projectedMonthEndUSD || 0)}</span></div>`;
	html += `<div class="insight-row"><span class="label">Daily cost budget</span><span class="value">${budget.dailyCostPct == null ? 'Unset' : fmtInsightPct(budget.dailyCostPct)}</span></div>`;
	html += `<div class="insight-row"><span class="label">Daily carbon budget</span><span class="value">${budget.dailyCarbonPct == null ? 'Unset' : fmtInsightPct(budget.dailyCarbonPct)}</span></div>`;
	html += `</div>`;
	if (plan.verdict) html += `<div class="helper-text" style="margin-top:8px;">${escapeHtml(plan.verdict)}</div>`;
	html += `</div>`;

	html += `<div class="section-card"><div class="section-heading"><h3>Privacy & Retention</h3><span class="helper-text">local controls</span></div>`;
	html += `<div class="insight-list">`;
	html += `<div class="insight-row"><span class="label">Raw prompts/completions stored</span><span class="value">${privacy.rawContentStored ? 'Yes' : 'No'}</span></div>`;
	html += `<div class="insight-row"><span class="label">Telemetry enabled</span><span class="value">${privacy.telemetryEnabled ? 'Yes' : 'No'}</span></div>`;
	html += `<div class="insight-row"><span class="label">Anthropic token-count API opt-in</span><span class="value">${privacy.anthropicApiOptIn ? 'On' : 'Off'}</span></div>`;
	html += `<div class="insight-row"><span class="label">Display currency</span><span class="value">${escapeHtml(privacy.currency || 'USD')}</span></div>`;
	html += `</div>`;
	html += `<div class="btn-row" style="align-items:flex-end;">`;
	html += `<label class="input-label" style="flex:1;"><span>Retain local usage days</span><input type="number" id="retentionDays" class="form-input" min="${retention.minDays}" max="${retention.maxDays}" value="${retention.retentionDays}"></label>`;
	html += `<button id="saveRetention" class="btn btn-secondary" style="width:auto; min-width:84px;">Save</button>`;
	html += `<button id="cleanupRetention" class="btn btn-ghost" style="width:auto; min-width:84px;">Clean</button>`;
	html += `</div><div id="retentionStatus" class="inline-status"></div></div>`;

	setSafeHtml(content, html);

	const status = content.querySelector('#retentionStatus');
	content.querySelector('#saveRetention')?.addEventListener('click', async () => {
		const days = parseInt(content.querySelector('#retentionDays')?.value, 10);
		const next = await msg('usageInsights', { action: 'setRetentionDays', days });
		content.querySelector('#retentionDays').value = String(next.retentionDays);
		status.textContent = `Retention set to ${next.retentionDays} days.`;
	});
	content.querySelector('#cleanupRetention')?.addEventListener('click', async () => {
		const days = parseInt(content.querySelector('#retentionDays')?.value, 10);
		const result = await msg('usageInsights', { action: 'cleanup', days });
		const removed = result.removed || {};
		status.textContent = `Cleaned ${fmtNum(removed.platformDays)} platform days, ${fmtNum(removed.turns)} turns, ${fmtNum(removed.sessions)} sessions.`;
	});
}

// ==================== HISTORY TAB ====================

async function loadHistory() {
	const content = document.getElementById('historyContent');
	setSafeHtml(content, '<div class="loading">Loading history...</div>');

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
			html += `<div class="history-platform-summary">${fmtNum(totalRequests)} reqs · ${fmtUSD(totalCost)}</div></div>`;

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
					html += `<span class="num">${fmtUSD(day.estimatedCostUSD)}</span>`;
					html += `<span class="num">${day.totalCarbonGco2e ? fmtCarbon(day.totalCarbonGco2e) : '-'}</span>`;
					html += `</div>`;
				}
			}
			html += `</div>`;
		}

		if (!anyData) {
			html = '<div class="empty-state"><div>No history data yet.</div><div>Usage data appears here after the tracker sees requests. Local retention is configurable in Insights.</div></div>';
		}

		html += '</div>';
		setSafeHtml(content, html);
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

	setSafeHtml(content, `
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
				<h3>Debug Mode</h3>
				<span class="helper-text">Time-boxed verbose logging</span>
			</div>
			<div class="helper-text">Captures structured logs (alarms, captures, errors) for the chosen duration, then auto-stops. Logs stay on this device and never leave it.</div>
			<div id="debugModeStatus" class="inline-status" style="margin-top:6px;"></div>
			<div class="btn-row" style="flex-wrap:wrap; gap:6px;">
				<button class="btn btn-secondary debug-preset" data-preset="15m" style="min-width:64px;">15 min</button>
				<button class="btn btn-secondary debug-preset" data-preset="1h" style="min-width:64px;">1 hour</button>
				<button class="btn btn-secondary debug-preset" data-preset="4h" style="min-width:64px;">4 hours</button>
				<button class="btn btn-secondary debug-preset" data-preset="24h" style="min-width:64px;">24 hours</button>
				<button id="debugDisable" class="btn" style="min-width:64px;">Off</button>
			</div>
			<div class="tier-row" style="margin-top:8px;">
				<span>Minimum level:</span>
				<select id="debugMinLevel" class="region-sel" style="max-width:120px;">
					<option value="debug">debug (all)</option>
					<option value="warn">warn + error</option>
					<option value="error">error only</option>
				</select>
			</div>
		</div>
		<div class="section-card">
			<div class="section-heading">
				<h3>Error Reports</h3>
				<span class="helper-text">Opt-in. Local. Never auto-uploaded.</span>
			</div>
			<div class="helper-text">When enabled, the extension captures every warn-/error-level log entry in a sanitized buffer (no prompts, no completions, no API keys, no full URLs, no conversation IDs). You can later download the buffer as a JSON file and share it when filing a bug. Disabling clears the buffer.</div>
			<div id="errorReportStatus" class="inline-status" style="margin-top:6px;"></div>
			<div class="btn-row" style="flex-wrap:wrap; gap:6px;">
				<button id="errorReportToggle" class="btn btn-secondary" style="min-width:90px;">Enable</button>
				<button id="errorReportDownload" class="btn" style="min-width:90px;">Download</button>
				<button id="errorReportClear" class="btn" style="min-width:90px;">Clear</button>
			</div>
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
	`);

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

	// Debug mode (time-boxed verbose logging). Single source of truth:
	// debug_mode_until in chrome.storage.local. isDebugEnabled() flips
	// off automatically once Date.now() passes the timestamp -- no
	// rolling timer that needs to survive SW restarts.
	const debugStatus = content.querySelector('#debugModeStatus');
	async function refreshDebugStatus() {
		const state = await msg('getDebugMode');
		if (!state?.active) {
			debugStatus.textContent = 'Off.';
			return;
		}
		const minutes = Math.max(1, Math.round(state.remainingMs / 60000));
		const label = minutes >= 60
			? `~${Math.round(minutes / 60)}h ${minutes % 60}m remaining`
			: `${minutes}m remaining`;
		debugStatus.textContent = `On — ${label}.`;
	}
	await refreshDebugStatus();
	content.querySelectorAll('.debug-preset').forEach(btn => {
		btn.addEventListener('click', async () => {
			const preset = btn.getAttribute('data-preset');
			await msg('setDebugMode', { preset });
			await refreshDebugStatus();
		});
	});
	content.querySelector('#debugDisable').addEventListener('click', async () => {
		await msg('setDebugMode', { preset: null, durationMs: 0 });
		await refreshDebugStatus();
	});

	// Per-level min threshold. Independent of the duration buttons -- when
	// debug mode is on, this gates which entries actually persist.
	const minLevelSel = content.querySelector('#debugMinLevel');
	const currentMinLevel = await msg('getDebugMinLevel');
	if (minLevelSel) {
		minLevelSel.value = currentMinLevel || 'debug';
		minLevelSel.addEventListener('change', async () => {
			await msg('setDebugMinLevel', { level: minLevelSel.value });
		});
	}

	// Opt-in error reports (local-only). Captures sanitized warn/error
	// log entries to a ring buffer; user can download as JSON to share
	// when filing a bug. AGENTS.md rule #1 (no off-device sync) is
	// honored -- there is no automatic upload; the user must click
	// "Download" and then attach the file manually wherever they want.
	const errReportStatus = content.querySelector('#errorReportStatus');
	const errReportToggle = content.querySelector('#errorReportToggle');
	async function refreshErrorReportStatus() {
		const state = await msg('getErrorReport');
		const optIn = !!state?.optIn;
		const count = Number(state?.count || 0);
		errReportStatus.textContent = optIn
			? `Capturing — ${count} ${count === 1 ? 'entry' : 'entries'} buffered.`
			: 'Off.';
		errReportToggle.textContent = optIn ? 'Disable' : 'Enable';
	}
	await refreshErrorReportStatus();
	errReportToggle.addEventListener('click', async () => {
		const current = await msg('getErrorReportOptIn');
		await msg('setErrorReportOptIn', { enabled: !current });
		await refreshErrorReportStatus();
	});
	content.querySelector('#errorReportDownload').addEventListener('click', async () => {
		const report = await msg('getErrorReport');
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		a.download = `argmin-extension-error-report-${stamp}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		// Revoke after a tick to let the download start.
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
	content.querySelector('#errorReportClear').addEventListener('click', async () => {
		await msg('clearErrorReport');
		await refreshErrorReportStatus();
	});

	// Model comparison
	content.querySelector('#runCompare').addEventListener('click', async () => {
		const tokenCount = parseInt(content.querySelector('#compareTokens').value) || 5000;
		// All models from CONFIG.PRICING
		const models = [
			'Haiku', 'Sonnet', 'Opus',
			'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'o3', 'o4-mini',
			'gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro',
			'mistral-small', 'mistral-large', 'mistral-medium',
			'sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research',
			'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4-1-fast-reasoning'
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
		setSafeHtml(resultDiv, html);
	});
}

async function loadMethodology() {
	const content = document.getElementById('methodologyContent');
	setSafeHtml(content, '<div class="loading">Loading methodology...</div>');
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


	setSafeHtml(content, `
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
	`);

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
		setSafeHtml(empty, `<div>No tracked turns for ${escapeHtml(PERIOD_LABELS[currentPeriod])}.</div><div>Chat on any supported platform and sessions will appear here.</div>`);
		content.appendChild(empty);
		return;
	}

	// Overview cards
	const overview = document.createElement('div');
	overview.className = 'rollup-overview';
	setSafeHtml(overview, `
		<div class="rollup-card"><div class="label">Cost</div><div class="value">${fmtMoney(ov.cost)}</div><div class="sub">${Number(ov.turns)} turns · ${Number(ov.sessions)} sessions</div></div>
		<div class="rollup-card"><div class="label">One-shot rate</div><div class="value">${fmtPct(ov.oneShotRate)}</div><div class="sub">${Number(ov.retries)} retries detected</div></div>
		<div class="rollup-card"><div class="label">Cache hit</div><div class="value">${fmtPct(ov.cacheHitRate)}</div><div class="sub">${fmtNum(ov.cacheReadTokens)} cached / ${fmtNum(ov.inputTokens)} input</div></div>
		<div class="rollup-card"><div class="label">Avg cost / session</div><div class="value">${fmtMoney(ov.avgCostPerSession)}</div><div class="sub">${fmtNum(ov.inputTokens + ov.outputTokens)} tokens total</div></div>
	`);
	content.appendChild(overview);

	// Daily chart
	if (rollup.daily.length > 0) {
		const section = document.createElement('div');
		section.className = 'section-card';
		const hdr = document.createElement('div');
		hdr.className = 'section-heading';
		setSafeHtml(hdr, `<h3>Daily Cost</h3><span class="helper-text">${Number(rollup.daily.length)} days</span>`);
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
		setSafeHtml(hdr, `<h3>Activity Breakdown</h3><span class="helper-text">cost + one-shot rate</span>`);
		section.appendChild(hdr);

		const header = document.createElement('div');
		header.className = 'cat-row header';
		setSafeHtml(header, `<span>Activity</span><span class="num">Turns</span><span class="num">Retry</span><span class="num">Cost</span><span class="num">1-shot</span>`);
		section.appendChild(header);

		for (const c of rollup.categories) {
			const row = document.createElement('div');
			row.className = 'cat-row';
			const oneShotPct = c.oneShotRate ?? 0;
			const cls = oneShotClass(c.oneShotRate);
			setSafeHtml(row, `
				<span class="label">${escapeHtml(c.label)}</span>
				<span class="num">${Number(c.turns)}</span>
				<span class="num">${Number(c.retries)}</span>
				<span class="num">${fmtMoney(c.cost)}</span>
				<span class="num">${fmtPct(c.oneShotRate)}
					<div class="oneshot-bar"><div class="oneshot-fill ${escapeHtml(cls)}" style="width:${Math.min(100, oneShotPct)}%"></div></div>
				</span>`);
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
		setSafeHtml(hdr, `<h3>Top Sessions</h3><span class="helper-text">highest cost in period</span>`);
		section.appendChild(hdr);

		const header = document.createElement('div');
		header.className = 'session-row header';
		setSafeHtml(header, `<span>Session</span><span class="num">Turns</span><span class="num">Last</span><span class="num">Cost</span>`);
		section.appendChild(header);

		for (const s of rollup.topSessions) {
			const row = document.createElement('div');
			row.className = 'session-row';
			const platColor = PLATFORMS[s.platform]?.color || '#888';
			const when = new Date(s.lastSeenAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
			const shortId = (s.sessionId || '').slice(-8);
			setSafeHtml(row, `
				<span><span class="platform-dot" style="background:${escapeHtml(platColor)}"></span>${escapeHtml(PLATFORMS[s.platform]?.name || s.platform)} · <span style="color:var(--text-muted);">${escapeHtml(shortId)}</span></span>
				<span class="num">${Number(s.turns)}</span>
				<span class="num" style="font-size:10px;color:var(--text-muted)">${escapeHtml(when)}</span>
				<span class="num" style="font-weight:700">${fmtMoney(s.cost)}</span>`);
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
		setSafeHtml(hdr, `<h3>Models</h3><span class="helper-text">cost by model</span>`);
		section.appendChild(hdr);
		const header = document.createElement('div');
		header.className = 'cat-row header';
		setSafeHtml(header, `<span>Model</span><span class="num">Turns</span><span class="num">In tok</span><span class="num">Out tok</span><span class="num">Cost</span>`);
		section.appendChild(header);
		for (const m of rollup.models) {
			const row = document.createElement('div');
			row.className = 'cat-row';
			setSafeHtml(row, `
				<span class="label">${escapeHtml(m.model)}</span>
				<span class="num">${Number(m.turns)}</span>
				<span class="num">${fmtNum(m.inputTokens)}</span>
				<span class="num">${fmtNum(m.outputTokens)}</span>
				<span class="num">${fmtMoney(m.cost)}</span>`);
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
	setSafeHtml(gradeCard, `
		<div class="grade-letter grade-${escapeHtml(grade.grade)}">${escapeHtml(grade.grade)}</div>
		<div class="grade-info">
			<div class="grade-score">Setup health · ${escapeHtml(grade.score !== null ? grade.score + '/100' : 'N/A')}</div>
			<div class="grade-rationale">${escapeHtml(grade.rationale)}</div>
			${totalSavings > 0 ? `<div class="grade-score" style="margin-top:4px">Potential savings: <strong>${fmtMoney(totalSavings)}</strong></div>` : ''}
		</div>
	`);
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
	setSafeHtml(hdr, `<h3>Findings</h3><span class="helper-text">${Number(result.findings.length)} issue${escapeHtml(result.findings.length === 1 ? '' : 's')}</span>`);
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
			setSafeHtml(card, `
				<div class="title"><span>${escapeHtml(f.title)}</span><span class="badge ${escapeHtml(f.status === 'new' ? 'new' : '')}">${escapeHtml(f.status === 'new' ? 'New' : 'Ongoing')}</span></div>
				<div class="detail">${escapeHtml(f.detail)}</div>
				<div class="fix">${escapeHtml(f.fix)}</div>
				<div class="savings">Estimated savings: <strong>${fmtMoney(f.estSavingsUSD || 0)}</strong> · severity ${escapeHtml(f.severity)} · tag <code>${escapeHtml(f.tag)}</code></div>
			`);
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
		setSafeHtml(empty, '<div>Need at least two models with recorded turns in this period.</div><div>Try switching period or using a different model for a few prompts.</div>');
		content.appendChild(empty);
		return;
	}

	const section = document.createElement('div');
	section.className = 'section-card';
	const hdr = document.createElement('div');
	hdr.className = 'section-heading';
	setSafeHtml(hdr, `<h3>Model vs. Model</h3><span class="helper-text">real local data</span>`);
	section.appendChild(hdr);

	const selRow = document.createElement('div');
	selRow.className = 'field-grid';
	const mkSelect = (label, defaultModel) => {
		const wrap = document.createElement('label');
		wrap.className = 'input-label';
		setSafeHtml(wrap, `<span>${escapeHtml(label)}</span>`);
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
			setSafeHtml(resultDiv, '<div class="helper-text" style="margin-top:10px">Pick two different models.</div>');
			return;
		}
		setSafeHtml(resultDiv, '<div class="loading" style="margin-top:10px">Comparing...</div>');
		const data = await msg('compareModelsReal', { modelA: a.select.value, modelB: b.select.value, period: currentPeriod });
		setSafeHtml(resultDiv, '');

		const compare = document.createElement('div');
		compare.className = 'model-compare-card';
		for (const side of [data.a, data.b]) {
			const col = document.createElement('div');
			col.className = 'model-compare-col';
			setSafeHtml(col, `
				<h4>${escapeHtml(side.model)}</h4>
				<div class="m-row"><span>Turns</span><span class="v">${Number(side.total.turns)}</span></div>
				<div class="m-row"><span>One-shot</span><span class="v">${fmtPct(side.metrics.oneShotRate)}</span></div>
				<div class="m-row"><span>Retry rate</span><span class="v">${(side.metrics.retryRate * 100).toFixed(1)}%</span></div>
				<div class="m-row"><span>Cost / call</span><span class="v">${fmtMoney(side.metrics.costPerCall, 4)}</span></div>
				<div class="m-row"><span>Output tok / call</span><span class="v">${Math.round(side.metrics.outputPerCall).toLocaleString()}</span></div>
				<div class="m-row"><span>Cache hit</span><span class="v">${fmtPct(side.metrics.cacheHitRate)}</span></div>
				<div class="m-row"><span>Total cost</span><span class="v">${fmtMoney(side.total.costUSD)}</span></div>
			`);
			compare.appendChild(col);
		}
		resultDiv.appendChild(compare);

		// Per-category diff
		if (data.categoryDiff.length > 0) {
			const catSec = document.createElement('div');
			catSec.className = 'section-card';
			catSec.style.marginTop = '10px';
			setSafeHtml(catSec, `<div class="section-heading"><h3>Per-activity one-shot</h3><span class="helper-text">A vs B</span></div>`);
			const header = document.createElement('div');
			header.className = 'cat-row header';
			setSafeHtml(header, `<span>Activity</span><span class="num">A turns</span><span class="num">A 1-shot</span><span class="num">B turns</span><span class="num">B 1-shot</span>`);
			catSec.appendChild(header);
			for (const d of data.categoryDiff) {
				const row = document.createElement('div');
				row.className = 'cat-row';
				setSafeHtml(row, `
					<span class="label">${escapeHtml(d.label)}</span>
					<span class="num">${Number(d.a ? d.a.turns : 0)}</span>
					<span class="num">${fmtPct(d.a ? d.a.oneShotRate : null)}</span>
					<span class="num">${Number(d.b ? d.b.turns : 0)}</span>
					<span class="num">${fmtPct(d.b ? d.b.oneShotRate : null)}</span>`);
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
	setSafeHtml(hdr, `<h3>Subscription plan</h3><span class="helper-text">pick your paid tier</span>`);
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
			const provider = prompt('Which provider? (claude / chatgpt / gemini / mistral / perplexity / grok, blank for all)', '') || null;
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
		setSafeHtml(progCard, `
			<div class="section-heading"><h3>${escapeHtml(insights.plan.label)}</h3><span class="helper-text">month to date</span></div>
			<div class="rollup-overview">
				<div class="rollup-card"><div class="label">API equivalent</div><div class="value">${fmtMoney(insights.apiEquivalentUSD)}</div><div class="sub">vs $${insights.monthlyUSD.toFixed(0)} plan price</div></div>
				<div class="rollup-card"><div class="label">Projected EOM</div><div class="value">${fmtMoney(insights.projectedMonthEndUSD)}</div><div class="sub">${Number(insights.daysElapsed)}/${Number(insights.daysInMonth)} days elapsed</div></div>
			</div>
			<div class="plan-progress"><div class="plan-progress-fill ${escapeHtml(cls)}" style="width:${Math.min(200, pct)}%"></div></div>
			<div class="helper-text">${escapeHtml(insights.verdict)}</div>
		`);
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
	setSafeHtml(themeCard, `
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
	`);
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
	setSafeHtml(curCard, `
		<div class="section-heading"><h3>Display currency</h3><span class="helper-text">rates via Frankfurter, cached 24h</span></div>
		<div class="helper-text">Costs throughout the extension display in this currency. USD is the default and requires no network call; other currencies trigger a single rate fetch from Frankfurter.app (European Central Bank data).</div>
		<div class="btn-row" style="align-items:flex-end;">
			<label class="input-label" style="flex:1;"><span>Currency</span>
				<select id="currencySelect" class="form-input"></select>
			</label>
			<button id="resetCurrency" class="btn btn-ghost" style="width:auto; min-width:80px;">Reset</button>
		</div>
		<div id="currencyStatus" class="inline-status"></div>
	`);
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
	setSafeHtml(expCard, `
		<div class="section-heading"><h3>Export</h3><span class="helper-text">CSV or JSON</span></div>
		<div class="helper-text">Download your tracked sessions, daily rollups, and activity breakdown for the last 30 days. The file is generated locally; no data leaves the browser.</div>
		<div class="export-actions">
			<button id="exportJSON" class="btn btn-secondary">JSON</button>
			<button id="exportCSV" class="btn btn-primary">CSV</button>
		</div>
		<div id="exportStatus" class="inline-status"></div>
	`);
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

	// Reports (business-user CSV / JSON exports for finance + IT)
	// Lives inside the Tools tab as a sub-section -- no new top-level tab,
	// so the popup chrome stays clean. UI elements are created with the
	// DOM API rather than template literals so the privacy audit's
	// strict innerHTML check stays green.
	const reportsCard = document.createElement('div');
	reportsCard.className = 'section-card';

	const reportsHeading = document.createElement('div');
	reportsHeading.className = 'section-heading';
	const reportsH3 = document.createElement('h3');
	reportsH3.textContent = 'Reports';
	const reportsHint = document.createElement('span');
	reportsHint.className = 'helper-text';
	reportsHint.textContent = 'finance / IT-friendly exports';
	reportsHeading.appendChild(reportsH3);
	reportsHeading.appendChild(reportsHint);
	reportsCard.appendChild(reportsHeading);

	const reportsHelp = document.createElement('div');
	reportsHelp.className = 'helper-text';
	reportsHelp.textContent = 'Download CSV or JSON snapshots for a chosen date range. Files are generated locally; nothing leaves this device.';
	reportsCard.appendChild(reportsHelp);

	// Date range picker (default: last 30 days)
	const today = new Date();
	const thirty = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000);
	function toInputDate(d) {
		const yyyy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, '0');
		const dd = String(d.getDate()).padStart(2, '0');
		return `${yyyy}-${mm}-${dd}`;
	}

	const dateGrid = document.createElement('div');
	dateGrid.className = 'field-grid';
	dateGrid.style.marginTop = '8px';

	const startLabel = document.createElement('label');
	startLabel.className = 'input-label';
	const startSpan = document.createElement('span');
	startSpan.textContent = 'Start';
	const startInput = document.createElement('input');
	startInput.type = 'date';
	startInput.className = 'form-input';
	startInput.id = 'reportStartDate';
	startInput.value = toInputDate(thirty);
	startLabel.appendChild(startSpan);
	startLabel.appendChild(startInput);

	const endLabel = document.createElement('label');
	endLabel.className = 'input-label';
	const endSpan = document.createElement('span');
	endSpan.textContent = 'End';
	const endInput = document.createElement('input');
	endInput.type = 'date';
	endInput.className = 'form-input';
	endInput.id = 'reportEndDate';
	endInput.value = toInputDate(today);
	endLabel.appendChild(endSpan);
	endLabel.appendChild(endInput);

	dateGrid.appendChild(startLabel);
	dateGrid.appendChild(endLabel);
	reportsCard.appendChild(dateGrid);

	// Platform filter (default: all)
	const platformLabel = document.createElement('label');
	platformLabel.className = 'input-label';
	platformLabel.style.marginTop = '8px';
	platformLabel.style.display = 'block';
	const platformSpan = document.createElement('span');
	platformSpan.textContent = 'Platform';
	const platformSel = document.createElement('select');
	platformSel.className = 'form-input';
	platformSel.id = 'reportPlatform';
	const optAll = document.createElement('option');
	optAll.value = '';
	optAll.textContent = 'All platforms';
	platformSel.appendChild(optAll);
	for (const [pid, info] of Object.entries(PLATFORMS)) {
		const o = document.createElement('option');
		o.value = pid;
		o.textContent = info.name;
		platformSel.appendChild(o);
	}
	platformLabel.appendChild(platformSpan);
	platformLabel.appendChild(platformSel);
	reportsCard.appendChild(platformLabel);

	// Download buttons
	const reportsBtnRow = document.createElement('div');
	reportsBtnRow.className = 'btn-row';
	reportsBtnRow.style.flexWrap = 'wrap';
	reportsBtnRow.style.gap = '6px';
	const btnUsage = document.createElement('button');
	btnUsage.className = 'btn btn-secondary';
	btnUsage.id = 'reportUsageCSV';
	btnUsage.type = 'button';
	btnUsage.textContent = 'Usage CSV';
	const btnFindings = document.createElement('button');
	btnFindings.className = 'btn btn-secondary';
	btnFindings.id = 'reportFindingsCSV';
	btnFindings.type = 'button';
	btnFindings.textContent = 'Findings CSV';
	const btnJSON = document.createElement('button');
	btnJSON.className = 'btn btn-secondary';
	btnJSON.id = 'reportJSON';
	btnJSON.type = 'button';
	btnJSON.textContent = 'Full JSON';
	const btnSummary = document.createElement('button');
	btnSummary.className = 'btn btn-primary';
	btnSummary.id = 'reportSummary';
	btnSummary.type = 'button';
	btnSummary.textContent = 'This-month summary';
	reportsBtnRow.appendChild(btnUsage);
	reportsBtnRow.appendChild(btnFindings);
	reportsBtnRow.appendChild(btnJSON);
	reportsBtnRow.appendChild(btnSummary);
	reportsCard.appendChild(reportsBtnRow);

	const reportsStatus = document.createElement('div');
	reportsStatus.className = 'inline-status';
	reportsStatus.id = 'reportStatus';
	reportsCard.appendChild(reportsStatus);

	// Collapsed-by-default summary preview lives inside a <details> so it
	// stays out of the way until the user clicks the button. Keeps the
	// popup visually light.
	const reportsDetails = document.createElement('details');
	reportsDetails.id = 'reportSummaryDetails';
	reportsDetails.style.marginTop = '10px';
	const reportsSummaryEl = document.createElement('summary');
	reportsSummaryEl.textContent = 'Month-to-date summary';
	reportsSummaryEl.style.cursor = 'pointer';
	reportsSummaryEl.style.fontSize = '11px';
	reportsSummaryEl.style.color = 'var(--text-dim)';
	const reportsBody = document.createElement('div');
	reportsBody.id = 'reportSummaryBody';
	reportsBody.style.marginTop = '8px';
	reportsBody.style.fontSize = '11px';
	reportsBody.style.color = 'var(--text-dim)';
	reportsDetails.appendChild(reportsSummaryEl);
	reportsDetails.appendChild(reportsBody);
	reportsCard.appendChild(reportsDetails);

	content.appendChild(reportsCard);

	function setReportStatus(text) {
		reportsStatus.textContent = text;
		if (text) setTimeout(() => { if (reportsStatus.textContent === text) reportsStatus.textContent = ''; }, 3000);
	}

	function triggerDownload(payload) {
		if (!payload || !payload.content) return;
		downloadFile(payload.filename, payload.content, payload.mime || 'application/octet-stream');
	}

	btnUsage.addEventListener('click', async () => {
		try {
			const payload = await msg('exportUsageCSV', {
				startDate: startInput.value,
				endDate: endInput.value,
				platform: platformSel.value || null
			});
			triggerDownload(payload);
			setReportStatus('Usage CSV downloaded.');
		} catch (err) {
			setReportStatus('Error: ' + (err?.message || 'unknown'));
		}
	});

	btnFindings.addEventListener('click', async () => {
		try {
			const payload = await msg('exportFindingsCSV', { period: '30days' });
			triggerDownload(payload);
			setReportStatus('Findings CSV downloaded.');
		} catch (err) {
			setReportStatus('Error: ' + (err?.message || 'unknown'));
		}
	});

	btnJSON.addEventListener('click', async () => {
		try {
			const payload = await msg('exportAllJSON', { period: '30days' });
			triggerDownload(payload);
			setReportStatus('Full JSON downloaded.');
		} catch (err) {
			setReportStatus('Error: ' + (err?.message || 'unknown'));
		}
	});

	btnSummary.addEventListener('click', async () => {
		try {
			const summary = await msg('buildMonthlySummary');
			renderMonthlySummary(reportsBody, summary);
			reportsDetails.open = true;
			setReportStatus('');
		} catch (err) {
			setReportStatus('Error: ' + (err?.message || 'unknown'));
		}
	});

	// Model aliases
	const aliasCard = document.createElement('div');
	aliasCard.className = 'section-card';
	setSafeHtml(aliasCard, `
		<div class="section-heading"><h3>Model aliases</h3><span class="helper-text">rewrite proxy model names for pricing</span></div>
		<div class="helper-text">If a platform reports a custom or proxy model name (e.g. <code>anthropic--claude-opus-4</code>), map it to a canonical name so cost estimates stay accurate.</div>
		<div id="aliasList"></div>
		<div class="alias-row" style="margin-top:8px;">
			<input type="text" class="form-input" id="aliasFrom" placeholder="e.g. my-proxy-sonnet">
			<input type="text" class="form-input" id="aliasTo" placeholder="e.g. Sonnet">
			<button class="btn btn-primary del" id="aliasAdd" style="color:var(--text)">+</button>
		</div>
	`);
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

// Render the month-to-date summary preview built by buildMonthlySummary.
// Pure DOM construction (no innerHTML) so the privacy audit's strict
// template-literal check stays green.
function renderMonthlySummary(target, summary) {
	target.textContent = '';
	if (!summary) {
		const empty = document.createElement('div');
		empty.textContent = 'No data yet for this month.';
		target.appendChild(empty);
		return;
	}
	const cost = Number(summary.totalCostMTD || 0);
	const totalRow = document.createElement('div');
	const totalStrong = document.createElement('strong');
	totalStrong.textContent = 'Total cost MTD: ';
	totalRow.appendChild(totalStrong);
	totalRow.appendChild(document.createTextNode(fmtMoney(cost)));
	target.appendChild(totalRow);

	const topModelsHeader = document.createElement('div');
	topModelsHeader.style.marginTop = '6px';
	const topModelsLabel = document.createElement('strong');
	topModelsLabel.textContent = 'Top 3 models by spend:';
	topModelsHeader.appendChild(topModelsLabel);
	target.appendChild(topModelsHeader);

	const modelsList = document.createElement('ul');
	modelsList.style.margin = '4px 0 0 0';
	modelsList.style.paddingLeft = '18px';
	const models = Array.isArray(summary.topModels) ? summary.topModels : [];
	if (models.length === 0) {
		const li = document.createElement('li');
		li.textContent = 'No model spend recorded yet.';
		modelsList.appendChild(li);
	} else {
		for (const m of models) {
			const li = document.createElement('li');
			li.textContent = `${m.model} (${fmtMoney(Number(m.cost || 0))})`;
			modelsList.appendChild(li);
		}
	}
	target.appendChild(modelsList);

	const findingsRow = document.createElement('div');
	findingsRow.style.marginTop = '6px';
	const findingsLabel = document.createElement('strong');
	findingsLabel.textContent = 'Findings: ';
	findingsRow.appendChild(findingsLabel);
	findingsRow.appendChild(document.createTextNode(String(Number(summary.findingsCount || 0))));
	target.appendChild(findingsRow);

	if (summary.topFinding && summary.topFinding.title) {
		const topRow = document.createElement('div');
		const topLabel = document.createElement('strong');
		topLabel.textContent = 'Top potential saving: ';
		topRow.appendChild(topLabel);
		topRow.appendChild(document.createTextNode(
			`${summary.topFinding.title} (${fmtMoney(Number(summary.topFinding.estSavingsUSD || 0))})`
		));
		target.appendChild(topRow);
	}
}
