// bg-components/carbon-energy.js
// Argmin Carbon & Energy Estimation Engine
// Ported from argmin-carbon-tracker MCP server scaffold.
// Calculates energy (Wh) and carbon (gCO2e) for AI model invocations
// using AI Energy Score benchmarks, token scaling, PUE, and grid intensity.

import { CONFIG } from './utils.js';

// ── Grid Intensity Data (gCO2/kWh) ──
// Sources: EPA eGRID 2022, EEA 2022, IEA 2022
const GRID_INTENSITY = {
	'us-average':      { name: 'United States Average',     intensity: 388.0, source: 'epa_egrid', year: 2022 },
	'us-east-1':       { name: 'US East (Virginia)',        intensity: 309.7, source: 'epa_egrid', year: 2022 },
	'us-west-2':       { name: 'US West (Oregon)',          intensity: 117.2, source: 'epa_egrid', year: 2022 },
	'eu-west-1':       { name: 'EU West (Ireland)',         intensity: 296.0, source: 'eea',       year: 2022 },
	'eu-central-1':    { name: 'EU Central (Frankfurt)',    intensity: 385.0, source: 'eea',       year: 2022 },
	'eu-west-3':       { name: 'EU West (Paris)',           intensity: 56.0,  source: 'eea',       year: 2022 },
	'ap-northeast-1':  { name: 'Asia Pacific (Tokyo)',      intensity: 471.0, source: 'iea',       year: 2022 },
	'ap-southeast-1':  { name: 'Asia Pacific (Singapore)',  intensity: 408.0, source: 'iea',       year: 2022 },
	'global-average':  { name: 'Global Average',            intensity: 436.0, source: 'iea',       year: 2022 }
};

// ── AI Energy Score Benchmarks ──
// Energy per 1K-token prompt (Wh) from AI Energy Score v2 Dec 2025
const ENERGY_BENCHMARKS = {
	'claude-3.5-sonnet': {
		energyPerPromptWh: 0.005, benchmarkTokenCount: 500,
		energyScore: 3, tokensPerJoule: 55.6, source: 'ai_energy_score_v2_dec2025'
	},
	'claude-3-haiku': {
		energyPerPromptWh: 0.0008, benchmarkTokenCount: 500,
		energyScore: 5, tokensPerJoule: 347.2, source: 'ai_energy_score_v2_dec2025'
	},
	'claude-3-opus': {
		energyPerPromptWh: 0.018, benchmarkTokenCount: 500,
		energyScore: 1, tokensPerJoule: 15.4, source: 'ai_energy_score_v2_dec2025'
	}
};

// ── Model Mapping: API model names → benchmark entries ──
const MODEL_MAPPING = {
	// Claude models
	'Opus':   { benchmarkId: 'claude-3-opus',     confidence: 'family', paramBillions: 200 },
	'Sonnet': { benchmarkId: 'claude-3.5-sonnet',  confidence: 'family', paramBillions: 70 },
	'Haiku':  { benchmarkId: 'claude-3-haiku',      confidence: 'family', paramBillions: 20 },
	// ChatGPT models (parametric estimates based on published parameter counts)
	'gpt-4o':       { benchmarkId: null, confidence: 'parametric', paramBillions: 200 },
	'gpt-4o-mini':  { benchmarkId: null, confidence: 'parametric', paramBillions: 8 },
	'gpt-4.1':      { benchmarkId: null, confidence: 'parametric', paramBillions: 200 },
	'o3':           { benchmarkId: null, confidence: 'parametric', paramBillions: 200, isReasoning: true },
	'o4-mini':      { benchmarkId: null, confidence: 'parametric', paramBillions: 8, isReasoning: true },
	// Gemini models
	'gemini-2.5-pro':   { benchmarkId: null, confidence: 'parametric', paramBillions: 300 },
	'gemini-2.5-flash': { benchmarkId: null, confidence: 'parametric', paramBillions: 50 },
	'gemini-2.0-flash': { benchmarkId: null, confidence: 'parametric', paramBillions: 50 },
	// Mistral models
	'mistral-large':  { benchmarkId: null, confidence: 'parametric', paramBillions: 123 },
	'mistral-medium': { benchmarkId: null, confidence: 'parametric', paramBillions: 70 },
	'mistral-small':  { benchmarkId: null, confidence: 'parametric', paramBillions: 22 }
};

// ── Default Configuration ──
const DEFAULT_PUE = 1.2;    // Power Usage Effectiveness (datacenter overhead)
const DEFAULT_OVERHEAD = 2.0; // Inference serving overhead multiplier
const UNCERTAINTY_PCT = 0.30; // 30% uncertainty on estimates
const REASONING_MULTIPLIER = 3.0; // Reasoning models use ~3x compute

// ── Parametric Fallback ──
// For models without AI Energy Score benchmarks, estimate energy from parameter count.
// Based on: E(Wh) ≈ 0.0001 * (params_billions^0.8) * (tokens / 500)
// This is a rough scaling law; confidence is flagged as 'parametric_estimate'.
function parametricEnergyWh(paramBillions, totalTokens, isReasoning = false) {
	const baseEnergy = 0.0001 * Math.pow(paramBillions, 0.8) * (totalTokens / 500);
	return isReasoning ? baseEnergy * REASONING_MULTIPLIER : baseEnergy;
}

// ── Energy Engine ──

/**
 * Estimate energy consumption (Wh) for a model invocation.
 * Uses AI Energy Score benchmark when available, parametric fallback otherwise.
 *
 * @param {string} model - Model name (e.g., 'Sonnet', 'gpt-4o')
 * @param {number} inputTokens - Input token count
 * @param {number} outputTokens - Output token count
 * @param {number} pue - Power Usage Effectiveness factor
 * @param {number} overhead - Inference serving overhead factor
 * @returns {object} EnergyEstimate with lower, estimate, upper bounds (Wh)
 */
function estimateEnergy(model, inputTokens, outputTokens, pue = DEFAULT_PUE, overhead = DEFAULT_OVERHEAD) {
	const totalTokens = inputTokens + outputTokens;
	if (totalTokens === 0) return zeroEnergy();

	const mapping = MODEL_MAPPING[model];
	let rawEnergyWh, method, confidence, benchmarkSource;

	if (mapping?.benchmarkId && ENERGY_BENCHMARKS[mapping.benchmarkId]) {
		// AI Energy Score path: scale from benchmark
		const bench = ENERGY_BENCHMARKS[mapping.benchmarkId];
		const tokenRatio = totalTokens / bench.benchmarkTokenCount;
		rawEnergyWh = bench.energyPerPromptWh * tokenRatio;
		method = 'ai_energy_score_scaled';
		confidence = mapping.confidence === 'family' ? 'family_approximation' : 'benchmark_available';
		benchmarkSource = bench.source;
	} else if (mapping) {
		// Parametric fallback
		rawEnergyWh = parametricEnergyWh(mapping.paramBillions, totalTokens, mapping.isReasoning);
		method = 'parametric_flops';
		confidence = 'parametric_estimate';
		benchmarkSource = 'parametric_model';
	} else {
		// Unknown model: use median parameters
		rawEnergyWh = parametricEnergyWh(70, totalTokens);
		method = 'parametric_flops';
		confidence = 'parametric_estimate';
		benchmarkSource = 'unknown_model_fallback';
	}

	const adjustedWh = rawEnergyWh * pue * overhead;
	const lowerWh = adjustedWh * (1 - UNCERTAINTY_PCT);
	const upperWh = adjustedWh * (1 + UNCERTAINTY_PCT);

	return {
		lowerBoundWh: lowerWh,
		estimateWh: adjustedWh,
		upperBoundWh: upperWh,
		method, confidence, benchmarkSource,
		pueFactor: pue, overheadFactor: overhead
	};
}

function zeroEnergy() {
	return {
		lowerBoundWh: 0, estimateWh: 0, upperBoundWh: 0,
		method: 'none', confidence: 'none', benchmarkSource: 'none',
		pueFactor: DEFAULT_PUE, overheadFactor: DEFAULT_OVERHEAD
	};
}

// ── Carbon Engine ──

/**
 * Calculate carbon emissions (gCO2e) from energy estimate and grid intensity.
 *
 * @param {object} energy - EnergyEstimate from estimateEnergy()
 * @param {string} regionId - Region ID for grid intensity lookup
 * @returns {object} CarbonEstimate with lower, estimate, upper bounds (gCO2e)
 */
function estimateCarbon(energy, regionId = 'us-average') {
	const region = GRID_INTENSITY[regionId] || GRID_INTENSITY['us-average'];
	const intensityGco2Kwh = region.intensity;

	// gCO2e = Wh * (gCO2/kWh) / 1000
	const estimateGco2e = energy.estimateWh * intensityGco2Kwh / 1000;
	const lowerGco2e = energy.lowerBoundWh * intensityGco2Kwh / 1000;
	const upperGco2e = energy.upperBoundWh * intensityGco2Kwh / 1000;

	return {
		lowerBoundGco2e: lowerGco2e,
		estimateGco2e: estimateGco2e,
		upperBoundGco2e: upperGco2e,
		gridIntensityGco2Kwh: intensityGco2Kwh,
		gridIntensitySource: region.source,
		gridIntensityMethod: 'location_based',
		region: regionId,
		regionName: region.name
	};
}

// ── Calculation Receipt ──

/**
 * Generate an immutable calculation receipt for audit trail.
 * Once created, receipts must never be modified.
 */
function generateReceipt(model, inputTokens, outputTokens, energy, carbon) {
	return {
		receiptId: crypto.randomUUID ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		timestamp: new Date().toISOString(),
		modelName: model,
		inputTokens, outputTokens,
		totalTokens: inputTokens + outputTokens,
		rawEnergyWh: energy.estimateWh / (energy.pueFactor * energy.overheadFactor),
		pueFactor: energy.pueFactor,
		overheadFactor: energy.overheadFactor,
		adjustedEnergyWh: energy.estimateWh,
		gridIntensityGco2Kwh: carbon.gridIntensityGco2Kwh,
		gridIntensitySource: carbon.gridIntensitySource,
		gridIntensityMethod: carbon.gridIntensityMethod,
		finalGco2e: carbon.estimateGco2e,
		uncertaintyPct: UNCERTAINTY_PCT,
		estimationMethod: energy.method,
		methodologyVersion: 'argmin-v0.1.0'
	};
}

// ── Public API ──

/**
 * Full impact estimate: energy + carbon + receipt for a single query.
 *
 * @param {string} model - Model name
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} regionId - Datacenter region
 * @param {number} pue - PUE factor
 * @param {number} overhead - Overhead factor
 * @returns {object} { energy, carbon, receipt }
 */
function estimateImpact(model, inputTokens, outputTokens, regionId = 'us-average', pue = DEFAULT_PUE, overhead = DEFAULT_OVERHEAD) {
	const energy = estimateEnergy(model, inputTokens, outputTokens, pue, overhead);
	const carbon = estimateCarbon(energy, regionId);
	const receipt = generateReceipt(model, inputTokens, outputTokens, energy, carbon);
	return { energy, carbon, receipt };
}

/**
 * Compare multiple models for the same token count.
 */
function compareModels(models, tokenCount, regionId = 'us-average') {
	return models.map(model => {
		const inputTokens = Math.round(tokenCount * 0.7);
		const outputTokens = Math.round(tokenCount * 0.3);
		const impact = estimateImpact(model, inputTokens, outputTokens, regionId);
		const mapping = MODEL_MAPPING[model];
		const bench = mapping?.benchmarkId ? ENERGY_BENCHMARKS[mapping.benchmarkId] : null;

		// Calculate cost from CONFIG.PRICING
		let costUSD = null;
		for (const [platform, pricingMap] of Object.entries(CONFIG.PRICING)) {
			if (pricingMap[model]) {
				costUSD = (inputTokens / 1e6) * pricingMap[model].input + (outputTokens / 1e6) * pricingMap[model].output;
				break;
			}
		}

		return {
			model,
			energyScore: bench?.energyScore || null,
			energyWh: impact.energy.estimateWh,
			carbonGco2e: impact.carbon.estimateGco2e,
			confidence: impact.energy.confidence,
			costUSD
		};
	}).sort((a, b) => a.energyWh - b.energyWh);
}

/**
 * Get available regions for the UI.
 */
function getRegions() {
	return Object.entries(GRID_INTENSITY).map(([id, data]) => ({
		id, name: data.name, intensity: data.intensity, source: data.source
	}));
}

/**
 * Get methodology summary.
 */
function getMethodology() {
	return {
		version: 'argmin-v0.1.0',
		energySources: ['AI Energy Score v2 (Dec 2025)', 'Parametric FLOPs estimation'],
		carbonMethodology: 'energy_wh × grid_intensity_gco2_kwh / 1000',
		pueFactor: DEFAULT_PUE,
		overheadFactor: DEFAULT_OVERHEAD,
		uncertaintyModel: `±${UNCERTAINTY_PCT * 100}% bounds on all estimates`,
		supportedModels: Object.keys(MODEL_MAPPING).length,
		gridIntensityRegions: Object.keys(GRID_INTENSITY).length
	};
}

// Export for ES module (background.js)
export {
	estimateImpact,
	estimateEnergy,
	estimateCarbon,
	generateReceipt,
	compareModels,
	getRegions,
	getMethodology,
	GRID_INTENSITY,
	ENERGY_BENCHMARKS,
	MODEL_MAPPING,
	DEFAULT_PUE,
	DEFAULT_OVERHEAD
};
