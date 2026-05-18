// bg-components/sensitive-scanner.js
// Pre-send heuristic scanner for prompts containing data the user
// probably doesn't want to send to an AI provider. Pure functions, no
// state, no I/O — safe to call on every keystroke.
//
// Privacy: this module receives prompt text but never persists it. The
// caller gets back only counts and pattern names, never matched
// substrings. Findings are summarised by category, not by content.
//
// All matchers favour false-negatives over false-positives: it's worse
// to spam the user with bogus warnings than to occasionally miss a
// real secret. Users who need stricter scanning can opt into
// `codeAllowlistMode` which adds high-entropy / file-shape matchers.

// Each entry: { id, label, severity, re, codeOnly }
//   severity: 'info' | 'warn' | 'block' (UI surfaces decide what to do)
//   codeOnly: only fires when codeAllowlistMode is enabled (these are
//             noisier patterns that hit legitimate uses in non-code
//             prompts, like documentation about an example API key)
const PATTERNS = [
	// PII
	{ id: 'email',         label: 'Email address',  severity: 'info',
	  re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
	{ id: 'phone_e164',    label: 'Phone (E.164)',  severity: 'info',
	  re: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{1,4}[\s.-]?\d{1,9}\b/g },
	{ id: 'phone_us',      label: 'Phone (US)',     severity: 'info',
	  re: /\b\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g },
	{ id: 'ssn',           label: 'US SSN',         severity: 'warn',
	  re: /\b\d{3}-\d{2}-\d{4}\b/g },
	{ id: 'credit_card',   label: 'Credit-card-shaped number', severity: 'warn',
	  // 13-19 digits with optional spaces/dashes between 4-digit groups.
	  // Validated by Luhn check at the caller.
	  re: /\b(?:\d[ -]?){13,19}\b/g, luhn: true },
	{ id: 'ipv4',          label: 'IPv4 address',   severity: 'info',
	  re: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\b/g },

	// API keys / tokens (shaped strings). Each is shaped distinctively
	// enough that false positives are rare even outside code mode.
	{ id: 'aws_access_key',  label: 'AWS access key',     severity: 'block',
	  re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ id: 'anthropic_key',   label: 'Anthropic API key',  severity: 'block',
	  re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
	{ id: 'openai_key',      label: 'OpenAI API key',     severity: 'block',
	  re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
	{ id: 'github_pat',      label: 'GitHub token',       severity: 'block',
	  re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
	{ id: 'slack_token',     label: 'Slack token',        severity: 'block',
	  re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
	{ id: 'jwt',             label: 'JSON Web Token',     severity: 'warn',
	  re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
	{ id: 'gcp_service_acct', label: 'GCP service-acct key', severity: 'block',
	  re: /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g },

	// Code-only matchers (require explicit opt-in). These hit
	// example/documentation strings in plain prose too often to be
	// default-on.
	{ id: 'env_assignment',  label: 'Env-style assignment of a long string', severity: 'warn', codeOnly: true,
	  re: /^[A-Z][A-Z0-9_]{2,}=["']?[A-Za-z0-9_\-+/=]{20,}["']?$/gm },
	{ id: 'bearer_header',   label: 'Bearer Authorization header',           severity: 'warn', codeOnly: true,
	  re: /\bAuthorization:\s*Bearer\s+[A-Za-z0-9._\-+/=]{16,}\b/gi }
];

function luhnValid(digits) {
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let n = Number(digits[i]);
		if (alt) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		sum += n;
		alt = !alt;
	}
	return sum > 0 && sum % 10 === 0;
}

/**
 * Scan prompt text for sensitive content.
 * @param {string} text - the composer text (never persisted by this function)
 * @param {object} options
 * @param {boolean} options.codeMode - include code-only patterns
 * @returns {{findings: Array<{id, label, severity, count}>, maxSeverity: string}}
 *   Per-pattern hit count, with severity bucketed. NO matched substrings
 *   are returned -- the caller gets only the category and the count.
 */
function scanForSensitiveContent(text, options = {}) {
	const result = { findings: [], maxSeverity: 'none' };
	if (typeof text !== 'string' || text.length === 0) return result;
	const codeMode = !!options.codeMode;
	const sevRank = { none: 0, info: 1, warn: 2, block: 3 };
	for (const p of PATTERNS) {
		if (p.codeOnly && !codeMode) continue;
		// Re-create the regex per pattern because .test/.exec on a /g regex
		// mutates lastIndex. We use match() with a fresh RegExp.
		const re = new RegExp(p.re.source, p.re.flags);
		const matches = text.match(re);
		if (!matches || matches.length === 0) continue;
		let count = matches.length;
		// Luhn-validate credit-card-shaped strings to cut false positives
		// from arbitrary 16-digit numbers (order IDs, etc.).
		if (p.luhn) {
			let valid = 0;
			for (const m of matches) {
				const digits = m.replace(/\D/g, '');
				if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) valid++;
			}
			if (valid === 0) continue;
			count = valid;
		}
		result.findings.push({ id: p.id, label: p.label, severity: p.severity, count });
		if (sevRank[p.severity] > sevRank[result.maxSeverity]) result.maxSeverity = p.severity;
	}
	return result;
}

export { scanForSensitiveContent };
