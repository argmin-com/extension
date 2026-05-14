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
				"*://chatgpt.com/backend-api/f/conversation",
				"*://chatgpt.com/backend-api/conversation?*",
				"*://chatgpt.com/backend-api/conversation/*",
				"*://chatgpt.com/backend-api/messages*",
				"*://chatgpt.com/backend-anon/conversation",
				"*://chatgpt.com/backend-anon/conversation?*",
				"*://chatgpt.com/backend-anon/conversation/*",
				"*://chatgpt.com/ces/v1/*",
				"*://chatgpt.com/sentinel/*",
				"*://chat.openai.com/backend-api/conversation",
				"*://chat.openai.com/backend-api/conversation?*",
				"*://chat.openai.com/backend-api/conversation/*",
				"*://chat.openai.com/backend-api/f/conversation",
				"*://chat.openai.com/backend-api/messages*"
			],
			regexes: [
				"^https?://(chatgpt\\.com|chat\\.openai\\.com)/backend-(api|anon)/(f/)?conversation",
				"^https?://(chatgpt\\.com|chat\\.openai\\.com)/backend-api/messages",
				"^https?://chatgpt\\.com/(ces/v1/|sentinel/)"
			]
		},
		onCompleted: {
			urls: [
				"*://chatgpt.com/backend-api/conversation*",
				"*://chatgpt.com/backend-api/f/conversation*",
				"*://chatgpt.com/backend-api/messages*",
				"*://chatgpt.com/backend-anon/conversation*",
				"*://chatgpt.com/ces/v1/*",
				"*://chatgpt.com/sentinel/*",
				"*://chat.openai.com/backend-api/conversation*",
				"*://chat.openai.com/backend-api/f/conversation*",
				"*://chat.openai.com/backend-api/messages*"
			],
			regexes: [
				"^https?://(chatgpt\\.com|chat\\.openai\\.com)/backend-(api|anon)/(f/)?conversation",
				"^https?://(chatgpt\\.com|chat\\.openai\\.com)/backend-api/messages",
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
				"*://gemini.google.com/_/*",
				"*://gemini.google.com/*GenerateContent*",
				"*://gemini.google.com/*StreamGenerate*"
			],
			regexes: [
				"^https?://gemini\\.google\\.com/(_/BardChatUi/data/|app/_/|u/\\d+/app/_/)",
				"^https?://gemini\\.google\\.com/.*StreamGenerate",
				"^https?://gemini\\.google\\.com/.*GenerateContent",
				"^https?://gemini\\.google\\.com/_/"
			]
		},
		onCompleted: {
			urls: [
				"*://gemini.google.com/_/BardChatUi/data/*",
				"*://gemini.google.com/app/_/*",
				"*://gemini.google.com/u/*/app/_/*",
				"*://gemini.google.com/_/*",
				"*://gemini.google.com/*GenerateContent*",
				"*://gemini.google.com/*StreamGenerate*"
			],
			regexes: [
				"^https?://gemini\\.google\\.com/(_/BardChatUi/data/|app/_/|u/\\d+/app/_/)",
				"^https?://gemini\\.google\\.com/.*StreamGenerate",
				"^https?://gemini\\.google\\.com/.*GenerateContent",
				"^https?://gemini\\.google\\.com/_/"
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
	},
	// Perplexity. Verified endpoint: /rest/sse/perplexity_ask (current SSE
	// endpoint per helallao/perplexity-ai client). Legacy socket.io transport
	// at /socket.io/* still used for anonymous sessions. The user-settings
	// endpoint is intercepted to detect plan/default-model changes.
	perplexity: {
		onBeforeRequest: {
			urls: [
				"*://www.perplexity.ai/rest/sse/perplexity_ask*",
				"*://www.perplexity.ai/rest/user/settings*",
				"*://www.perplexity.ai/socket.io/*",
				"*://perplexity.ai/rest/sse/perplexity_ask*",
				"*://perplexity.ai/rest/user/settings*",
				"*://perplexity.ai/socket.io/*"
			],
			regexes: [
				"^https?://(www\\.)?perplexity\\.ai/rest/sse/perplexity_ask",
				"^https?://(www\\.)?perplexity\\.ai/rest/user/settings",
				"^https?://(www\\.)?perplexity\\.ai/socket\\.io/"
			]
		},
		onCompleted: {
			urls: [
				"*://www.perplexity.ai/rest/sse/perplexity_ask*",
				"*://www.perplexity.ai/rest/user/settings*",
				"*://www.perplexity.ai/socket.io/*",
				"*://perplexity.ai/rest/sse/perplexity_ask*",
				"*://perplexity.ai/rest/user/settings*",
				"*://perplexity.ai/socket.io/*"
			],
			regexes: [
				"^https?://(www\\.)?perplexity\\.ai/rest/sse/perplexity_ask",
				"^https?://(www\\.)?perplexity\\.ai/rest/user/settings",
				"^https?://(www\\.)?perplexity\\.ai/socket\\.io/"
			]
		}
	},
	// Grok. Verified inference endpoints (realasfngl/Grok-Api):
	//   POST /rest/app-chat/conversations/new
	//   POST /rest/app-chat/conversations/{id}/responses
	// /rest/models is the model-list endpoint (used to infer tier when
	// grok-4-heavy is present). /v1/initialize bootstraps the session and
	// may carry plan info in the response body.
	grok: {
		onBeforeRequest: {
			urls: [
				"*://grok.com/rest/app-chat/conversations/*",
				"*://grok.com/rest/models*",
				"*://grok.com/v1/initialize*"
			],
			regexes: [
				"^https?://grok\\.com/rest/app-chat/conversations/",
				"^https?://grok\\.com/rest/models",
				"^https?://grok\\.com/v1/initialize"
			]
		},
		onCompleted: {
			urls: [
				"*://grok.com/rest/app-chat/conversations/*",
				"*://grok.com/rest/models*",
				"*://grok.com/v1/initialize*"
			],
			regexes: [
				"^https?://grok\\.com/rest/app-chat/conversations/",
				"^https?://grok\\.com/rest/models",
				"^https?://grok\\.com/v1/initialize"
			]
		}
	},
	// Meta AI. The inference endpoint is on a separate host: graph.meta.ai,
	// not www.meta.ai. Auth/TOS mutations hit www.meta.ai/api/graphql/.
	// Match on either host (the live capture confirms two endpoints exist
	// for distinct phases of the request lifecycle).
	meta: {
		onBeforeRequest: {
			urls: [
				"*://graph.meta.ai/graphql*",
				"*://www.meta.ai/api/graphql*",
				"*://meta.ai/api/graphql*"
			],
			regexes: [
				"^https?://graph\\.meta\\.ai/graphql",
				"^https?://(www\\.)?meta\\.ai/api/graphql"
			]
		},
		onCompleted: {
			urls: [
				"*://graph.meta.ai/graphql*",
				"*://www.meta.ai/api/graphql*",
				"*://meta.ai/api/graphql*"
			],
			regexes: [
				"^https?://graph\\.meta\\.ai/graphql",
				"^https?://(www\\.)?meta\\.ai/api/graphql"
			]
		}
	},
	// Microsoft Copilot. Confirmed transport is WebSocket, not HTTP SSE.
	// Production endpoint (reverse-engineered from the live bundle):
	//   wss://copilot.microsoft.com/c/api/chat?<query>
	//   wss://copilot.microsoft.com/c/api/eval/chat?<query>  (evaluation
	//   scope)
	// webRequest matches the upgrade handshake (visible as https from the
	// browser); the actual frame parsing is done in the WebSocket wrapper
	// in injections/stream-token-counter.js. Also include /c/api/* HTTP
	// for any conversation-list / session bootstrap that arrives over REST.
	copilot: {
		onBeforeRequest: {
			urls: [
				"*://copilot.microsoft.com/c/api/chat*",
				"*://copilot.microsoft.com/c/api/eval/chat*",
				"*://copilot.microsoft.com/c/api/conversations*",
				"*://copilot.microsoft.com/c/api/sessions*"
			],
			regexes: [
				"^https?://copilot\\.microsoft\\.com/c/api/(eval/)?chat",
				"^https?://copilot\\.microsoft\\.com/c/api/(conversations|sessions)"
			]
		},
		onCompleted: {
			urls: [
				"*://copilot.microsoft.com/c/api/chat*",
				"*://copilot.microsoft.com/c/api/eval/chat*",
				"*://copilot.microsoft.com/c/api/conversations*",
				"*://copilot.microsoft.com/c/api/sessions*"
			],
			regexes: [
				"^https?://copilot\\.microsoft\\.com/c/api/(eval/)?chat",
				"^https?://copilot\\.microsoft\\.com/c/api/(conversations|sessions)"
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
