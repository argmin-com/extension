// bg-components/codeburn-classifier.js
// 13-category activity classifier inspired by getagentseal/codeburn.
// Extends the narrower task-classifier.js with codeburn's richer taxonomy so
// the dashboard can surface per-activity cost, one-shot rate, and waste patterns.
// No LLM calls. Fully deterministic pattern matching, adapted for browser chats.

const CODEBURN_CATEGORIES = [
	'writing', 'summarization', 'translation', 'research', 'learning',
	'creative', 'data_analysis',
	'coding', 'debugging', 'feature_dev', 'refactoring', 'testing',
	'exploration', 'planning', 'delegation', 'git_ops', 'build_deploy',
	'brainstorming', 'conversation', 'general'
];

const CATEGORY_LABELS = {
	writing: 'Writing',
	summarization: 'Summarization',
	translation: 'Translation',
	research: 'Research',
	learning: 'Learning',
	creative: 'Creative',
	data_analysis: 'Data Analysis',
	coding: 'Coding',
	debugging: 'Debugging',
	feature_dev: 'Feature Dev',
	refactoring: 'Refactoring',
	testing: 'Testing',
	exploration: 'Exploration',
	planning: 'Planning',
	delegation: 'Delegation',
	git_ops: 'Git Ops',
	build_deploy: 'Build/Deploy',
	brainstorming: 'Brainstorming',
	conversation: 'Conversation',
	general: 'General'
};

// Category signals. Each uses a combination of keywords, regex, and structural hints.
// Scoring is additive. The highest non-zero score wins; ties break by declaration order.
//
// Multilingual: keywords arrays include non-English equivalents for the
// highest-volume consumer categories (writing, summarization,
// translation, research, learning, debugging). Coverage is intentionally
// conservative -- only words that are highly diagnostic of the intent
// across languages, to avoid false positives on common nouns. Languages:
// French, Spanish, German, Portuguese, Italian, plus CJK where helpful.
const CATEGORY_SIGNALS = {
	writing: {
		keywords: [
			'draft', 'email', 'letter', 'memo', 'reply to', 'response to', 'rewrite', 'reword', 'paraphrase', 'rephrase', 'polish', 'proofread', 'edit this', 'tone of', 'sound professional', 'sound friendly', 'shorter version', 'longer version', 'cover letter', 'subject line',
			// French
			'rédiger', 'rédige', 'brouillon', 'courriel', 'répondre à', 'reformuler',
			// Spanish
			'redactar', 'borrador', 'correo electrónico', 'responder a', 'reformular',
			// German
			'verfassen', 'entwurf', 'e-mail-entwurf', 'antworten auf', 'umformulieren',
			// Portuguese
			'redigir', 'rascunho', 'responder a', 'reformular',
			// Italian
			'redigere', 'bozza', 'rispondere a', 'riformulare'
		],
		patterns: [
			/\b(write|draft|compose|pen)\s+(an?\s+|the\s+|me\s+(an?\s+)?)?(email|letter|memo|note|message|response|reply|post|article|blog|essay|paragraph|caption|tweet|dm|invite|announcement)\b/i,
			/\breply\s+to\s+(this|the|my|that)/i,
			/\bmake\s+(this|it)\s+(sound|read|feel)\s+(more|less)\b/i,
			// French / Spanish / Italian: "écrire un email", "escribir un correo", "scrivere una email"
			/\b(écri(re|s)|escrib(ir|e)|scriv(ere|i))\s+(une?|un|una)\s+(email|courriel|correo|messaggio|lettre|carta|lettera)/i,
			// Japanese: メールを書く / メール文 / 返信を作成
			/メール(を|の|文)/,
			/返信(を|の)?\s*(作成|書|下書き)/
		],
		weight: 4
	},
	summarization: {
		keywords: [
			'summarize', 'summarise', 'summary', 'tldr', 'tl;dr', 'condense', 'shorten this', 'key points', 'key takeaways', 'main points', 'main ideas', 'gist', 'bullet points', 'briefly explain', 'in brief', 'in a nutshell', 'recap',
			// French
			'résumer', 'résume', 'résumé', 'en bref', 'points clés', 'idées principales',
			// Spanish
			'resumir', 'resumen', 'puntos clave', 'ideas principales',
			// German
			'zusammenfassen', 'zusammenfassung', 'kernpunkte',
			// Portuguese
			'resuma', 'resumir', 'resumo', 'pontos principais',
			// Italian
			'riassumere', 'riassumi', 'riassunto', 'punti chiave'
		],
		patterns: [
			/\bsummari[sz]e\b/i, /\btl;?dr\b/i, /\bin\s+a\s+nutshell\b/i, /\bkey\s+(points|takeaways|ideas)\b/i,
			// Japanese: 要約 / 要点 / まとめ
			/要約/,
			/まとめ(て|る|を)/
		],
		weight: 4
	},
	translation: {
		keywords: [
			'translate', 'translation', 'in spanish', 'in french', 'in german', 'in japanese', 'in chinese', 'in portuguese', 'in italian', 'in korean', 'in hindi', 'in arabic', 'in russian', 'in dutch', 'in swedish', 'into english', 'to english',
			// Native-language requests to translate
			'traduire', 'traduisez', 'traduction',  // French
			'traducir', 'traduce', 'traducción',     // Spanish
			'übersetzen', 'übersetze', 'übersetzung',// German
			'traduzir', 'traduza', 'tradução',        // Portuguese
			'tradurre', 'traduci', 'traduzione',     // Italian
			'翻訳',                                    // Japanese
			'번역',                                    // Korean
			'翻译'                                     // Chinese (Simplified)
		],
		patterns: [
			/\btranslate\s+(this|that|the\s+following|to|into|from)\b/i,
			/\b(in|into|to)\s+(spanish|french|german|japanese|chinese|portuguese|italian|korean|hindi|arabic|russian|dutch|swedish|polish|turkish|vietnamese)\b/i
		],
		weight: 5
	},
	research: {
		keywords: ['research', 'find out', 'tell me about', 'history of', 'background on', 'overview of', 'sources for', 'citation', 'reference for', 'evidence', 'studies on', 'what does the data say'],
		patterns: [
			/\bwho\s+(is|was|are|were|founded|invented|discovered)\b/i,
			/\bwhen\s+(did|was|were|will)\b/i,
			/\bhistory\s+of\b/i,
			/\bbackground\s+on\b/i
		],
		weight: 2
	},
	learning: {
		keywords: ['teach me', 'tutor me', 'eli5', 'beginner', 'introduction to', 'intro to', 'concept of', 'study guide', 'help me understand', 'help me learn', 'walk me through', 'difference between'],
		patterns: [
			/\beli5\b/i,
			/\bexplain\s+like\s+I'?m\b/i,
			/\b(teach|tutor)\s+me\b/i,
			/\bintroduction\s+to\b/i,
			/\bdifference\s+between\b/i
		],
		weight: 2
	},
	creative: {
		keywords: ['poem', 'haiku', 'sonnet', 'story', 'short story', 'novel', 'fiction', 'character arc', 'plot', 'screenplay', 'script for', 'lyrics', 'song about', 'joke', 'jokes', 'limerick', 'fairy tale'],
		patterns: [
			/\bwrite\s+(a|me|me\s+a)\s+(poem|story|song|joke|haiku|sonnet|limerick|fairy\s+tale|screenplay)\b/i,
			/\b(funny|witty|humorous)\s+\w+\s+about\b/i
		],
		weight: 3
	},
	data_analysis: {
		keywords: ['csv', 'spreadsheet', 'excel', 'google sheet', 'dataset', 'data set', 'chart', 'graph', 'visualization', 'visualisation', 'pivot table', 'pivot', 'sql query', 'sum of', 'average of', 'mean of', 'median', 'correlation', 'regression', 'statistics', 'distribution', 'histogram'],
		patterns: [
			/\banalyze\s+(this\s+|the\s+)?(data|dataset|table|csv|spreadsheet|numbers)\b/i,
			/\bplot\s+(this|the|a)\b/i,
			/\bgroup\s+by\b/i,
			/\bselect\s+.+\s+from\s+/i
		],
		weight: 3
	},
	coding: {
		keywords: ['code', 'implement', 'function', 'class', 'method', 'variable', 'loop', 'array', 'object', 'api', 'endpoint', 'component', 'module', 'import', 'export'],
		patterns: [/```[\s\S]+?```/, /\bfunction\s+\w+\s*\(/, /\bclass\s+\w+/, /\bdef\s+\w+\s*\(/, /\bconst\s+\w+\s*=/, /\blet\s+\w+\s*=/, /=>\s*[\{\(]/, /\bimport\s+.+\s+from\s+/],
		weight: 3
	},
	debugging: {
		keywords: [
			'debug', 'fix', 'broken', 'crash', 'failing', 'wrong', 'issue', 'not working', 'unexpected', 'throws', 'stacktrace', 'stack trace', 'why does', 'what\'s wrong',
			// Non-English bug-report verbs / nouns
			'corriger', 'erreur', 'bug', 'planter',                // French
			'corregir', 'fallar', 'roto',                          // Spanish
			'beheben', 'fehler', 'kaputt', 'abstürzen',       // German
			'corrigir', 'quebrado',                                 // Portuguese
			'correggere', 'errore', 'rotto'                         // Italian
		],
		patterns: [/\berror:?\s/i, /traceback/i, /\bexception\b/i, /undefined is not/i, /cannot read property/i, /NullPointer/i, /segmentation fault/i, /syntax\s*error/i],
		weight: 4
	},
	feature_dev: {
		keywords: ['add', 'create', 'build', 'implement', 'new feature', 'make a', 'introduce', 'support for', 'extend', 'scaffold'],
		patterns: [/\b(add|create|build|implement)\s+(a|an|the)\s+\w+/i],
		weight: 2
	},
	refactoring: {
		keywords: ['refactor', 'rename', 'simplify', 'clean up', 'cleanup', 'restructure', 'reorganize', 'dry up', 'extract', 'decouple', 'split into', 'combine'],
		patterns: [/\brefactor(ing)?\b/i, /\brename\s+\w+\s+to\s+\w+/i],
		weight: 3
	},
	testing: {
		keywords: ['test', 'unit test', 'integration test', 'spec', 'assertion', 'coverage', 'mock', 'stub', 'fixture', 'pytest', 'vitest', 'jest', 'mocha', 'jasmine', 'rspec', 'junit'],
		patterns: [/\b(describe|it|test)\s*\(\s*['"]/, /\bexpect\s*\(.+\)\.\w+/, /\bassert[A-Z]\w+\s*\(/],
		weight: 3
	},
	exploration: {
		keywords: ['how does', 'what is', 'explain', 'walk me through', 'understand', 'tell me about', 'where is', 'find', 'search for', 'look at', 'inspect', 'show me'],
		patterns: [/^(how|what|where|when|why)\b/i],
		weight: 2
	},
	planning: {
		keywords: ['plan', 'design', 'architect', 'architecture', 'outline', 'roadmap', 'steps', 'approach', 'strategy', 'break down', 'decompose', 'todo', 'task list'],
		patterns: [/\bplan\s+(for|to|the)\b/i, /\bstep-?by-?step\b/i],
		weight: 2
	},
	delegation: {
		keywords: ['subagent', 'sub-agent', 'agent', 'delegate', 'dispatch', 'spawn', 'parallelize', 'in parallel', 'fan out'],
		patterns: [/\bagent\s+tool\b/i, /\bdispatch[-_]agent\b/i],
		weight: 3
	},
	git_ops: {
		keywords: ['git', 'commit', 'push', 'pull', 'merge', 'rebase', 'branch', 'checkout', 'diff', 'stash', 'cherry-pick', 'pull request', 'pr ', 'github', 'gitlab'],
		patterns: [/\bgit\s+(status|add|commit|push|pull|merge|rebase|log|diff|branch|checkout|stash|fetch)\b/i],
		weight: 3
	},
	build_deploy: {
		keywords: ['build', 'deploy', 'ship', 'release', 'docker', 'kubernetes', 'k8s', 'ci/cd', 'pipeline', 'pm2', 'nginx', 'production', 'staging', 'terraform', 'ansible', 'helm'],
		patterns: [/\bnpm\s+(run\s+)?build\b/i, /\bdocker\s+(build|run|compose)\b/i, /\byarn\s+build\b/i, /\bpm2\s+\w+/i],
		weight: 3
	},
	brainstorming: {
		keywords: ['brainstorm', 'ideas', 'what if', 'possibilities', 'options', 'alternatives', 'pros and cons', 'tradeoffs', 'should i', 'opinions', 'thoughts on'],
		patterns: [/\bwhat\s+if\b/i, /\bshould\s+I\b/i, /\bpros\s+and\s+cons\b/i],
		weight: 2
	},
	conversation: {
		keywords: ['thanks', 'thank you', 'hello', 'hi ', 'hey', 'please', 'ok', 'okay', 'got it', 'cool', 'nice', 'lol'],
		patterns: [],
		weight: 1
	},
	general: {
		keywords: [],
		patterns: [],
		weight: 0
	}
};

function classifyCodeburn(promptText, context = {}) {
	if (!promptText || typeof promptText !== 'string' || promptText.trim().length === 0) {
		return { category: 'conversation', label: CATEGORY_LABELS.conversation, confidence: 0.3, scores: {} };
	}

	const trimmed = promptText.trim();
	const lower = trimmed.toLowerCase();
	const scores = {};
	const hits = {};

	const hasCodeFence = /```/.test(trimmed);
	const isShort = trimmed.length < 60;
	const hasQuestion = /\?\s*$/.test(trimmed.split('\n').pop() || '');

	for (const category of CODEBURN_CATEGORIES) {
		const sig = CATEGORY_SIGNALS[category];
		if (!sig) continue;
		let score = 0;
		const matched = [];

		for (const kw of sig.keywords || []) {
			if (lower.includes(kw)) {
				score += sig.weight;
				matched.push(`kw:${kw}`);
			}
		}
		for (const re of sig.patterns || []) {
			if (re.test(trimmed)) {
				score += sig.weight + 1;
				matched.push(`rx:${re.source.slice(0, 20)}`);
			}
		}

		if (score > 0) {
			scores[category] = score;
			hits[category] = matched.slice(0, 4);
		}
	}

	// Structural boosts
	if (hasCodeFence) {
		scores.coding = (scores.coding || 0) + 5;
		(hits.coding ||= []).push('code_fence');
	}
	if (hasQuestion && isShort) {
		scores.exploration = (scores.exploration || 0) + 2;
	}
	if (context.isRetry || /again|retry|try\s+again|still\s+(wrong|broken|failing)/i.test(lower)) {
		scores.debugging = (scores.debugging || 0) + 3;
	}

	// Short no-signal prompts default to conversation
	if (isShort && Object.keys(scores).length === 0) {
		return { category: 'conversation', label: CATEGORY_LABELS.conversation, confidence: 0.5, scores: {} };
	}

	// No signals at all -> general
	if (Object.keys(scores).length === 0) {
		return { category: 'general', label: CATEGORY_LABELS.general, confidence: 0.4, scores: {} };
	}

	const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
	const [top, topScore] = sorted[0];
	const secondScore = sorted[1]?.[1] || 0;
	const confidence = Math.min(0.95, 0.45 + (topScore - secondScore) * 0.04 + topScore * 0.02);

	return {
		category: top,
		label: CATEGORY_LABELS[top] || top,
		confidence: Math.round(confidence * 100) / 100,
		scores,
		hits: hits[top] || []
	};
}

// Activity suitability matrix. Used by Optimize + Compare to flag overpowered
// model choices per task type. Based on codeburn's observations about where
// cheap models hold up vs. where expensive reasoning genuinely helps.
const ACTIVITY_MODEL_FIT = {
	writing:       { cheap: 0.7,  medium: 0.9,  expensive: 0.8 },
	summarization: { cheap: 0.8,  medium: 0.9,  expensive: 0.7 },
	translation:   { cheap: 0.65, medium: 0.85, expensive: 0.85 },
	research:      { cheap: 0.5,  medium: 0.75, expensive: 0.9 },
	learning:      { cheap: 0.7,  medium: 0.85, expensive: 0.85 },
	creative:      { cheap: 0.55, medium: 0.8,  expensive: 0.9 },
	data_analysis: { cheap: 0.45, medium: 0.75, expensive: 0.9 },
	coding:        { cheap: 0.4, medium: 0.85, expensive: 0.9 },
	debugging:     { cheap: 0.35, medium: 0.8,  expensive: 0.85 },
	feature_dev:   { cheap: 0.4, medium: 0.85, expensive: 0.85 },
	refactoring:   { cheap: 0.5, medium: 0.8,  expensive: 0.8 },
	testing:       { cheap: 0.55, medium: 0.8, expensive: 0.75 },
	exploration:   { cheap: 0.75, medium: 0.8, expensive: 0.7 },
	planning:      { cheap: 0.45, medium: 0.75, expensive: 0.9 },
	delegation:    { cheap: 0.5, medium: 0.75, expensive: 0.85 },
	git_ops:       { cheap: 0.85, medium: 0.75, expensive: 0.5 },
	build_deploy:  { cheap: 0.7,  medium: 0.8, expensive: 0.65 },
	brainstorming: { cheap: 0.7,  medium: 0.8, expensive: 0.75 },
	conversation:  { cheap: 0.95, medium: 0.6, expensive: 0.25 },
	general:       { cheap: 0.7,  medium: 0.7, expensive: 0.5 }
};

function getActivityModelFit(category) {
	return ACTIVITY_MODEL_FIT[category] || ACTIVITY_MODEL_FIT.general;
}

export {
	classifyCodeburn,
	CODEBURN_CATEGORIES,
	CATEGORY_LABELS,
	ACTIVITY_MODEL_FIT,
	getActivityModelFit
};
