// bg-components/context-bloat.js
// Estimate whether the user's current session is "bloated" -- carrying so
// much accumulated conversation context that each new message is mostly
// re-sending old history rather than adding value. When that happens, a
// fresh chat is usually cheaper and more focused.
//
// Pure function with no I/O; the caller passes in the recent turns for the
// session and gets back a structured signal that smart_ui can render.

const DEFAULT_BLOAT_THRESHOLD_TOKENS = 30_000;
const DEFAULT_MIN_TURNS = 4;
// If the last few turns have grown the prompt by less than this fraction of
// the prompt itself, the session is mostly re-sending old context.
const DEFAULT_LOW_DELTA_RATIO = 0.05;
const DEFAULT_DELTA_LOOKBACK = 3;

/**
 * Analyse a session's recent turns for context-bloat.
 * @param {Array<{ts:number, inputTokens:number}>} turns - turns for the same session, ordered or not
 * @param {object} [opts]
 * @returns {{
 *   bloated: boolean,
 *   reason: string|null,
 *   sessionTokens: number,    // approximate current context size
 *   recentDeltaRatio: number, // 0..1; lower means more re-sending of old context
 *   turnCount: number,
 *   threshold: number
 * }}
 */
function analyseContextBloat(turns, opts = {}) {
	const threshold = opts.thresholdTokens || DEFAULT_BLOAT_THRESHOLD_TOKENS;
	const minTurns = opts.minTurns || DEFAULT_MIN_TURNS;
	const lowDeltaRatio = opts.lowDeltaRatio ?? DEFAULT_LOW_DELTA_RATIO;
	const lookback = opts.deltaLookback || DEFAULT_DELTA_LOOKBACK;

	const empty = {
		bloated: false,
		reason: null,
		sessionTokens: 0,
		recentDeltaRatio: 1,
		turnCount: 0,
		threshold
	};
	if (!Array.isArray(turns) || turns.length < minTurns) return empty;

	// Sort by timestamp; cheap on a few dozen rows.
	const sorted = turns
		.filter(t => t && typeof t.inputTokens === 'number')
		.sort((a, b) => (a.ts || 0) - (b.ts || 0));
	if (sorted.length < minTurns) return empty;

	// Approximate the current conversation size as the maximum inputTokens
	// observed across this session's turns. Most providers' "input tokens"
	// metric INCLUDES the conversation history sent with the new message,
	// so the running max is a usable proxy for accumulated context.
	let sessionTokens = 0;
	for (const t of sorted) if (t.inputTokens > sessionTokens) sessionTokens = t.inputTokens;

	if (sessionTokens < threshold) return { ...empty, sessionTokens, turnCount: sorted.length };

	// Compute the average per-turn delta over the last N turns. If those
	// deltas are small relative to the running prompt size, the user is
	// mostly paying for re-tokenized history.
	const recent = sorted.slice(-Math.min(lookback + 1, sorted.length));
	let deltaSum = 0;
	let deltaCount = 0;
	for (let i = 1; i < recent.length; i++) {
		const d = Math.max(0, recent[i].inputTokens - recent[i - 1].inputTokens);
		deltaSum += d;
		deltaCount += 1;
	}
	const avgDelta = deltaCount > 0 ? deltaSum / deltaCount : 0;
	const ratio = sessionTokens > 0 ? avgDelta / sessionTokens : 1;

	const bloated = ratio < lowDeltaRatio;
	const reason = bloated
		? `Session has ~${Math.round(sessionTokens / 1000)}k tokens of context but recent messages add only ~${Math.round(ratio * 100)}%. A new chat would be cheaper.`
		: null;

	return {
		bloated,
		reason,
		sessionTokens,
		recentDeltaRatio: Math.round(ratio * 1000) / 1000,
		turnCount: sorted.length,
		threshold
	};
}

export { analyseContextBloat };
