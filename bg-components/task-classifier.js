// bg-components/task-classifier.js
// Classify prompts into task families using local heuristics.
// No external calls. No ML. Fast pattern matching.

const TASK_SIGNALS = {
	coding: {
		patterns: [/```[\s\S]*```/, /function\s+\w+/, /class\s+\w+/, /import\s+/, /const\s+\w+\s*=/, /def\s+\w+/, /return\s+/],
		keywords: ['code', 'implement', 'function', 'script', 'program', 'compile', 'syntax', 'bug', 'error', 'fix', 'refactor']
	},
	debugging: {
		patterns: [/error:?\s/i, /traceback/i, /exception/i, /stack\s*trace/i, /undefined is not/i],
		keywords: ['debug', 'fix', 'broken', 'crash', 'failing', 'error', 'wrong', 'issue', 'not working']
	},
	summarization: {
		keywords: ['summarize', 'summary', 'tldr', 'brief', 'condense', 'key points', 'main ideas', 'overview']
	},
	extraction: {
		keywords: ['extract', 'pull out', 'find all', 'list all', 'identify', 'parse', 'get the']
	},
	analysis: {
		keywords: ['analyze', 'compare', 'evaluate', 'assess', 'critique', 'review', 'pros and cons', 'tradeoff']
	},
	creative: {
		keywords: ['write a story', 'poem', 'creative', 'narrative', 'fiction', 'imagine', 'tone', 'style', 'voice']
	},
	brainstorming: {
		keywords: ['brainstorm', 'ideas', 'suggest', 'what if', 'possibilities', 'options', 'alternatives']
	},
	transformation: {
		keywords: ['rewrite', 'convert', 'translate', 'rephrase', 'transform', 'format', 'restructure']
	},
	long_context_qa: {
		signals: ['hasLongQuotedContent']
	},
	chat: {
		signals: ['isShort', 'noSpecialPatterns']
	}
};

function classifyTask(promptText, conversationContext = {}) {
	if (!promptText || promptText.length < 5) {
		return { taskClass: 'chat', confidence: 0.5, signals: ['too_short'] };
	}

	const lower = promptText.toLowerCase();
	const scores = {};
	const detectedSignals = [];

	// Structural signals
	const hasCodeFences = /```/.test(promptText);
	const hasLongQuotedContent = (promptText.match(/["'`]{3}[\s\S]{500,}/g) || []).length > 0 || promptText.length > 3000;
	const isShort = promptText.length < 100;
	const wordCount = promptText.split(/\s+/).length;

	if (hasCodeFences) detectedSignals.push('code_fences');
	if (hasLongQuotedContent) detectedSignals.push('long_quoted_content');
	if (isShort) detectedSignals.push('short_prompt');

	for (const [taskClass, config] of Object.entries(TASK_SIGNALS)) {
		let score = 0;

		// Pattern matching
		if (config.patterns) {
			for (const pattern of config.patterns) {
				if (pattern.test(promptText)) { score += 2; detectedSignals.push(`pattern:${taskClass}`); }
			}
		}

		// Keyword matching
		if (config.keywords) {
			for (const kw of config.keywords) {
				if (lower.includes(kw)) { score += 3; detectedSignals.push(`keyword:${kw}`); }
			}
		}

		// Structural signal matching
		if (config.signals) {
			if (config.signals.includes('hasLongQuotedContent') && hasLongQuotedContent) score += 4;
			if (config.signals.includes('isShort') && isShort && !hasCodeFences) score += 2;
			if (config.signals.includes('noSpecialPatterns') && Object.keys(scores).length === 0) score += 1;
		}

		if (score > 0) scores[taskClass] = score;
	}

	// Boost coding if code fences present
	if (hasCodeFences) scores.coding = (scores.coding || 0) + 5;

	// Default to chat if nothing matched
	if (Object.keys(scores).length === 0) {
		return { taskClass: 'chat', confidence: 0.4, signals: ['no_strong_signals'] };
	}

	// Pick highest scoring class
	const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
	const [topClass, topScore] = sorted[0];
	const secondScore = sorted.length > 1 ? sorted[1][1] : 0;
	const confidence = Math.min(0.95, 0.4 + (topScore - secondScore) * 0.05 + topScore * 0.03);

	return {
		taskClass: topClass,
		confidence: Math.round(confidence * 100) / 100,
		signals: [...new Set(detectedSignals)].slice(0, 8)
	};
}

// Task-to-model suitability prior
const TASK_MODEL_FIT = {
	chat:             { cheap: 0.9, medium: 0.7, expensive: 0.3 },
	summarization:    { cheap: 0.8, medium: 0.6, expensive: 0.2 },
	extraction:       { cheap: 0.8, medium: 0.5, expensive: 0.1 },
	transformation:   { cheap: 0.7, medium: 0.7, expensive: 0.3 },
	brainstorming:    { cheap: 0.6, medium: 0.8, expensive: 0.5 },
	coding:           { cheap: 0.3, medium: 0.8, expensive: 0.8 },
	debugging:        { cheap: 0.3, medium: 0.8, expensive: 0.7 },
	analysis:         { cheap: 0.3, medium: 0.7, expensive: 0.9 },
	creative:         { cheap: 0.4, medium: 0.7, expensive: 0.8 },
	long_context_qa:  { cheap: 0.4, medium: 0.7, expensive: 0.9 }
};

function getTaskModelFit(taskClass) {
	return TASK_MODEL_FIT[taskClass] || TASK_MODEL_FIT.chat;
}

export { classifyTask, getTaskModelFit, TASK_MODEL_FIT };
