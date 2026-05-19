// bg-components/cross-platform-router.js
// "Try this prompt on another model" -- given a piece of composer text
// and a target platform id, returns the URL to open and (where the
// platform doesn't accept the prompt via URL parameter) signals that
// the popup should also put the text on the clipboard.
//
// We deliberately do NOT POST anything anywhere from background; the
// only outbound effect is opening a tab the user can then send from.
// Several of the 8 platforms accept a query-param-pre-filled composer
// (e.g. ChatGPT's `?q=` param, Perplexity's `?q=`); the rest get the
// clipboard fallback plus the bare URL.

const TARGETS = {
	claude:     { url: 'https://claude.ai/new',                   queryParam: null },
	chatgpt:    { url: 'https://chatgpt.com/?model=auto',         queryParam: 'q'  },
	gemini:     { url: 'https://gemini.google.com/app',           queryParam: null },
	mistral:    { url: 'https://chat.mistral.ai/chat',            queryParam: null },
	perplexity: { url: 'https://www.perplexity.ai/',              queryParam: 'q'  },
	grok:       { url: 'https://grok.com/',                       queryParam: null },
	meta:       { url: 'https://www.meta.ai/',                    queryParam: null },
	copilot:    { url: 'https://copilot.microsoft.com/',          queryParam: 'q'  }
};

const MAX_QUERY_PARAM_CHARS = 1500;

/**
 * Build the open-target spec for a (text, platform) pair.
 * @returns {{url: string, useClipboard: boolean, target: string} | null}
 *   `url` is what to open in a new tab. `useClipboard` is true when the
 *   prompt could not be embedded in the URL (target lacks a query param,
 *   or the text is too long for query params). Returns null on
 *   unsupported target.
 */
function buildCrossPlatformOpen(text, target) {
	const cfg = TARGETS[target];
	if (!cfg) return null;
	const trimmed = String(text || '').trim();
	if (!trimmed) return { url: cfg.url, useClipboard: false, target };
	if (cfg.queryParam) {
		// Build the full URL first, then measure its post-encoding length
		// against the cap. Non-ASCII and reserved characters expand under
		// URLSearchParams encoding (a single em-dash becomes 9 chars),
		// so a raw-length cap can let the final URL blow past common
		// browser limits.
		const u = new URL(cfg.url);
		u.searchParams.set(cfg.queryParam, trimmed);
		const full = u.toString();
		if (full.length <= MAX_QUERY_PARAM_CHARS + cfg.url.length) {
			return { url: full, useClipboard: false, target };
		}
	}
	// Either the platform doesn't take a query param, or the encoded
	// URL would be too long. Open the bare landing page and have the
	// popup put the text on the clipboard for the user to paste.
	return { url: cfg.url, useClipboard: true, target };
}

function listCrossPlatformTargets() {
	return Object.keys(TARGETS);
}

export { buildCrossPlatformOpen, listCrossPlatformTargets, TARGETS, MAX_QUERY_PARAM_CHARS };
