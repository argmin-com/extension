// bg-components/platforms/intercept-patterns.js
// URL patterns for webRequest interception per platform

export const PLATFORM_INTERCEPT_PATTERNS = {
	claude: {
		onBeforeRequest: {
			urls: [
				"*://claude.ai/api/organizations/*/completion",
				"*://claude.ai/api/organizations/*/retry_completion",
				"*://claude.ai/api/settings/billing*"
			],
			regexes: [
				"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/completion$",
				"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*/retry_completion$",
				"^https?://claude\\.ai/api/settings/billing"
			]
		},
		onCompleted: {
			urls: [
				"*://claude.ai/api/organizations/*/chat_conversations/*",
				"*://claude.ai/v1/sessions/*/events"
			],
			regexes: [
				"^https?://claude\\.ai/api/organizations/[^/]*/chat_conversations/[^/]*$",
				"^https?://claude\\.ai/v1/sessions/[^/]*/events$"
			]
		}
	},
	chatgpt: {
		onBeforeRequest: {
			urls: [
				"*://chatgpt.com/backend-api/conversation",
				"*://chatgpt.com/backend-api/conversation?*",
				"*://chatgpt.com/backend-api/conversation/*",
				"*://chatgpt.com/backend-anon/conversation",
				"*://chatgpt.com/backend-anon/conversation?*",
				"*://chatgpt.com/backend-anon/conversation/*",
				"*://chatgpt.com/ces/v1/*",
				"*://chatgpt.com/sentinel/*",
				"*://chat.openai.com/backend-api/conversation",
				"*://chat.openai.com/backend-api/conversation?*",
				"*://chat.openai.com/backend-api/conversation/*"
			],
			regexes: [
				"^https?://(chatgpt\\.com|chat\\.openai\\.com)/backend-(api|anon)/conversation",
				"^https?://chatgpt\\.com/(ces/v1/|sentinel/)"
			]
		},
		onCompleted: {
			urls: [
				"*://chatgpt.com/backend-api/conversation*",
				"*://chatgpt.com/backend-anon/conversation*",
				"*://chatgpt.com/ces/v1/*",
				"*://chatgpt.com/sentinel/*",
				"*://chat.openai.com/backend-api/conversation*"
			],
			regexes: [
				"^https?://(chatgpt\\.com|chat\\.openai\\.com)/backend-(api|anon)/conversation",
				"^https?://chatgpt\\.com/(ces/v1/|sentinel/)"
			]
		}
	},
	gemini: {
		onBeforeRequest: {
			urls: [
				"*://gemini.google.com/_/BardChatUi/data/*",
				"*://gemini.google.com/app/_/*",
				"*://gemini.google.com/u/*/app/_/*",
				"*://gemini.google.com/u/*/app/*"
			],
			regexes: [
				"^https?://gemini\\.google\\.com/(_/BardChatUi/data/|app/_/|u/\\d+/app/_/)",
				"^https?://gemini\\.google\\.com/.*(StreamGenerate|GenerateContent)"
			]
		},
		onCompleted: {
			urls: [
				"*://gemini.google.com/_/BardChatUi/data/*",
				"*://gemini.google.com/app/_/*",
				"*://gemini.google.com/u/*/app/_/*",
				"*://gemini.google.com/u/*/app/*"
			],
			regexes: [
				"^https?://gemini\\.google\\.com/(_/BardChatUi/data/|app/_/|u/\\d+/app/_/)",
				"^https?://gemini\\.google\\.com/.*(StreamGenerate|GenerateContent)"
			]
		}
	},
	mistral: {
		onBeforeRequest: {
			urls: [
				"*://chat.mistral.ai/api/chat*",
				"*://chat.mistral.ai/api/v1/*"
			],
			regexes: [
				"^https?://chat\\.mistral\\.ai/api/(chat|v1/)"
			]
		},
		onCompleted: {
			urls: [
				"*://chat.mistral.ai/api/chat*",
				"*://chat.mistral.ai/api/v1/*"
			],
			regexes: [
				"^https?://chat\\.mistral\\.ai/api/(chat|v1/)"
			]
		}
	}
};

// Merge all platform patterns into unified lists for webRequest registration
export function getAllInterceptUrls(type) {
	const urls = new Set();
	for (const platform of Object.values(PLATFORM_INTERCEPT_PATTERNS)) {
		const patterns = platform[type];
		if (patterns?.urls) patterns.urls.forEach(u => urls.add(u));
	}
	return Array.from(urls);
}

export function detectPlatformFromUrl(url) {
	if (!url) return null;
	for (const [id, patterns] of Object.entries(PLATFORM_INTERCEPT_PATTERNS)) {
		const allUrls = [...(patterns.onBeforeRequest?.urls || []), ...(patterns.onCompleted?.urls || [])];
		for (const pattern of allUrls) {
			// Convert webRequest URL pattern to a loose check
			const domain = pattern.replace(/^\*:\/\//, '').split('/')[0].replace(/\*/g, '');
			if (url.includes(domain)) return id;
		}
	}
	return null;
}
