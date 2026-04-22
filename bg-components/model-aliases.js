// bg-components/model-aliases.js
// Model name aliasing inspired by codeburn. Maps proxy/variant model names to
// canonical pricing keys so intercepted traffic doesn't end up costing $0 just
// because the provider changed a string.

import { getStorageValue, setStorageValue, RawLog } from './utils.js';

async function Log(...args) { await RawLog('model-aliases', ...args); }

// Built-in aliases. Keys are lowercase normalized substrings; values are the
// canonical CONFIG.PRICING key. User-configured aliases take precedence.
const BUILTIN_ALIASES = {
	// Claude proxy variants
	'anthropic--claude-opus-4':   'Opus',
	'anthropic--claude-sonnet-4': 'Sonnet',
	'anthropic--claude-haiku-4':  'Haiku',
	'claude-3-opus':              'Opus',
	'claude-3-sonnet':            'Sonnet',
	'claude-3-haiku':             'Haiku',
	'claude-3.5-sonnet':          'Sonnet',
	'claude-3.5-haiku':           'Haiku',
	'claude-3.7-sonnet':          'Sonnet',
	'claude-4-opus':              'Opus',
	'claude-4-sonnet':            'Sonnet',
	'claude-4.5-sonnet':          'Sonnet',
	'claude-4.6-sonnet':          'Sonnet',
	'claude-4.6-opus':            'Opus',
	'claude-4.7-opus':            'Opus',
	// OpenAI aliases
	'gpt-4-turbo':                'gpt-4.1',
	'gpt-4-0125':                 'gpt-4.1',
	'openai-gpt-4o':              'gpt-4o',
	'openai-gpt-4o-mini':         'gpt-4o-mini',
	'o3-mini':                    'o4-mini',
	// Google aliases
	'google-gemini-pro':          'gemini-2.5-pro',
	'gemini-pro':                 'gemini-2.5-pro',
	'gemini-flash':               'gemini-2.5-flash',
	'gemini-1.5-pro':             'gemini-2.5-pro',
	'gemini-1.5-flash':           'gemini-2.5-flash',
	// Mistral aliases
	'mistral-tiny':               'mistral-small',
	'mistral-7b':                 'mistral-small',
	'open-mistral':               'mistral-small',
	'open-mixtral':               'mistral-medium'
};

async function getUserAliases() {
	return await getStorageValue('modelAliases', {});
}

async function setUserAlias(alias, canonical) {
	if (!alias || !canonical) throw new Error('alias_and_canonical_required');
	const aliases = await getUserAliases();
	aliases[String(alias).toLowerCase().trim()] = String(canonical).trim();
	await setStorageValue('modelAliases', aliases);
	return aliases;
}

async function removeUserAlias(alias) {
	const aliases = await getUserAliases();
	delete aliases[String(alias).toLowerCase().trim()];
	await setStorageValue('modelAliases', aliases);
	return aliases;
}

async function listUserAliases() {
	return await getUserAliases();
}

async function resolveModel(model) {
	if (!model || typeof model !== 'string') return model;
	const lower = model.toLowerCase().trim();
	const userAliases = await getUserAliases();
	if (userAliases[lower]) return userAliases[lower];
	if (userAliases[model]) return userAliases[model];

	// Exact built-in
	if (BUILTIN_ALIASES[lower]) return BUILTIN_ALIASES[lower];

	// Substring built-in: pick longest match so more specific aliases win.
	let best = null;
	let bestLen = 0;
	for (const [key, canonical] of Object.entries(BUILTIN_ALIASES)) {
		if (lower.includes(key) && key.length > bestLen) {
			best = canonical;
			bestLen = key.length;
		}
	}
	if (best) return best;

	return model;
}

export { resolveModel, setUserAlias, removeUserAlias, listUserAliases, BUILTIN_ALIASES };
