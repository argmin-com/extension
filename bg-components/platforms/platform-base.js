// bg-components/platforms/platform-base.js
import { RawLog, StoredMap, getStorageValue, setStorageValue, CONFIG } from '../utils.js';

async function Log(...args) { await RawLog("platform-base", ...args); }

const TOKEN_CALIBRATION = {
	claude:  { input: 1.05, output: 1.05 },
	chatgpt: { input: 1.0,  output: 1.0  },
	gemini:  { input: 1.12, output: 1.12 },
	mistral: { input: 1.08, output: 1.08 }
};

const PLATFORM_LIMITS = {
	claude: {
		claude_free:    { session: { windowHours: 5, tokenLimit: 375000, type: 'tokens' } },
		claude_pro:     { session: { windowHours: 5, tokenLimit: 1500000, type: 'tokens' }, weekly: { windowHours: 168, tokenLimit: 15000000, type: 'tokens' } },
		claude_max_5x:  { session: { windowHours: 5, tokenLimit: 7500000, type: 'tokens' }, weekly: { windowHours: 168, tokenLimit: 75000000, type: 'tokens' } },
		claude_max_20x: { session: { windowHours: 5, tokenLimit: 30000000, type: 'tokens' }, weekly: { windowHours: 168, tokenLimit: 300000000, type: 'tokens' } }
	},
	chatgpt: {
		free: { daily: { windowHours: 24, messageLimit: 50, tokenLimit: null, type: 'messages' } },
		plus: { rolling_3h: { windowHours: 3, messageLimit: 80, tokenLimit: null, type: 'messages' } },
		pro:  { daily: { windowHours: 24, messageLimit: 999999, tokenLimit: null, type: 'messages' } },
		team: { rolling_3h: { windowHours: 3, messageLimit: 100, tokenLimit: null, type: 'messages' } }
	},
	gemini: {
		free:     { daily: { windowHours: 24, messageLimit: 50, tokenLimit: null, type: 'messages' } },
		advanced: { daily: { windowHours: 24, messageLimit: 1500, tokenLimit: null, type: 'messages' } }
	},
	mistral: {
		free: { daily: { windowHours: 24, messageLimit: 50, tokenLimit: null, type: 'messages' } },
		pro:  { daily: { windowHours: 24, messageLimit: 500, tokenLimit: null, type: 'messages' } }
	}
};

class PlatformUsageStore {
	constructor() {
		this.store = new StoredMap("platformUsage");
		this.velocityStore = new StoredMap("platformVelocity");
		this.rateLimitStore = new StoredMap("platformRateLimits");
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
			existing.estimatedCostUSD += (inputTokens / 1e6) * mp.input + (outputTokens / 1e6) * mp.output;
		}
	}

	async recordRequest(platform, model, inputTokens, outputTokens) {
		const now = Date.now();
		const key = `${platform}:${new Date().toISOString().slice(0, 10)}`;
		const existing = await this.store.get(key) || {
			requests: 0, inputTokens: 0, outputTokens: 0,
			models: {}, estimatedCostUSD: 0,
			totalEnergyWh: 0, totalCarbonGco2e: 0,
			firstRequestAt: now, lastRequestAt: now
		};
		existing.requests += 1;
		existing.inputTokens += inputTokens;
		existing.outputTokens += outputTokens;
		existing.lastRequestAt = now;
		if (!existing.firstRequestAt) existing.firstRequestAt = now;
		if (!existing.totalEnergyWh) existing.totalEnergyWh = 0;
		if (!existing.totalCarbonGco2e) existing.totalCarbonGco2e = 0;

		if (!existing.models[model]) existing.models[model] = { requests: 0, inputTokens: 0, outputTokens: 0 };
		existing.models[model].requests += 1;
		existing.models[model].inputTokens += inputTokens;
		existing.models[model].outputTokens += outputTokens;

		this._addCost(existing, platform, model, inputTokens, outputTokens);
		await this.store.set(key, existing, 8 * 24 * 60 * 60 * 1000);
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
		await this.store.set(key, existing, 8 * 24 * 60 * 60 * 1000);
		return existing;
	}

	async recordOutputTokens(platform, model, outputTokens) {
		const calibrated = this.calibrateTokens(platform, outputTokens, 'output');
		const key = `${platform}:${new Date().toISOString().slice(0, 10)}`;
		const existing = await this.store.get(key);
		if (!existing) return null;

		existing.outputTokens += calibrated;
		existing.lastRequestAt = Date.now();
		if (existing.models[model]) existing.models[model].outputTokens += calibrated;

		// Add output cost only (input already recorded)
		const pricing = CONFIG.PRICING[platform];
		if (pricing) {
			const mk = this._findPricingKey(pricing, model);
			const mp = pricing[mk] || Object.values(pricing)[0];
			if (mp) existing.estimatedCostUSD += (calibrated / 1e6) * mp.output;
		}

		await this.store.set(key, existing, 8 * 24 * 60 * 60 * 1000);
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
			firstRequestAt: null, lastRequestAt: null
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

	async getSubscriptionTier(platform) { return await getStorageValue(`tier:${platform}`, 'free'); }
	async setSubscriptionTier(platform, tier) { await setStorageValue(`tier:${platform}`, tier); }
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
