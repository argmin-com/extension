// bg-components/task-classifier.js
// Classify prompts into task families using local heuristics.
// No external calls. No ML. Fast pattern matching.

// Task families recognized at typing time. Mirrors the post-turn
// codeburn-classifier categories so the Smart-UI decision panel and the
// Activity Breakdown agree on what "kind of work" a prompt represents.
// When adding here, mirror in codeburn-classifier (and vice versa) so the
// Optimize/Compare model-fit recommendations stay consistent.
const TASK_SIGNALS = {
	coding: {
		patterns: [/```[\s\S]*```/, /function\s+\w+/, /class\s+\w+/, /import\s+/, /const\s+\w+\s*=/, /def\s+\w+/, /return\s+/],
		keywords: ['code', 'implement', 'function', 'script', 'program', 'compile', 'syntax', 'bug', 'error', 'fix', 'refactor']
	},
	debugging: {
		patterns: [/error:?\s/i, /traceback/i, /exception/i, /stack\s*trace/i, /undefined is not/i],
		keywords: ['debug', 'fix', 'broken', 'crash', 'failing', 'error', 'wrong', 'issue', 'not working']
	},
	writing: {
		patterns: [
			/\b(write|draft|compose|pen)\s+(an?\s+|the\s+|me\s+(an?\s+)?)?(email|letter|memo|note|message|response|reply|post|article|blog|essay|paragraph|caption|tweet|dm|invite|announcement)\b/i,
			/\breply\s+to\s+(this|the|my|that)/i,
			/\bmake\s+(this|it)\s+(sound|read|feel)\s+(more|less)\b/i,
			// Non-English mirror of the codeburn-classifier patterns
			/\b(écri(re|s)|escrib(ir|e)|scriv(ere|i))\s+(une?|un|una)\s+(email|courriel|correo|messaggio|lettre|carta|lettera)/i,
			/メール(を|の|文)/,
			/返信(を|の)?\s*(作成|書|下書き)/
		],
		keywords: [
			'draft', 'email', 'letter', 'memo', 'reply to', 'response to', 'rewrite', 'reword', 'paraphrase', 'rephrase', 'polish', 'proofread', 'edit this', 'tone of', 'sound professional', 'sound friendly', 'cover letter', 'subject line',
			'rédiger', 'brouillon', 'courriel', 'répondre à', 'reformuler',
			'redactar', 'borrador', 'correo electrónico', 'responder a',
			'verfassen', 'entwurf', 'antworten auf',
			'redigir', 'rascunho', 'responder a',
			'redigere', 'bozza', 'rispondere a'
		]
	},
	summarization: {
		patterns: [
			/\bsummari[sz]e\b/i, /\btl;?dr\b/i, /\bin\s+a\s+nutshell\b/i, /\bkey\s+(points|takeaways|ideas)\b/i,
			/要約/, /まとめ(て|る|を)/
		],
		keywords: [
			'summarize', 'summary', 'tldr', 'brief', 'condense', 'key points', 'main ideas', 'overview', 'gist', 'recap',
			'résumer', 'résumé', 'points clés',
			'resumir', 'resumen', 'puntos clave',
			'zusammenfassen', 'zusammenfassung',
			'resuma', 'resumir', 'resumo',
			'riassumere', 'riassunto'
		]
	},
	translation: {
		patterns: [
			/\btranslate\s+(this|that|the\s+following|to|into|from)\b/i,
			/\b(in|into|to)\s+(spanish|french|german|japanese|chinese|portuguese|italian|korean|hindi|arabic|russian|dutch|swedish|polish|turkish|vietnamese)\b/i
		],
		keywords: [
			'translate', 'translation',
			'traduire', 'traduisez', 'traduction',
			'traducir', 'traduce', 'traducción',
			'übersetzen', 'übersetze', 'übersetzung',
			'traduzir', 'traduza', 'tradução',
			'tradurre', 'traduci', 'traduzione',
			'翻訳', '번역', '翻译'
		]
	},
	research: {
		patterns: [
			/\bwho\s+(is|was|are|were|founded|invented|discovered)\b/i,
			/\bwhen\s+(did|was|were|will)\b/i,
			/\bhistory\s+of\b/i,
			/\bbackground\s+on\b/i
		],
		keywords: ['research', 'find out', 'tell me about', 'history of', 'background on', 'sources for', 'citation']
	},
	learning: {
		patterns: [
			/\beli5\b/i,
			/\bexplain\s+like\s+I'?m\b/i,
			/\b(teach|tutor)\s+me\b/i,
			/\bintroduction\s+to\b/i,
			/\bdifference\s+between\b/i
		],
		keywords: ['teach me', 'tutor me', 'eli5', 'beginner', 'introduction to', 'intro to', 'concept of', 'help me understand', 'help me learn', 'walk me through']
	},
	data_analysis: {
		patterns: [
			/\banalyze\s+(this\s+|the\s+)?(data|dataset|table|csv|spreadsheet|numbers)\b/i,
			/\bplot\s+(this|the|a)\b/i,
			/\bgroup\s+by\b/i,
			/\bselect\s+.+\s+from\s+/i
		],
		keywords: ['csv', 'spreadsheet', 'excel', 'dataset', 'pivot table', 'sql query', 'sum of', 'average of', 'mean of', 'median', 'correlation', 'regression', 'distribution', 'histogram']
	},
	extraction: {
		keywords: ['extract', 'pull out', 'find all', 'list all', 'identify', 'parse', 'get the']
	},
	analysis: {
		keywords: ['analyze', 'compare', 'evaluate', 'assess', 'critique', 'review', 'pros and cons', 'tradeoff']
	},
	creative: {
		patterns: [/\bwrite\s+(a|me|me\s+a)\s+(poem|story|song|joke|haiku|sonnet|limerick|fairy\s+tale|screenplay)\b/i],
		keywords: ['write a story', 'poem', 'haiku', 'sonnet', 'creative', 'narrative', 'fiction', 'imagine', 'tone', 'style', 'voice', 'joke', 'limerick']
	},
	brainstorming: {
		keywords: ['brainstorm', 'ideas', 'suggest', 'what if', 'possibilities', 'options', 'alternatives']
	},
	transformation: {
		keywords: ['rewrite', 'convert', 'rephrase', 'transform', 'format', 'restructure']
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

// Task-to-model suitability prior. Mirrors codeburn-classifier's
// ACTIVITY_MODEL_FIT for the categories that exist in both (writing,
// summarization, translation, research, learning, creative,
// data_analysis), so the typing-time recommendation and the post-turn
// retrospective agree on which model tier is overpowered or under-served.
const TASK_MODEL_FIT = {
	chat:             { cheap: 0.9, medium: 0.7, expensive: 0.3 },
	writing:          { cheap: 0.7, medium: 0.9, expensive: 0.8 },
	summarization:    { cheap: 0.8, medium: 0.9, expensive: 0.7 },
	translation:      { cheap: 0.65, medium: 0.85, expensive: 0.85 },
	research:         { cheap: 0.5, medium: 0.75, expensive: 0.9 },
	learning:         { cheap: 0.7, medium: 0.85, expensive: 0.85 },
	data_analysis:    { cheap: 0.45, medium: 0.75, expensive: 0.9 },
	extraction:       { cheap: 0.8, medium: 0.5, expensive: 0.1 },
	transformation:   { cheap: 0.7, medium: 0.7, expensive: 0.3 },
	brainstorming:    { cheap: 0.6, medium: 0.8, expensive: 0.5 },
	coding:           { cheap: 0.3, medium: 0.8, expensive: 0.8 },
	debugging:        { cheap: 0.3, medium: 0.8, expensive: 0.7 },
	analysis:         { cheap: 0.3, medium: 0.7, expensive: 0.9 },
	creative:         { cheap: 0.55, medium: 0.8, expensive: 0.9 },
	long_context_qa:  { cheap: 0.4, medium: 0.7, expensive: 0.9 }
};

function getTaskModelFit(taskClass) {
	return TASK_MODEL_FIT[taskClass] || TASK_MODEL_FIT.chat;
}

export { classifyTask, getTaskModelFit, TASK_MODEL_FIT };
