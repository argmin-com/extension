function isoDay(offsetDays = 0) {
	const day = new Date();
	day.setDate(day.getDate() + offsetDays);
	return day.toISOString().slice(0, 10);
}

function makeUsageRecord(platform, offsetDays = 0, overrides = {}) {
	const now = Date.now();
	return [
		`${platform}:${isoDay(offsetDays)}`,
		{
			requests: 0,
			inputTokens: 0,
			outputTokens: 0,
			models: {},
			estimatedCostUSD: 0,
			totalEnergyWh: 0,
			totalCarbonGco2e: 0,
			firstRequestAt: now - 3600000,
			lastRequestAt: now,
			...overrides
		}
	];
}

function makeVelocityRecord(platform, overrides = {}) {
	return [
		`velocity:${platform}`,
		{
			tokensPerHour: 0,
			requestsPerHour: 0,
			inputTokensPerHour: 0,
			outputTokensPerHour: 0,
			costPerHour: 0,
			samplePeriodMs: 0,
			updatedAt: Date.now(),
			...overrides
		}
	];
}

module.exports = {
	makeUsageRecord,
	makeVelocityRecord
};
