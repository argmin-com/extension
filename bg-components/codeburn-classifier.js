// bg-components/codeburn-classifier.js
// 13-category activity classifier inspired by getagentseal/codeburn.
// Extends the narrower task-classifier.js with codeburn's richer taxonomy so
// the dashboard can surface per-activity cost, one-shot rate, and waste patterns.
// No LLM calls. Fully deterministic pattern matching, adapted for browser chats.

const CODEBURN_CATEGORIES = [
	'coding', 'debugging', 'feature_dev', 'refactoring', 'testing',
	'exploration', 'planning', 'delegation', 'git_ops', 'build_deploy',
	'brainstorming', 'conversation', 'general'
];

const CATEGORY_LABELS = {
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
const CATEGORY_SIGNALS = {
	coding: {
		keywords: ['code', 'implement', 'function', 'class', 'method', 'variable', 'loop', 'array', 'object', 'api', 'endpoint', 'component', 'module', 'import', 'export'],
		patterns: [/```[\s\S]+?```/, /\bfunction\s+\w+\s*\(/, /\bclass\s+\w+/, /\bdef\s+\w+\s*\(/, /\bconst\s+\w+\s*=/, /\blet\s+\w+\s*=/, /=>\s*[\{\(]/, /\bimport\s+.+\s+from\s+/],
		weight: 3
	},
	debugging: {
		keywords: ['debug', 'fix', 'broken', 'crash', 'failing', 'wrong', 'issue', 'not working', 'unexpected', 'throws', 'stacktrace', 'stack trace', 'why does', 'what\'s wrong'],
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
