// bg-components/citation-extractor.js
// Pull URLs and citation-like references out of model response text and
// return them as a deduped, ranked list. Pure function, no I/O.
//
// What counts as a "citation":
//   - bare http(s) URLs in the text
//   - URLs inside markdown links `[label](https://...)`
//   - URLs inside angle-bracket links `<https://...>`
// We deliberately do NOT try to parse Perplexity's `[1]`/`[2]` footnote
// syntax because the body the extension sees is post-render markdown
// from the page; if the user wants those, Perplexity's own sidebar
// already shows them. This module's job is "scrape the URLs that the
// model embedded in its prose."
//
// Bibliography formats: 'markdown', 'plain', 'bibtex'. The same dedup
// + ranking pipeline feeds each.

const MAX_CITATIONS = 200;

// Matchers, in order. Each captures group 1 = URL. The .match() loop
// iterates in this order so earlier patterns take precedence for the
// `label` field. Markdown-link must come BEFORE bare-URL.
//
// The markdown URL group permits `)` because legitimate URLs (Wikipedia
// articles, e.g. /wiki/JavaScript_(programming_language)) contain
// balanced parens. The trailing `)` that terminates the markdown
// `](url)` syntax is then trimmed in two passes:
//   1. matchAll consumes the closing `)` as the regex terminator,
//   2. stripTrailingPunctuation balances any remaining `)` in the URL.
const PATTERNS = [
	{ kind: 'markdown', re: /\[([^\]]+)\]\((https?:\/\/[^\s<>"]+)\)/g, labelGroup: 1, urlGroup: 2 },
	{ kind: 'angle',    re: /<(https?:\/\/[^\s>"]+)>/g, labelGroup: null, urlGroup: 1 },
	// Bare URLs. Stop at whitespace, common punctuation, or quote chars.
	{ kind: 'bare',     re: /\bhttps?:\/\/[A-Za-z0-9_\-./?&%#:=+~!*';,()\[\]@$]+/g, labelGroup: null, urlGroup: 0 }
];

function stripTrailingPunctuation(url) {
	// Strip common trailing punctuation that often follows a URL in
	// prose. Closing parens / brackets are kept ONLY when there's an
	// unmatched opener earlier in the URL that this closer is needed
	// to balance -- the Wikipedia article case
	// `JavaScript_(programming_language)`. When opens == closes after
	// removing the trailing closer, every opener inside the URL already
	// has its match in `head`, so the trailing closer is extraneous
	// prose punctuation and is correctly stripped.
	let u = url;
	while (u && /[.,;:!?)\]>"']$/.test(u)) {
		const last = u[u.length - 1];
		const head = u.slice(0, -1);
		if (last === ')') {
			const opens = (head.match(/\(/g) || []).length;
			const closes = (head.match(/\)/g) || []).length;
			if (opens > closes) break; // unmatched opener inside URL -- keep ')'
		}
		if (last === ']') {
			const opens = (head.match(/\[/g) || []).length;
			const closes = (head.match(/\]/g) || []).length;
			if (opens > closes) break;
		}
		u = head;
	}
	return u;
}

function safeHost(url) {
	try { return new URL(url).hostname; }
	catch { return ''; }
}

/**
 * Extract citations from response text.
 * @param {string} text
 * @returns {Array<{url, host, label, kind, count}>}
 */
function extractCitations(text) {
	if (typeof text !== 'string' || text.length === 0) return [];
	const seen = new Map(); // url -> { url, host, label, kind, count }
	// Track byte ranges already claimed by an earlier pattern so the
	// bare-URL pass doesn't re-count a URL that lived inside a markdown
	// or angle-bracket wrapper. Ranges are [start, end) of the full
	// match (including the wrapper characters), so a bare match starting
	// inside any claimed range is skipped.
	const claimedRanges = []; // {start, end}

	function isClaimed(start) {
		for (const r of claimedRanges) {
			if (start >= r.start && start < r.end) return true;
		}
		return false;
	}

	for (const { kind, re, labelGroup, urlGroup } of PATTERNS) {
		// matchAll() accepts a /g RegExp directly without mutating its
		// lastIndex, so the module-level patterns are safe to reuse
		// across calls.
		const matches = text.matchAll(re);
		for (const m of matches) {
			// Skip if this match starts inside a region already claimed
			// by a higher-priority pattern (markdown > angle > bare).
			if (kind === 'bare' && isClaimed(m.index)) continue;
			let url = stripTrailingPunctuation(m[urlGroup]);
			if (!url || !/^https?:\/\//.test(url)) continue;
			const host = safeHost(url);
			if (!host) continue;
			const label = labelGroup ? m[labelGroup].trim() : '';
			const existing = seen.get(url);
			if (existing) {
				existing.count += 1;
				if (!existing.label && label) existing.label = label;
			} else {
				seen.set(url, { url, host, label, kind, count: 1 });
				if (seen.size >= MAX_CITATIONS) break;
			}
			// Only the higher-priority patterns claim a range; bare
			// patterns don't because they're already the last pass.
			if (kind !== 'bare') {
				claimedRanges.push({ start: m.index, end: m.index + m[0].length });
			}
		}
		if (seen.size >= MAX_CITATIONS) break;
	}

	// Rank by count (desc), then by host alphabetically (stable).
	return [...seen.values()].sort((a, b) => {
		if (b.count !== a.count) return b.count - a.count;
		return a.host.localeCompare(b.host);
	});
}

function formatBibliography(citations, format = 'markdown') {
	if (!Array.isArray(citations) || citations.length === 0) return '';
	if (format === 'plain') {
		return citations.map(c => c.url).join('\n');
	}
	if (format === 'bibtex') {
		return citations.map((c, i) => {
			const key = `cite${i + 1}`;
			const title = (c.label || c.host).replace(/[{}]/g, '');
			// Percent-encode braces in URLs: a stray `}` would otherwise
			// terminate the BibTeX entry early and produce malformed
			// output. Real-world URLs almost never contain braces but
			// the encoder is cheap.
			const url = c.url.replace(/[{}]/g, m => m === '{' ? '%7B' : '%7D');
			return `@misc{${key},\n  title = {${title}},\n  url = {${url}}\n}`;
		}).join('\n\n');
	}
	// markdown (default)
	return citations.map(c => {
		const label = c.label || c.host;
		return `- [${label}](${c.url})`;
	}).join('\n');
}

export { extractCitations, formatBibliography, MAX_CITATIONS };
