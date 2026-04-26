// bg-components/currency.js
// Currency conversion inspired by codeburn. Uses Frankfurter (ECB rates, no key)
// with 24h caching. Defaults to USD. Fetches are only triggered when the user
// explicitly sets a non-USD currency from the popup; otherwise no network
// traffic happens. Keeps the local-only default promise intact.

import { getStorageValue, setStorageValue, RawLog } from './utils.js';

async function Log(...args) { await RawLog('currency', ...args); }

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FRANKFURTER_BASE = 'https://api.frankfurter.app';

// ISO 4217 subset shown in the picker. CLI users can still set any currency via
// the message handler; this is just a friendly short list.
const COMMON_CURRENCIES = [
	{ code: 'USD', name: 'US Dollar', symbol: '$' },
	{ code: 'EUR', name: 'Euro', symbol: '€' },
	{ code: 'GBP', name: 'British Pound', symbol: '£' },
	{ code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
	{ code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$' },
	{ code: 'AUD', name: 'Australian Dollar', symbol: 'AU$' },
	{ code: 'CHF', name: 'Swiss Franc', symbol: 'CHF' },
	{ code: 'CNY', name: 'Chinese Yuan', symbol: '¥' },
	{ code: 'INR', name: 'Indian Rupee', symbol: '₹' },
	{ code: 'BRL', name: 'Brazilian Real', symbol: 'R$' },
	{ code: 'MXN', name: 'Mexican Peso', symbol: 'MX$' },
	{ code: 'KRW', name: 'South Korean Won', symbol: '₩' },
	{ code: 'SGD', name: 'Singapore Dollar', symbol: 'S$' },
	{ code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$' },
	{ code: 'SEK', name: 'Swedish Krona', symbol: 'kr' },
	{ code: 'NOK', name: 'Norwegian Krone', symbol: 'kr' },
	{ code: 'ZAR', name: 'South African Rand', symbol: 'R' }
];

async function getCurrency() {
	return await getStorageValue('currency', 'USD');
}

async function setCurrency(code) {
	const upper = (code || 'USD').toUpperCase();
	if (!/^[A-Z]{3}$/.test(upper)) throw new Error('invalid_currency_code');
	await setStorageValue('currency', upper);
	// Invalidate rate cache when the currency changes.
	await setStorageValue('currency:rate', null);
	return upper;
}

async function resetCurrency() {
	await setStorageValue('currency', 'USD');
	await setStorageValue('currency:rate', null);
	return 'USD';
}

async function getCachedRate(code) {
	const cached = await getStorageValue('currency:rate', null);
	if (!cached || cached.base !== 'USD' || cached.target !== code) return null;
	if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
	return cached;
}

async function fetchRate(code) {
	if (code === 'USD') return { base: 'USD', target: 'USD', rate: 1, fetchedAt: Date.now(), source: 'identity' };
	const cached = await getCachedRate(code);
	if (cached) return cached;
	try {
		const url = `${FRANKFURTER_BASE}/latest?from=USD&to=${encodeURIComponent(code)}`;
		const resp = await fetch(url, { method: 'GET', credentials: 'omit' });
		if (!resp.ok) throw new Error(`frankfurter_http_${resp.status}`);
		const json = await resp.json();
		const rate = json?.rates?.[code];
		if (!rate || typeof rate !== 'number') throw new Error('frankfurter_no_rate');
		const stored = { base: 'USD', target: code, rate, fetchedAt: Date.now(), source: 'frankfurter' };
		await setStorageValue('currency:rate', stored);
		await Log('Fetched exchange rate', { code, rate });
		return stored;
	} catch (e) {
		await Log('warn', 'Exchange rate fetch failed, falling back to USD:', e?.message || e);
		return { base: 'USD', target: 'USD', rate: 1, fetchedAt: Date.now(), source: 'fallback', error: e?.message || 'unknown' };
	}
}

async function convertUSD(amountUSD) {
	const code = await getCurrency();
	if (code === 'USD') return { amount: amountUSD, currency: 'USD', rate: 1, symbol: '$', source: 'identity' };
	const rate = await fetchRate(code);
	const info = COMMON_CURRENCIES.find(c => c.code === code) || { code, name: code, symbol: code + ' ' };
	return {
		amount: amountUSD * rate.rate,
		currency: code,
		symbol: info.symbol,
		rate: rate.rate,
		source: rate.source,
		fetchedAt: rate.fetchedAt
	};
}

// Format in the active currency. amount is a USD value; this handles conversion.
async function formatUSD(amountUSD, { decimals = null } = {}) {
	const conv = await convertUSD(amountUSD);
	const d = decimals !== null ? decimals : (conv.currency === 'JPY' || conv.currency === 'KRW') ? 0 : (conv.amount < 1 ? 4 : 2);
	return {
		text: `${conv.symbol}${conv.amount.toFixed(d)}`,
		currency: conv.currency,
		raw: conv.amount,
		rate: conv.rate
	};
}

function listCurrencies() {
	return COMMON_CURRENCIES.slice();
}

export { getCurrency, setCurrency, resetCurrency, convertUSD, formatUSD, listCurrencies, fetchRate, COMMON_CURRENCIES };
