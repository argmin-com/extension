/* global Log, CURRENT_PLATFORM, sendBackgroundMessage, BLUE_HIGHLIGHT, RED_WARNING, SUCCESS_GREEN, setupTooltip, isMobileView, sleep, CONFIG, escapeHtml */
'use strict';

class PlatformUsageBadge {
	constructor() {
		this.element = null;
		this.data = null;
		this.velocity = null;
		this.forecasts = [];
		this.settingsOpen = false;

		if (CURRENT_PLATFORM && CURRENT_PLATFORM !== 'claude') {
			this.init();
		}
	}

	async init() {
		await sleep(3000);
		this.buildUI();
		this.attachListeners();
		await this.refresh();
		setInterval(() => this.refresh(), 30000);
	}

	buildUI() {
		const cfg = CONFIG?.PLATFORMS?.[CURRENT_PLATFORM];
		const color = cfg?.color || BLUE_HIGHLIGHT;
		const name = cfg?.name || CURRENT_PLATFORM;

		this.element = document.createElement('div');
		this.element.id = 'ut-platform-badge';
		this.element.className = 'ut-platform-badge';
		this.element.innerHTML = `
			<div class="ut-platform-badge-header" style="border-left: 3px solid ${color}; padding-left: 6px;">
				<span class="ut-platform-badge-title">${name} Usage</span>
				<div style="display:flex; gap:4px;">
					<button class="ut-platform-badge-toggle" title="Settings" style="font-size:13px;">&#9881;</button>
					<button class="ut-platform-badge-toggle ut-badge-minimize" title="Minimize">_</button>
				</div>
			</div>
			<div class="ut-platform-badge-body">
				<div class="ut-badge-section">
					<div class="ut-platform-badge-row">
						<span>Requests</span><span class="ut-badge-requests">0</span>
					</div>
					<div class="ut-platform-badge-row">
						<span>Input tokens</span><span class="ut-badge-input">0</span>
					</div>
					<div class="ut-platform-badge-row">
						<span>Output tokens</span><span class="ut-badge-output">0</span>
					</div>
					<div class="ut-platform-badge-row ut-badge-divider">
						<span>Est. cost</span><span class="ut-badge-cost" style="color: ${color};">$0.00</span>
					</div>
					<div class="ut-platform-badge-row" title="Estimated using AI Energy Score benchmarks (Hugging Face) for Claude and parametric FLOPs scaling for other models. PUE 1.2, overhead factor 2.0. ±30% uncertainty.">
						<span>Energy</span><span class="ut-badge-energy" style="opacity:0.7;">0 Wh</span>
					</div>
					<div class="ut-platform-badge-row" title="Carbon = energy × regional grid intensity. Source: EPA eGRID (US), EEA (EU), IEA (APAC). Your selected region determines the intensity factor. These are directional estimates, not measurements.">
						<span>Carbon</span><span class="ut-badge-carbon" style="opacity:0.7;">0 gCO₂e</span>
					</div>
				</div>
				<div class="ut-badge-section ut-badge-velocity-section" style="display:none;">
					<div class="ut-platform-badge-row ut-badge-section-header"><span>Velocity</span><span></span></div>
					<div class="ut-platform-badge-row"><span>Tokens/hr</span><span class="ut-badge-vel-tokens">0</span></div>
					<div class="ut-platform-badge-row"><span>Requests/hr</span><span class="ut-badge-vel-requests">0</span></div>
					<div class="ut-platform-badge-row"><span>Cost/hr</span><span class="ut-badge-vel-cost" style="color: ${color};">$0.00</span></div>
				</div>
				<div class="ut-badge-section ut-badge-forecast-section" style="display:none;">
					<div class="ut-platform-badge-row ut-badge-section-header"><span>Limit Forecast</span><span></span></div>
					<div class="ut-badge-forecast-items"></div>
				</div>
				<!-- Fix 4: Settings panel with tier selector and custom limits -->
				<div class="ut-badge-section ut-badge-settings-panel" style="display:none;">
					<div class="ut-platform-badge-row ut-badge-section-header"><span>Settings</span><span></span></div>
					<div class="ut-platform-badge-row" style="margin-bottom:6px;">
						<span>Plan</span>
						<select class="ut-badge-tier-select"></select>
					</div>
					<div class="ut-badge-custom-limits">
						<div class="ut-platform-badge-row ut-badge-section-header" style="margin-top:4px;"><span>Custom Limits</span><span></span></div>
						<div class="ut-platform-badge-row" style="margin-bottom:4px;">
							<span>Window (hours)</span>
							<input type="number" class="ut-badge-limit-window" min="1" max="720" value="24" style="width:50px;">
						</div>
						<div class="ut-platform-badge-row" style="margin-bottom:4px;">
							<span>Limit type</span>
							<select class="ut-badge-limit-type">
								<option value="messages">Messages</option>
								<option value="tokens">Tokens</option>
							</select>
						</div>
						<div class="ut-platform-badge-row" style="margin-bottom:6px;">
							<span>Limit value</span>
							<input type="number" class="ut-badge-limit-value" min="1" value="50" style="width:70px;">
						</div>
						<div style="display:flex; gap:6px;">
							<button class="ut-badge-limit-save" style="flex:1; padding:4px 8px; font-size:11px; background:${color}; color:white; border:none; border-radius:4px; cursor:pointer;">Save Custom Limit</button>
							<button class="ut-badge-limit-clear" style="flex:0; padding:4px 8px; font-size:11px; background:transparent; border:1px solid rgba(128,128,128,0.3); color:inherit; border-radius:4px; cursor:pointer;">Clear</button>
						</div>
						<div class="ut-badge-limit-status" style="font-size:10px; margin-top:4px; opacity:0.6;"></div>
					</div>
				</div>
			</div>
		`;
		document.body.appendChild(this.element);
		this.populateTierOptions();

		// Minimize toggle
		this.element.querySelector('.ut-badge-minimize').addEventListener('click', () => {
			const body = this.element.querySelector('.ut-platform-badge-body');
			const btn = this.element.querySelector('.ut-badge-minimize');
			body.style.display = body.style.display === 'none' ? '' : 'none';
			btn.textContent = body.style.display === 'none' ? '+' : '_';
		});

		// Settings toggle
		this.element.querySelectorAll('.ut-platform-badge-toggle')[0].addEventListener('click', () => {
			const panel = this.element.querySelector('.ut-badge-settings-panel');
			this.settingsOpen = !this.settingsOpen;
			panel.style.display = this.settingsOpen ? '' : 'none';
		});

		// Tier change
		this.element.querySelector('.ut-badge-tier-select').addEventListener('change', async (e) => {
			if (e.target.value) {
				await sendBackgroundMessage({ type: 'setSubscriptionTier', platform: CURRENT_PLATFORM, tier: e.target.value });
				await this.refresh();
			}
		});

		// Fix 4: Custom limit save
		this.element.querySelector('.ut-badge-limit-save').addEventListener('click', async () => {
			const windowHours = parseInt(this.element.querySelector('.ut-badge-limit-window').value) || 24;
			const limitType = this.element.querySelector('.ut-badge-limit-type').value;
			const limitValue = parseInt(this.element.querySelector('.ut-badge-limit-value').value) || 50;
			const status = this.element.querySelector('.ut-badge-limit-status');

			const customLimits = {
				custom: {
					windowHours: windowHours,
					type: limitType,
					...(limitType === 'messages' ? { messageLimit: limitValue, tokenLimit: null } : { tokenLimit: limitValue, messageLimit: null })
				}
			};

			await sendBackgroundMessage({ type: 'setUserLimits', platform: CURRENT_PLATFORM, limits: customLimits });
			status.textContent = 'Custom limit saved.';
			status.style.color = SUCCESS_GREEN;
			setTimeout(() => { status.textContent = ''; }, 2000);
			await this.refresh();
		});

		// Fix 4: Clear custom limits
		this.element.querySelector('.ut-badge-limit-clear').addEventListener('click', async () => {
			await sendBackgroundMessage({ type: 'setUserLimits', platform: CURRENT_PLATFORM, limits: null });
			const status = this.element.querySelector('.ut-badge-limit-status');
			status.textContent = 'Custom limit cleared. Using defaults.';
			status.style.color = BLUE_HIGHLIGHT;
			setTimeout(() => { status.textContent = ''; }, 2000);
			await this.refresh();
		});

		// Load existing custom limits into form
		this.loadCustomLimits();
	}

	async loadCustomLimits() {
		const existing = await sendBackgroundMessage({ type: 'getUserLimits', platform: CURRENT_PLATFORM });
		if (existing?.custom) {
			const c = existing.custom;
			this.element.querySelector('.ut-badge-limit-window').value = c.windowHours || 24;
			this.element.querySelector('.ut-badge-limit-type').value = c.type || 'messages';
			this.element.querySelector('.ut-badge-limit-value').value = c.messageLimit || c.tokenLimit || 50;
			this.element.querySelector('.ut-badge-limit-status').textContent = 'Custom limit active.';
		}
	}

	async populateTierOptions() {
		const select = this.element.querySelector('.ut-badge-tier-select');
		const currentTier = await sendBackgroundMessage({ type: 'getSubscriptionTier', platform: CURRENT_PLATFORM });
		const tierNames = {
			chatgpt: { free: 'Free', plus: 'Plus ($20/mo)', pro: 'Pro ($200/mo)', team: 'Team' },
			gemini:  { free: 'Free', advanced: 'Advanced ($20/mo)' },
			mistral: { free: 'Free', pro: 'Pro' }
		};
		const tiers = tierNames[CURRENT_PLATFORM] || {};
		for (const [value, label] of Object.entries(tiers)) {
			const opt = document.createElement('option');
			opt.value = value; opt.textContent = label;
			if (value === currentTier) opt.selected = true;
			select.appendChild(opt);
		}
	}

	attachListeners() {
		browser.runtime.onMessage.addListener((message) => {
			if (message.type === 'platformUsageUpdate' && message.data.platform === CURRENT_PLATFORM) this.refresh();
		});
		window.addEventListener('streamOutputComplete', () => { setTimeout(() => this.refresh(), 500); });
	}

	async refresh() {
		try {
			const [allUsage, velocity, forecasts] = await Promise.all([
				sendBackgroundMessage({ type: 'getPlatformUsageToday' }),
				sendBackgroundMessage({ type: 'getVelocity', platform: CURRENT_PLATFORM }),
				sendBackgroundMessage({ type: 'getForecast', platform: CURRENT_PLATFORM })
			]);
			if (allUsage?.[CURRENT_PLATFORM]) this.data = allUsage[CURRENT_PLATFORM];
			if (velocity) this.velocity = velocity;
			if (forecasts) this.forecasts = forecasts;
			this.render();
		} catch (e) { /* ignore */ }
	}

	render() {
		if (!this.element || !this.data) return;
		const q = (sel) => this.element.querySelector(sel);
		const cfg = CONFIG?.PLATFORMS?.[CURRENT_PLATFORM];
		const color = cfg?.color || BLUE_HIGHLIGHT;

		q('.ut-badge-requests').textContent = (this.data.requests || 0).toLocaleString();
		q('.ut-badge-input').textContent = (this.data.inputTokens || 0).toLocaleString();
		q('.ut-badge-output').textContent = (this.data.outputTokens || 0).toLocaleString();
		q('.ut-badge-cost').textContent = `$${(this.data.estimatedCostUSD || 0).toFixed(4)}`;

		const ewh = this.data.totalEnergyWh || 0;
		q('.ut-badge-energy').textContent = ewh === 0 ? '0 Wh' : ewh < 0.1 ? ewh.toFixed(4) + ' Wh' : ewh.toFixed(2) + ' Wh';
		const gco2 = this.data.totalCarbonGco2e || 0;
		q('.ut-badge-carbon').textContent = gco2 === 0 ? '0 gCO₂e' : gco2 < 0.1 ? gco2.toFixed(4) + ' gCO₂e' : gco2.toFixed(2) + ' gCO₂e';

		const velSection = q('.ut-badge-velocity-section');
		if (this.velocity && this.velocity.tokensPerHour > 0) {
			velSection.style.display = '';
			q('.ut-badge-vel-tokens').textContent = Math.round(this.velocity.tokensPerHour).toLocaleString();
			q('.ut-badge-vel-requests').textContent = this.velocity.requestsPerHour.toFixed(1);
			q('.ut-badge-vel-cost').textContent = `$${this.velocity.costPerHour.toFixed(4)}`;
		} else {
			velSection.style.display = 'none';
		}

		const fcSection = q('.ut-badge-forecast-section');
		const fcItems = q('.ut-badge-forecast-items');
		if (this.forecasts?.length > 0) {
			fcSection.style.display = '';
			fcItems.innerHTML = '';
			for (const fc of this.forecasts) {
				const pctColor = fc.percentage >= 90 ? RED_WARNING : fc.percentage >= 70 ? '#eab308' : color;
				const exhaustStr = fc.exhaustionTimeFormatted || 'Within limits';
				const exhaustColor = fc.exhaustionTime ? RED_WARNING : SUCCESS_GREEN;
				const item = document.createElement('div');
				item.className = 'ut-badge-forecast-item';

				const row1 = document.createElement('div');
				row1.className = 'ut-platform-badge-row';
				const nameSpan = document.createElement('span');
				nameSpan.textContent = `${fc.limitName} (${fc.limitType})`;
				const pctSpan = document.createElement('span');
				pctSpan.style.color = pctColor;
				pctSpan.textContent = `${fc.percentage.toFixed(0)}%`;
				row1.appendChild(nameSpan);
				row1.appendChild(pctSpan);

				const barOuter = document.createElement('div');
				barOuter.className = 'ut-badge-progress-mini';
				const barFill = document.createElement('div');
				barFill.className = 'ut-badge-progress-fill';
				barFill.style.width = `${Math.min(fc.percentage, 100)}%`;
				barFill.style.background = pctColor;
				barOuter.appendChild(barFill);

				const row2 = document.createElement('div');
				row2.className = 'ut-platform-badge-row';
				row2.style.cssText = 'font-size:10px;opacity:0.7;';
				const labelSpan = document.createElement('span');
				labelSpan.textContent = fc.exhaustionTime ? 'Hits limit' : 'Resets in';
				const valSpan = document.createElement('span');
				valSpan.style.color = exhaustColor;
				valSpan.textContent = fc.exhaustionTime ? exhaustStr : (fc.cycleResetFormatted || 'N/A');
				row2.appendChild(labelSpan);
				row2.appendChild(valSpan);

				item.appendChild(row1);
				item.appendChild(barOuter);
				item.appendChild(row2);
				fcItems.appendChild(item);
			}
		} else {
			fcSection.style.display = 'none';
		}
	}
}

const platformBadge = new PlatformUsageBadge();
