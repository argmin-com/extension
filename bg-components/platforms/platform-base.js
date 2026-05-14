// bg-components/platforms/platform-base.js
import { RawLog, StoredMap, getStorageValue, setStorageValue, CONFIG } from '../utils.js';

async function Log(...args) { await RawLog("platform-base", ...args); }

const TOKEN_CALIBRATION = {
	claude:  { input: 1.05, output: 1.05 },
	chatgpt: { input: 1.0,  output: 1.0  },
	gemini:  { input: 1.12, output: 1.12 },
	mistral: { input: 1.08, output: 1.08 },
	perplexity: { input: 1.0, output: 1.0 },
	grok: { input: 1.0, output: 1.0 }
};

const RETENTION_STORAGE_KEY = 'usageInsights:retentionDays';
const DEFAULT_USAGE_RETENTION_DAYS = 35;
const MIN_USAGE_RETENTION_DAYS = 1;
const MAX_USAGE_RETENTION_DAYS = 90;

const PLATFORM_LIMITS = {
	claude: {
		claude_free:    { session: { windowHours: 5, tokenLimit: 375000, type: 'tokens' } },
		claude_team:    { session: { windowHours: 5, tokenLimit: 1500000, type: 'tokens' }, weekly: { windowHours: 168, tokenLimit: 15000000, type: 'tokens' } },
		// Enterprise is a custom contract -- limits vary by deal. The
		// values here are the published baseline; admins can override per
		// seat through the popup user-limits surface.
		claude_enterprise: { session: { windowHours: 5, tokenLimit: 3000000, type: 'tokens' }, weekly: { windowHours: 168, tokenLimit: 30000000, type: 'tokens' } },
		claude_pro:     { session: { windowHours: 5, tokenLimit: 1500000, type: 'tokens' }, weekly: { windowHours: 168, tokenLimit: 15000000, type: 'tokens' } },
		claude_max_5x:  { session: { windowHours: 5, tokenLimit: 7500000, type: 'tokens' }, weekly: { windowHours: 168, tokenLimit: 75000000, type: 'tokens' } },
		claude_max_20x: { session: { windowHours: 5, tokenLimit: 30000000, type: 'tokens' }, weekly: { windowHours: 168, tokenLimit: 300000000, type: 'tokens' } }
	},
	chatgpt: {
		free: { daily: { windowHours: 24, messageLimit: 50, tokenLimit: null, type: 'messages' } },
		plus: { rolling_3h: { windowHours: 3, messageLimit: 80, tokenLimit: null, type: 'messages' } },
		pro:  { daily: { windowHours: 24, messageLimit: 999999, tokenLimit: null, type: 'messages' } },
		team: { rolling_3h: { windowHours: 3, messageLimit: 100, tokenLimit: null, type: 'messages' } },
		// Enterprise is a custom contract; OpenAI does not publish a
		// hard message cap. Treat as effectively unmetered for forecasting
		// purposes -- admins can still set a per-seat budget in the popup.
		enterprise: { daily: { windowHours: 24, messageLimit: 999999, tokenLimit: null, type: 'messages' } }
	},
	gemini: {
		free:     { daily: { windowHours: 24, messageLimit: 50, tokenLimit: null, type: 'messages' } },
		advanced: { daily: { windowHours: 24, messageLimit: 1500, tokenLimit: null, type: 'messages' } }
	},
	mistral: {
		free: { daily: { windowHours: 24, messageLimit: 50, tokenLimit: null, type: 'messages' } },
		pro:  { daily: { windowHours: 24, messageLimit: 500, tokenLimit: null, type: 'messages' } },
		team: { daily: { windowHours: 24, messageLimit: 800, tokenLimit: null, type: 'messages' } },
		enterprise: { daily: { windowHours: 24, messageLimit: 999999, tokenLimit: null, type: 'messages' } }
	},
	perplexity: {
		free: { daily: { windowHours: 24, messageLimit: 40, tokenLimit: null, type: 'messages' } },
		pro:  { daily: { windowHours: 24, messageLimit: 600, tokenLimit: null, type: 'messages' } },
		max:  { daily: { windowHours: 24, messageLimit: 2000, tokenLimit: null, type: 'messages' } },
		enterprise: { daily: { windowHours: 24, messageLimit: 999999, tokenLimit: null, type: 'messages' } }
	},
	grok: {
		free: { rolling_2h: { windowHours: 2, messageLimit: 10, tokenLimit: null, type: 'messages' } },
		x_premium: { rolling_2h: { windowHours: 2, messageLimit: 50, tokenLimit: null, type: 'messages' } },
		x_premium_plus: { rolling_2h: { windowHours: 2, messageLimit: 100, tokenLimit: null, type: 'messages' } },
		supergrok: { rolling_2h: { windowHours: 2, messageLimit: 100, tokenLimit: null, type: 'messages' } },
		supergrok_heavy: { rolling_2h: { windowHours: 2, messageLimit: 500, tokenLimit: null, type: 'messages' } },
		enterprise: { daily: { windowHours: 24, messageLimit: 999999, tokenLimit: null, type: 'messages' } }
	}
};

class PlatformUsageStore {
	constructor() {
		this.store = new StoredMap("platformUsage");
		this.velocityStore = new StoredMap("platformVelocity");
		this.rateLimitStore = new StoredMap("platformRateLimits");
	}

	_emptyDayRecord(now = Date.now()) {
		return {
			requests: 0, inputTokens: 0, outputTokens: 0,
			models: {}, estimatedCostUSD: 0,
			totalEnergyWh: 0, totalCarbonGco2e: 0,
			firstRequestAt: now, lastRequestAt: now,
			captureSources: {}
		};
	}

	_ensureDayRecord(existing, now = Date.now()) {
		existing.requests = existing.requests || 0;
		existing.inputTokens = existing.inputTokens || 0;
		existing.outputTokens = existing.outputTokens || 0;
		existing.estimatedCostUSD = existing.estimatedCostUSD || 0;
		existing.models ||= {};
		existing.lastRequestAt = now;
		if (!existing.firstRequestAt) existing.firstRequestAt = now;
		if (!existing.totalEnergyWh) existing.totalEnergyWh = 0;
		if (!existing.totalCarbonGco2e) existing.totalCarbonGco2e = 0;
		existing.captureSources ||= {};
		return existing;
	}

	_normalizeCaptureSource(source) {
		const s = String(source || '').toLowerCase();
		if (s.includes('fallback')) return 'fallback';
		if (s.includes('page')) return 'pageContext';
		if (s.includes('webrequest') || s.includes('web_request')) return 'webRequest';
		if (s.includes('stream') || s.includes('output')) return 'outputStream';
		if (s.includes('claude') && s.includes('api')) return 'claudeApi';
		if (s.includes('manual')) return 'manual';
		return 'unknown';
	}

	_noteCaptureSource(dayRecord, source, count = 1) {
		if (!source) return;
		dayRecord.captureSources ||= {};
		const key = this._normalizeCaptureSource(source);
		dayRecord.captureSources[key] = (dayRecord.captureSources[key] || 0) + count;
	}

	_normalizeRetentionDays(days) {
		const n = Number(days);
		if (!Number.isFinite(n)) return DEFAULT_USAGE_RETENTION_DAYS;
		return Math.min(MAX_USAGE_RETENTION_DAYS, Math.max(MIN_USAGE_RETENTION_DAYS, Math.round(n)));
	}

	async _retentionMs() {
		const days = this._normalizeRetentionDays(await getStorageValue(RETENTION_STORAGE_KEY, DEFAULT_USAGE_RETENTION_DAYS));
		return days * 24 * 60 * 60 * 1000;
	}

	calibrateTokens(platform, rawCount, direction = 'input') {
		const f = TOKEN_CALIBRATION[platform] || { input: 1.0, output: 1.0 };
		return Math.round(rawCount * f[direction]);
	}

	_findPricingKey(pricing, model) {
		if (!model) return null;
		const lower = model.toLowerCase();
		if (pricing[model]) return model;
		if (pricing[lower]) return lower;
		for (const key of Object.keys(pricing)) {
			if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return key;
		}
		return null;
	}

	_addCost(existing, platform, model, inputTokens, outputTokens) {
		const pricing = CONFIG.PRICING[platform];
		if (!pricing) return;
		const mk = this._findPricingKey(pricing, model);
		const mp = pricing[mk] || Object.values(pricing)[0];
		if (mp) {
			existing.estimatedCostUSD += (inputTokens / 1e6) * mp.input + (outputTokens / 1e6) * mp.output + (mp.request || 0);
		}
	}

	async recordRequest(platform, model, inputTokens, outputTokens, metadata = {}) {
		const now = Date.now();
		const key = `${platform}:${new Date().toISOString().slice(0, 10)}`;
		const existing = this._ensureDayRecord(await this.store.get(key) || this._emptyDayRecord(now), now);
		existing.requests = (existing.requests || 0) + 1;
		existing.inputTokens = (existing.inputTokens || 0) + inputTokens;
		existing.outputTokens = (existing.outputTokens || 0) + outputTokens;
		this._noteCaptureSource(existing, metadata.source);

		if (!existing.models[model]) existing.models[model] = { requests: 0, inputTokens: 0, outputTokens: 0 };
		existing.models[model].requests = (existing.models[model].requests || 0) + 1;
		existing.models[model].inputTokens = (existing.models[model].inputTokens || 0) + inputTokens;
		existing.models[model].outputTokens = (existing.models[model].outputTokens || 0) + outputTokens;

		this._addCost(existing, platform, model, inputTokens, outputTokens);
		await this.store.set(key, existing, await this._retentionMs());
		await this._updateVelocity(platform, existing);
		return existing;
	}

	async addImpact(platform, energyWh, carbonGco2e) {
		const key = `${platform}:${new Date().toISOString().slice(0, 10)}`;
		const existing = await this.store.get(key);
		if (!existing) return null;
		if (!existing.totalEnergyWh) existing.totalEnergyWh = 0;
		if (!existing.totalCarbonGco2e) existing.totalCarbonGco2e = 0;
		existing.totalEnergyWh += energyWh;
		existing.totalCarbonGco2e += carbonGco2e;
		await this.store.set(key, existing, await this._retentionMs());
		return existing;
	}

	async recordOutputTokens(platform, model, outputTokens, metadata = {}) {
		const now = Date.now();
		const calibrated = this.calibrateTokens(platform, outputTokens, 'output');
		const key = `${platform}:${new Date().toISOString().slice(0, 10)}`;
		const existing = this._ensureDayRecord(await this.store.get(key) || this._emptyDayRecord(now), now);

		existing.outputTokens = (existing.outputTokens || 0) + calibrated;
		this._noteCaptureSource(existing, metadata.source || 'outputStream');
		if (!existing.models[model]) existing.models[model] = { requests: 0, inputTokens: 0, outputTokens: 0 };
		existing.models[model].outputTokens = (existing.models[model].outputTokens || 0) + calibrated;

		// Add output cost only (input already recorded)
		const pricing = CONFIG.PRICING[platform];
		if (pricing) {
			const mk = this._findPricingKey(pricing, model);
			const mp = pricing[mk] || Object.values(pricing)[0];
			if (mp) existing.estimatedCostUSD += (calibrated / 1e6) * mp.output;
		}

		await this.store.set(key, existing, await this._retentionMs());
		await this._updateVelocity(platform, existing);
		return existing;
	}

	async recordRateLimit(platform, resetTime) {
		const key = `ratelimit:${platform}`;
		const existing = await this.rateLimitStore.get(key) || { hits: [], lastResetTime: null };
		existing.hits.push(Date.now());
		if (existing.hits.length > 20) existing.hits = existing.hits.slice(-20);
		if (resetTime) existing.lastResetTime = resetTime;
		await this.rateLimitStore.set(key, existing, 24 * 60 * 60 * 1000);
	}

	async _updateVelocity(platform, dayData) {
		const now = Date.now();
		const elapsed = now - (dayData.firstRequestAt || now);
		const hours = Math.max(elapsed / 3600000, 0.0167);
		const velocity = {
			tokensPerHour: (dayData.inputTokens + dayData.outputTokens) / hours,
			requestsPerHour: dayData.requests / hours,
			inputTokensPerHour: dayData.inputTokens / hours,
			outputTokensPerHour: dayData.outputTokens / hours,
			costPerHour: dayData.estimatedCostUSD / hours,
			samplePeriodMs: elapsed,
			updatedAt: now
		};
		await this.velocityStore.set(`velocity:${platform}`, velocity, 24 * 60 * 60 * 1000);
		return velocity;
	}

	async getToday(platform) {
		const key = `${platform}:${new Date().toISOString().slice(0, 10)}`;
		return await this.store.get(key) || {
			requests: 0, inputTokens: 0, outputTokens: 0,
			models: {}, estimatedCostUSD: 0,
			totalEnergyWh: 0, totalCarbonGco2e: 0,
			firstRequestAt: null, lastRequestAt: null,
			captureSources: {}
		};
	}

	async getVelocity(platform) {
		return await this.velocityStore.get(`velocity:${platform}`) || {
			tokensPerHour: 0, requestsPerHour: 0, inputTokensPerHour: 0,
			outputTokensPerHour: 0, costPerHour: 0, samplePeriodMs: 0, updatedAt: 0
		};
	}

	async getHistory(platform, days = 7) {
		const results = [];
		for (let i = 0; i < days; i++) {
			const d = new Date(); d.setDate(d.getDate() - i);
			const data = await this.store.get(`${platform}:${d.toISOString().slice(0, 10)}`);
			if (data) results.push({ date: d.toISOString().slice(0, 10), ...data });
		}
		return results;
	}

	async getAllPlatformsToday() {
		const result = {};
		for (const pid of Object.keys(CONFIG.PLATFORMS)) result[pid] = await this.getToday(pid);
		return result;
	}

	async getSubscriptionTier(platform) {
		return await getStorageValue(`tier:${platform}`, platform === 'claude' ? 'claude_free' : 'free');
	}
	// Returns 'manual' when the user explicitly picked this tier in the
	// popup, 'auto' when auto-detection wrote it, or 'unset' if no value
	// has been written yet.
	async getSubscriptionTierSource(platform) {
		return await getStorageValue(`tierSource:${platform}`, 'unset');
	}
	// source: 'auto' (default) -- written by detection paths. Refuses to
	//                            overwrite a value the user set manually.
	// source: 'manual'         -- written when the user picks a tier in the
	//                            popup. Always wins.
	async setSubscriptionTier(platform, tier, source = 'auto') {
		if (!tier) return false;
		if (source !== 'manual' && source !== 'auto') source = 'auto';

		const existingSource = await this.getSubscriptionTierSource(platform);
		const existingTier = await getStorageValue(`tier:${platform}`, null);

		// Manual override is sticky. Auto-detection cannot silently change
		// a value the user explicitly picked. The user can still change it
		// by re-selecting in the popup (which writes with source=manual).
		if (existingSource === 'manual' && source === 'auto') {
			if (existingTier === tier) return false;
			await Log('warn', `tier auto-detect skipped for ${platform} because user override is sticky`, {
				platform, detectedTier: tier, manualTier: existingTier
			});
			return false;
		}

		const changed = existingTier !== tier || existingSource !== source;
		await setStorageValue(`tier:${platform}`, tier);
		await setStorageValue(`tierSource:${platform}`, source);
		await setStorageValue(`tierSetAt:${platform}`, Date.now());
		if (changed) {
			await Log(`tier set for ${platform}: ${tier} (source=${source})`);
		}
		return true;
	}
	async getUserLimits(platform) { return await getStorageValue(`userLimits:${platform}`, null); }
	async setUserLimits(platform, limits) { await setStorageValue(`userLimits:${platform}`, limits); }
}


class LimitForecaster {
	constructor(usageStore) { this.us = usageStore; }

	async getForecast(platform, claudeUsageData = null) {
		const tier = await this.us.getSubscriptionTier(platform);
		const userLimits = await this.us.getUserLimits(platform);
		const velocity = await this.us.getVelocity(platform);
		const todayUsage = await this.us.getToday(platform);

		if (platform === 'claude' && claudeUsageData) {
			return this._fromClaudeAPI(claudeUsageData, velocity);
		}

		const pLimits = PLATFORM_LIMITS[platform];
		if (!pLimits) return [];
		const tierLimits = userLimits || pLimits[tier];
		if (!tierLimits) return [];

		const forecasts = [];
		const now = Date.now();

		for (const [name, def] of Object.entries(tierLimits)) {
			const windowMs = def.windowHours * 3600000;
			const cycleStart = def.windowHours >= 24 ? new Date().setUTCHours(0, 0, 0, 0) : now - windowMs;
			const cycleEnd = def.windowHours >= 24 ? cycleStart + windowMs : now + windowMs;

			const isMessages = def.type === 'messages';
			const currentUsage = isMessages ? todayUsage.requests : todayUsage.inputTokens + todayUsage.outputTokens;
			const limit = isMessages ? def.messageLimit : def.tokenLimit;
			if (!limit || limit <= 0) continue;
			const vel = isMessages ? velocity.requestsPerHour : velocity.tokensPerHour;
			const pct = Math.min((currentUsage / limit) * 100, 100);

			let exhaustionTime = null, timeRemainingMs = null;
			if (vel > 0 && currentUsage < limit) {
				const hoursLeft = (limit - currentUsage) / vel;
				exhaustionTime = now + hoursLeft * 3600000;
				timeRemainingMs = exhaustionTime - now;
				if (exhaustionTime > cycleEnd) { exhaustionTime = null; timeRemainingMs = null; }
			} else if (currentUsage >= limit) {
				exhaustionTime = now; timeRemainingMs = 0;
			}

			forecasts.push({
				limitName: name, limitType: def.type, windowHours: def.windowHours,
				currentUsage: Math.round(currentUsage), limit,
				percentage: pct, velocityPerHour: Math.round(vel),
				exhaustionTime, timeRemainingMs,
				timeRemainingFormatted: this._fmt(timeRemainingMs),
				exhaustionTimeFormatted: LimitForecaster.fmtTime(exhaustionTime),
				cycleStartTime: cycleStart, cycleEndTime: cycleEnd,
				cycleResetFormatted: this._fmt(cycleEnd - now)
			});
		}
		return forecasts;
	}

	_fromClaudeAPI(usageData, velocity) {
		const forecasts = [];
		const now = Date.now();
		const meta = { session: { wh: 5, label: 'Session (5h)' }, weekly: { wh: 168, label: 'Weekly' }, sonnetWeekly: { wh: 168, label: 'Sonnet Weekly' }, opusWeekly: { wh: 168, label: 'Opus Weekly' } };

		for (const [key, limit] of Object.entries(usageData.limits || {})) {
			if (!limit) continue;
			const m = meta[key];
			if (!m) continue;
			const pct = limit.percentage;
			const resetsAt = limit.resetsAt;
			const cap = CONFIG.ESTIMATED_CAPS?.[usageData.subscriptionTier]?.[key];

			let exhaustionTime = null, timeRemainingMs = null;
			if (cap && velocity.tokensPerHour > 0 && pct < 100) {
				const remaining = ((100 - pct) / 100) * cap;
				const hoursLeft = remaining / velocity.tokensPerHour;
				exhaustionTime = now + hoursLeft * 3600000;
				timeRemainingMs = exhaustionTime - now;
				if (resetsAt && exhaustionTime > resetsAt) { exhaustionTime = null; timeRemainingMs = null; }
			} else if (pct >= 100) {
				exhaustionTime = now; timeRemainingMs = 0;
			}

			forecasts.push({
				limitName: key, limitType: 'tokens', windowHours: m.wh,
				currentUsage: cap ? Math.round((pct / 100) * cap) : null,
				limit: cap || null, percentage: Math.min(pct, 100),
				velocityPerHour: Math.round(velocity.tokensPerHour),
				exhaustionTime, timeRemainingMs,
				timeRemainingFormatted: this._fmt(timeRemainingMs),
				exhaustionTimeFormatted: LimitForecaster.fmtTime(exhaustionTime),
				cycleStartTime: resetsAt ? resetsAt - m.wh * 3600000 : null,
				cycleEndTime: resetsAt,
				cycleResetFormatted: resetsAt ? this._fmt(resetsAt - now) : null
			});
		}
		return forecasts;
	}

	_fmt(ms) {
		if (ms === null || ms === undefined) return null;
		if (ms <= 0) return 'Now';
		const m = Math.round(ms / 60000);
		if (m < 1) return '<1m';
		const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
		if (d > 0) return `${d}d ${h}h`;
		if (h > 0) return `${h}h ${min}m`;
		return `${min}m`;
	}

	static fmtTime(ts) {
		if (!ts) return null;
		const d = new Date(ts), now = new Date();
		const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
		if (d.toDateString() === now.toDateString()) return `Today ${time}`;
		const tmr = new Date(now); tmr.setDate(tmr.getDate() + 1);
		if (d.toDateString() === tmr.toDateString()) return `Tomorrow ${time}`;
		return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ` ${time}`;
	}
}

const platformUsageStore = new PlatformUsageStore();
const limitForecaster = new LimitForecaster(platformUsageStore);

export { PlatformUsageStore, platformUsageStore, LimitForecaster, limitForecaster, TOKEN_CALIBRATION, PLATFORM_LIMITS, Log };
