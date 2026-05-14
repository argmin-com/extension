// injections/stream-token-counter.js
// Injected into page context. Intercepts SSE streams, parses platform-specific
// delta formats, accumulates output text, and dispatches it for proper tokenization
// in the content script context (which has access to the o200k tokenizer).
(function () {
	const script = document.currentScript;
	const datasetPlatform = script?.dataset?.platform;
	const hostPlatform = (() => {
		const h = window.location.hostname;
		if (h.includes('claude.ai')) return 'claude';
		if (h.includes('chatgpt.com') || h.includes('chat.openai.com')) return 'chatgpt';
		if (h.includes('gemini.google.com')) return 'gemini';
		if (h.includes('chat.mistral.ai')) return 'mistral';
		if (h.includes('perplexity.ai')) return 'perplexity';
		if (h.includes('grok.com')) return 'grok';
		if (h.includes('meta.ai')) return 'meta';
		if (h.includes('copilot.microsoft.com') || h.includes('m365.cloud.microsoft')) return 'copilot';
		return 'unknown';
	})();
	const platform = datasetPlatform || hostPlatform;

	if (window.__aiTrackerStreamWrapped) return;
	window.__aiTrackerStreamWrapped = true;

	function getNonce() {
		return document.documentElement?.dataset?.aiTrackerNonce || null;
	}

	const originalFetch = window.fetch;
	const MAX_CAPTURE_BODY_CHARS = 120000;
	// Timestamp of last intercepted generation. The Gemini DOM-fallback observer
	// fires on container mutations including the model-picker re-render. Gate
	// dispatches on a recent real intercept to prevent phantom attribution.
	let lastInterceptAt = 0;
	const DOM_FALLBACK_WINDOW_MS = 90_000;

	function emitTrackerEvent(type, detail) {
		const enrichedDetail = {
			eventId: `${type}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
			...detail
		};
		window.dispatchEvent(new CustomEvent(type, { detail: enrichedDetail }));
		try {
			window.postMessage({ __aiTracker: true, type, detail: enrichedDetail }, window.location.origin);
		} catch {
			// CustomEvent above is still available as a same-world fallback.
		}
	}

	function toAbsoluteUrl(url) {
		const raw = String(url || '');
		return raw.startsWith('/') ? window.location.origin + raw : raw;
	}

	function hostMatchesPlatform(url) {
		try {
			const h = new URL(url, window.location.origin).hostname;
			if (platform === 'claude') return h.includes('claude.ai');
			if (platform === 'chatgpt') return h.includes('chatgpt.com') || h.includes('chat.openai.com');
			if (platform === 'gemini') return h.includes('gemini.google.com');
			if (platform === 'mistral') return h.includes('chat.mistral.ai');
			if (platform === 'perplexity') return h.includes('perplexity.ai');
			if (platform === 'grok') return h.includes('grok.com');
			if (platform === 'meta') return h.includes('meta.ai');
			if (platform === 'copilot') return h.includes('copilot.microsoft.com') || h.includes('m365.cloud.microsoft');
		} catch {
			return false;
		}
		return false;
	}

	async function bodyToText(body) {
		if (body == null) return '';
		try {
			if (typeof body === 'string') return body.slice(0, MAX_CAPTURE_BODY_CHARS);
			if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
				return body.toString().slice(0, MAX_CAPTURE_BODY_CHARS);
			}
			if (typeof FormData !== 'undefined' && body instanceof FormData) {
				const params = new URLSearchParams();
				for (const [key, value] of body.entries()) {
					params.append(key, typeof value === 'string' ? value : `[file:${value?.name || 'blob'}:${value?.size || 0}]`);
				}
				return params.toString().slice(0, MAX_CAPTURE_BODY_CHARS);
			}
			if (typeof Blob !== 'undefined' && body instanceof Blob) {
				if (body.size > MAX_CAPTURE_BODY_CHARS) return '';
				return (await body.text()).slice(0, MAX_CAPTURE_BODY_CHARS);
			}
			if (body instanceof ArrayBuffer) {
				return new TextDecoder().decode(body.slice(0, MAX_CAPTURE_BODY_CHARS));
			}
			if (ArrayBuffer.isView(body)) {
				const bytes = new Uint8Array(body.buffer, body.byteOffset, Math.min(body.byteLength, MAX_CAPTURE_BODY_CHARS));
				return new TextDecoder().decode(bytes);
			}
			if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return '';
			if (typeof body === 'object') return JSON.stringify(body).slice(0, MAX_CAPTURE_BODY_CHARS);
		} catch {
			return '';
		}
		return '';
	}

	async function getFetchRequestInfo(args) {
		const resource = args[0];
		const init = args[1] || {};
		let url = '';
		let method = 'GET';
		let bodyText = '';

		if (typeof resource === 'string') url = resource;
		else if (resource instanceof URL) url = resource.href;
		else if (typeof Request !== 'undefined' && resource instanceof Request) {
			url = resource.url;
			method = resource.method || method;
		}

		if (init.method) method = init.method;
		if (Object.prototype.hasOwnProperty.call(init, 'body')) {
			bodyText = await bodyToText(init.body);
		} else if (typeof Request !== 'undefined' && resource instanceof Request) {
			try {
				bodyText = await resource.clone().text();
				bodyText = bodyText.slice(0, MAX_CAPTURE_BODY_CHARS);
			} catch {
				bodyText = '';
			}
		}

		return {
			url: toAbsoluteUrl(url),
			method: String(method || 'GET').toUpperCase(),
			bodyText
		};
	}

	function bodyLooksLikeInference(bodyText) {
		if (!bodyText) return false;
		const sample = String(bodyText).slice(0, 8000).toLowerCase();
		if (platform === 'claude') {
			return (
				sample.includes('"prompt"') ||
				sample.includes('"messages"') ||
				sample.includes('"model"') ||
				sample.includes('"attachments"') ||
				sample.includes('"files"') ||
				sample.includes('"timezone"')
			);
		}
		if (platform === 'chatgpt') {
			return (
				sample.includes('"messages"') ||
				sample.includes('"input_messages"') ||
				sample.includes('"conversation_mode"') ||
				sample.includes('"parent_message_id"') ||
				sample.includes('"model_slug"') ||
				sample.includes('"selected_model_slug"') ||
				sample.includes('"action":"next"') ||
				(sample.includes('"model"') && (sample.includes('"prompt"') || sample.includes('"content"')))
			);
		}
		if (platform === 'gemini') {
			return sample.includes('"contents"') || sample.includes('bard') || sample.includes('generatecontent') || sample.includes('streamgenerate');
		}
		if (platform === 'mistral') {
			return sample.includes('"messages"') || sample.includes('"inputs"') || sample.includes('"prompt"');
		}
		if (platform === 'perplexity') {
			return sample.includes('"query"') ||
				sample.includes('"question"') ||
				sample.includes('"messages"') ||
				sample.includes('"prompt"') ||
				sample.includes('"model"');
		}
		if (platform === 'grok') {
			return sample.includes('"message"') ||
				sample.includes('"messages"') ||
				sample.includes('"prompt"') ||
				sample.includes('"query"') ||
				sample.includes('"model"');
		}
		if (platform === 'meta') {
			// Meta AI uses Facebook-style GraphQL with operation names in
			// fb_api_req_friendly_name. Inference is keyed by
			// useAbraSendMessageMutation (and any future Muse Spark variants
			// matching useAbraSendMessage*). The doc_id rotates frequently,
			// so we match the operation name family instead.
			// Source: Strvm/meta-ai-api main.py.
			return sample.includes('useabrasendmessage') ||
				sample.includes('"abra__chat__text"') ||
				sample.includes('externalconversationid') ||
				sample.includes('offlinethreadingid');
		}
		if (platform === 'copilot') {
			return sample.includes('"messages"') ||
				sample.includes('"message"') ||
				sample.includes('"prompt"') ||
				sample.includes('"text"') ||
				sample.includes('"conversationid"') ||
				sample.includes('"conversation_id"') ||
				sample.includes('"model"');
		}
		return false;
	}

	function looksLikeInferenceRequest(method, url, bodyText) {
		const normalizedMethod = String(method || 'GET').toUpperCase();
		if (!['POST', 'PUT', 'PATCH'].includes(normalizedMethod)) return false;
		const fullUrl = toAbsoluteUrl(url);
		if (!hostMatchesPlatform(fullUrl)) return false;
		return shouldIntercept(fullUrl) || bodyLooksLikeInference(bodyText);
	}

	function dispatchInput(requestInfo) {
		if (!requestInfo?.bodyText || !looksLikeInferenceRequest(requestInfo.method, requestInfo.url, requestInfo.bodyText)) return;
		emitTrackerEvent('platformInferenceRequest', {
			__nonce: getNonce(),
			platform,
			url: requestInfo.url,
			method: requestInfo.method,
			bodyText: requestInfo.bodyText.slice(0, MAX_CAPTURE_BODY_CHARS),
			bodyCharCount: requestInfo.bodyText.length,
			timestamp: Date.now()
		});
	}

	const parsers = {
		claude(json) {
			if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') return json.delta.text || '';
			if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta') return json.delta.thinking || '';
			if (json.completion) return json.completion;
			return null;
		},
		chatgpt(json) {
			const textFromValue = (value) => {
				if (typeof value === 'string') return value;
				if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join('');
				if (!value || typeof value !== 'object') return '';
				if (typeof value.text === 'string') return value.text;
				if (typeof value.value === 'string') return value.value;
				if (typeof value.content === 'string') return value.content;
				if (Array.isArray(value.parts)) return value.parts.map(textFromValue).filter(Boolean).join('');
				if (Array.isArray(value.content?.parts)) return value.content.parts.map(textFromValue).filter(Boolean).join('');
				if (Array.isArray(value.annotations)) return '';
				return '';
			};

			if (Array.isArray(json)) {
				const text = json.map(item => parsers.chatgpt(item)).filter(Boolean).join('');
				return text || null;
			}

			// ChatGPT web can stream JSON-patch operations such as:
			// { o:"append", p:"/message/content/parts/0", v:"..." }.
			if (typeof json.p === 'string' && Object.prototype.hasOwnProperty.call(json, 'v')) {
				const patchPath = json.p.toLowerCase();
				const operation = String(json.o || '').toLowerCase();
				if (
					patchPath.includes('/message/content') ||
					patchPath.includes('/messages/') ||
					patchPath.includes('/content/parts') ||
					operation === 'append'
				) {
					const text = textFromValue(json.v);
					if (text) return text;
				}
			}

			// Standard OpenAI SSE format
			if (json.choices?.[0]?.delta?.content) return json.choices[0].delta.content;
			if (json.choices?.[0]?.delta?.reasoning) return json.choices[0].delta.reasoning;
			if (Object.prototype.hasOwnProperty.call(json, 'v')) {
				const text = textFromValue(json.v);
				if (text) return text;
			}
			if (json.message?.content?.parts && Array.isArray(json.message.content.parts)) {
				return json.message.content.parts.map(textFromValue).filter(Boolean).join('');
			}
			if (json.content?.parts && Array.isArray(json.content.parts)) {
				return json.content.parts.map(textFromValue).filter(Boolean).join('');
			}
			if (typeof json.delta === 'string') return json.delta;
			return null;
		},
		gemini(json) {
			if (json.candidates?.[0]?.content?.parts) {
				return json.candidates[0].content.parts.filter(p => p.text).map(p => p.text).join('');
			}
			if (json.candidate?.content?.parts) {
				return json.candidate.content.parts.filter(p => p.text).map(p => p.text).join('');
			}
			if (json.textChunk) return json.textChunk;
			if (json.delta?.text) return json.delta.text;
			if (json.modelOutput?.text) return json.modelOutput.text;
			if (json.responseText) return json.responseText;
			if (Array.isArray(json)) return extractTextFromGeminiArray(json);
			return null;
		},
		mistral(json) {
			if (json.choices?.[0]?.delta?.content) return json.choices[0].delta.content;
			return null;
		},
		// Perplexity SSE streams a double-nested JSON: each frame is
		//   event: message\ndata: {...}
		// where the inner `text` field is itself a JSON string holding an
		// array of step objects keyed by step_type. The final answer lives
		// in step_type === "FINAL" -> content.answer (also JSON-encoded).
		// Source: helallao/perplexity-ai client.py.
		perplexity(json) {
			const tryParseInner = (text) => {
				try { return typeof text === 'string' ? JSON.parse(text) : text; }
				catch { return null; }
			};
			// Primary path: SSE frame with nested step-array in `text`.
			if (typeof json.text === 'string') {
				const inner = tryParseInner(json.text);
				if (Array.isArray(inner)) {
					for (const step of inner) {
						if (step?.step_type === 'FINAL' && step?.content?.answer) {
							const final = tryParseInner(step.content.answer);
							if (final?.answer) return final.answer;
							if (typeof step.content.answer === 'string') return step.content.answer;
						}
					}
				}
				return json.text;
			}
			// Socket.io frames carry cumulative state - dedupe at the caller.
			if (typeof json.answer === 'string') return json.answer;
			if (typeof json.final === 'string') return json.final;
			if (json.delta?.content) return json.delta.content;
			// Compatibility fallbacks for older frame shapes and chunked
			// transports.
			if (json.response?.answer) return json.response.answer;
			if (json.response?.text) return json.response.text;
			if (Array.isArray(json.chunks)) return json.chunks.map(chunk => parsers.perplexity(chunk)).filter(Boolean).join('');
			const openAiChunk = parsers.chatgpt(json);
			if (openAiChunk) return openAiChunk;
			return null;
		},
		// Grok streams NDJSON (one JSON object per line, no `data:` prefix).
		// Verified primary paths: result.response.token (new-conversation
		// chunk-level), result.token (continuation chunk), and
		// result.[response.]modelResponse.message (final assembled message).
		// Source: realasfngl/Grok-Api core/grok.py. Keeps an OpenAI-style
		// fallback for any surface that proxies through chat-completions
		// and a response.text fallback for older frame shapes.
		grok(json) {
			if (json.result?.response?.token) return json.result.response.token;
			if (json.result?.token) return json.result.token;
			if (json.result?.response?.modelResponse?.message) {
				return json.result.response.modelResponse.message;
			}
			if (json.result?.modelResponse?.message) {
				return json.result.modelResponse.message;
			}
			if (json.result?.response?.text) return json.result.response.text;
			if (json.response?.text) return json.response.text;
			if (json.message?.text) return json.message.text;
			if (Array.isArray(json.responses)) {
				return json.responses.map(chunk => parsers.grok(chunk)).filter(Boolean).join('');
			}
			const openAiChunk = parsers.chatgpt(json);
			if (openAiChunk) return openAiChunk;
			return null;
		},
		// Meta AI uses line-delimited JSON (not SSE). Each line decodes to
		// data.node.bot_response_message with composed_text.content[].text
		// chunks. The end-of-stream marker is streaming_state === "OVERALL_DONE".
		// Source: Strvm/meta-ai-api main.py.
		meta(json) {
			const bot = json.data?.node?.bot_response_message
				|| json.data?.bot_response_message
				|| json.node?.bot_response_message
				|| json.bot_response_message;
			if (bot?.composed_text?.content && Array.isArray(bot.composed_text.content)) {
				return bot.composed_text.content.map(c => c?.text || '').filter(Boolean).join('');
			}
			// Newer Muse Spark "thinking" mode emits a separate reasoning stream.
			if (bot?.reasoning_content?.content && Array.isArray(bot.reasoning_content.content)) {
				return bot.reasoning_content.content.map(c => c?.text || '').filter(Boolean).join('');
			}
			// Some early-stream frames put a partial directly on `text`.
			if (typeof json.text === 'string') return json.text;
			if (json.delta?.text) return json.delta.text;
			const openAiChunk = parsers.chatgpt(json);
			if (openAiChunk) return openAiChunk;
			return null;
		},
		// Microsoft Copilot uses WebSocket frames (wss://copilot.microsoft.com/c/api/chat).
		// Each frame is a JSON object. The streaming text envelope shape
		// observed in the production bundle uses `text` directly or wraps
		// chunks in `{event: "appendText", text: "..."}` / `{type: "text"}`.
		// The WebSocket wrapper (below) feeds JSON-parsed frames here.
		copilot(json) {
			if (json.event === 'appendText' && typeof json.text === 'string') return json.text;
			if (json.type === 'text' && typeof json.text === 'string') return json.text;
			if (json.type === 'message' && typeof json.text === 'string') return json.text;
			if (typeof json.text === 'string' && !json.type) return json.text;
			if (json.delta?.text) return json.delta.text;
			if (json.message?.text) return json.message.text;
			if (json.message?.content?.text) return json.message.content.text;
			if (json.item?.messages && Array.isArray(json.item.messages)) {
				return json.item.messages.map(m => m?.text || m?.content || '').filter(Boolean).join('');
			}
			// Some surfaces (m365.cloud.microsoft enterprise chat) tunnel
			// OpenAI-style chunks; fall back to the chatgpt parser.
			const openAiChunk = parsers.chatgpt(json);
			if (openAiChunk) return openAiChunk;
			return null;
		}
	};

	function extractTextFromGeminiArray(arr, depth = 0) {
		if (!Array.isArray(arr) || depth > 10) return '';
		let text = '';
		for (const item of arr) {
			if (typeof item === 'string' && item.length > 2) text += item;
			else if (Array.isArray(item)) text += extractTextFromGeminiArray(item, depth + 1);
		}
		return text;
	}

	function stripGeminiPrefix(str) {
		return String(str || '').replace(/^\)\]\}'\s*\n?/, '');
	}

	const urlMatchers = {
		claude: (url) => url.includes('claude.ai') && (url.includes('/completion') || url.includes('/retry_completion')),
		chatgpt: (url) =>
			(url.includes('chatgpt.com') || url.includes('chat.openai.com')) &&
			(
				url.includes('/backend-api/f/conversation') ||
				url.includes('/backend-api/conversation') ||
				url.includes('/backend-anon/conversation') ||
				url.includes('/backend-api/messages') ||
				url.includes('/conversation') ||
				url.includes('/ces/') ||
				url.includes('/sentinel/')
			),
		gemini: (url) =>
			url.includes('gemini.google.com') &&
			(
				url.includes('BardChatUi/data/assistant.lamda') ||
				url.includes('BardChatUi/data/batchexecute') ||
				url.includes('StreamGenerate') ||
				url.includes('GenerateContent') ||
				url.includes('assistant.lamda')
			),
		mistral: (url) => url.includes('chat.mistral.ai') && url.includes('/api/'),
		// Perplexity: tightened from broad /rest/, /api/, /socket.io/.
		// Real inference path is /rest/sse/perplexity_ask; socket.io is
		// legacy/anonymous transport.
		perplexity: (url) =>
			url.includes('perplexity.ai') &&
			(
				url.includes('/rest/sse/perplexity_ask') ||
				url.includes('/socket.io/')
			),
		// Grok: tightened from broad /rest/, /api/, /i/api/, /conversation.
		// Real paths are /rest/app-chat/conversations/new and
		// /rest/app-chat/conversations/{id}/responses. /i/api/ belongs to
		// x.com (twitter) not grok.com.
		grok: (url) =>
			url.includes('grok.com') && url.includes('/rest/app-chat/conversations/'),
		// Meta AI: real inference is on graph.meta.ai host, not www.meta.ai.
		// www.meta.ai/api/graphql/ is auth/TOS, not inference. Match on
		// either host since we filter further by fb_api_req_friendly_name
		// in the body check.
		meta: (url) =>
			(url.includes('graph.meta.ai/graphql') || url.includes('meta.ai/api/graphql')),
		// Copilot HTTP surface (for conversation list / session bootstrap).
		// The actual chat stream is over WebSocket and handled by the
		// WebSocket wrapper below, not by this URL matcher.
		copilot: (url) =>
			url.includes('copilot.microsoft.com/c/api/') &&
			(
				url.includes('/c/api/chat') ||
				url.includes('/c/api/conversations') ||
				url.includes('/c/api/sessions')
			)
	};

	function shouldIntercept(url) {
		const matcher = urlMatchers[platform];
		return matcher ? matcher(url) : false;
	}

	function dispatchOutput(accumulatedText, fullUrl, startTime) {
		if (!accumulatedText || accumulatedText.length === 0) return;
		emitTrackerEvent('streamOutputComplete', {
			__nonce: getNonce(),
			platform,
			url: fullUrl,
			outputText: accumulatedText,
			outputCharCount: accumulatedText.length,
			durationMs: Date.now() - startTime,
			timestamp: Date.now()
		});
	}

	window.fetch = async function (...args) {
		const requestInfoPromise = getFetchRequestInfo(args);
		requestInfoPromise.then(dispatchInput).catch(() => {});
		const response = await originalFetch.apply(this, args);
		const requestInfo = await requestInfoPromise.catch(() => null);
		const fallbackUrl = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0] instanceof Request ? args[0].url : '';
		const fullUrl = requestInfo?.url || toAbsoluteUrl(fallbackUrl);

		if (window.__aiTrackerDebug && (fullUrl.includes('/api/') || fullUrl.includes('/backend') || fullUrl.includes('/_/'))) {
			console.log('[AI Tracker] fetch:', fullUrl.split('?')[0], 'content-type:', response.headers.get('content-type') || 'none');
		}

		const contentType = response.headers.get('content-type') || '';
		const isStream = contentType.includes('event-stream') ||
			contentType.includes('x-ndjson') ||
			contentType.includes('text/plain') ||
			contentType.includes('application/json') ||
			contentType.includes('x-protobuf') ||
			contentType.includes('octet-stream');

		const urlMatch = shouldIntercept(fullUrl) || looksLikeInferenceRequest(requestInfo?.method, fullUrl, requestInfo?.bodyText);
		if (urlMatch && (isStream || response.body)) {
			lastInterceptAt = Date.now();
			if (window.__aiTrackerDebug) console.log('[AI Tracker] INTERCEPTING stream:', fullUrl.split('?')[0]);
			const clone = response.clone();
			if (!clone.body) return response;
			const reader = clone.body.getReader();
			const decoder = new TextDecoder();
			const parser = parsers[platform];
			let accumulatedText = '';
			let chunkBuffer = '';
			const startTime = Date.now();

			const readStream = async () => {
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						let decoded = decoder.decode(value, { stream: true });
						if (platform === 'gemini' && accumulatedText.length === 0) decoded = stripGeminiPrefix(decoded);
						chunkBuffer += decoded;
						const lines = chunkBuffer.split(/\r?\n/);
						chunkBuffer = lines.pop() || '';

						for (const line of lines) {
							let dataStr;
							if (line.startsWith('data:')) dataStr = line.substring(5).trim();
							else if (platform === 'gemini' && (line.trim().startsWith('[') || line.trim().startsWith('{'))) dataStr = line.trim();
							else continue;

							if (!dataStr || dataStr === '[DONE]') continue;
							try {
								const json = JSON.parse(stripGeminiPrefix(dataStr));
								const text = parser ? parser(json) : null;
								if (text) accumulatedText += text;
							} catch {
								if (platform === 'gemini') {
									const matches = dataStr.match(/[\x20-\x7E\u00A0-\uFFFF]{4,}/g) || [];
									if (matches.length > 0) accumulatedText += matches.join(' ');
								}
							}
						}
					}
				} catch (err) {
					if (err.name !== 'AbortError' && window.__aiTrackerDebug) {
						console.warn('[AI Tracker] Stream read error on', platform, ':', err.name, err.message);
					}
				}
				dispatchOutput(accumulatedText, fullUrl, startTime);
			};

			readStream();
		}

		if (response.status === 429 && shouldIntercept(fullUrl)) {
			try {
				const headers = {};
				for (const [k, v] of response.headers.entries()) {
					if (k.toLowerCase().includes('rate') || k.toLowerCase().includes('retry') || k.toLowerCase().includes('limit')) headers[k] = v;
				}
				let resetTime = null;
				const retryAfter = response.headers.get('retry-after');
				if (retryAfter) {
					const seconds = parseInt(retryAfter);
					const parsed = isNaN(seconds) ? new Date(retryAfter).getTime() : Date.now() + seconds * 1000;
					resetTime = isNaN(parsed) ? null : parsed;
				}
				emitTrackerEvent('platformRateLimitHit', {
					__nonce: getNonce(),
					platform,
					url: fullUrl,
					status: 429,
					headers,
					resetTime,
					timestamp: Date.now()
				});
			} catch {
				// ignore
			}
		}

		return response;
	};

	if (['claude', 'chatgpt', 'gemini', 'mistral', 'perplexity', 'grok', 'meta', 'copilot'].includes(platform)) {
		const OriginalXHR = window.XMLHttpRequest;
		window.XMLHttpRequest = function XHRWrapper() {
			const xhr = new OriginalXHR();
			let requestUrl = '';
			let requestMethod = 'GET';
			let requestBodyTextPromise = Promise.resolve('');
			let startTime = Date.now();

			const originalOpen = xhr.open;
			xhr.open = function (...openArgs) {
				requestMethod = String(openArgs[0] || 'GET').toUpperCase();
				requestUrl = openArgs[1] || '';
				startTime = Date.now();
				return originalOpen.apply(this, openArgs);
			};

			const originalSend = xhr.send;
			xhr.send = function (...sendArgs) {
				requestBodyTextPromise = bodyToText(sendArgs[0]).then((bodyText) => {
					dispatchInput({
						url: toAbsoluteUrl(requestUrl),
						method: requestMethod,
						bodyText
					});
					return bodyText;
				}).catch(() => '');
				return originalSend.apply(this, sendArgs);
			};

			xhr.addEventListener('loadend', async () => {
				try {
					const fullUrl = toAbsoluteUrl(requestUrl);
					const requestBodyText = await requestBodyTextPromise.catch(() => '');
					if (!shouldIntercept(fullUrl) && !looksLikeInferenceRequest(requestMethod, fullUrl, requestBodyText)) return;
					const parser = parsers[platform];
					let textOut = '';
					const contentType = xhr.getResponseHeader('content-type') || '';
					const isJsonLike = contentType.includes('json') || contentType.includes('text');
					if (isJsonLike && typeof xhr.responseText === 'string' && xhr.responseText) {
						const lines = xhr.responseText.split(/\r?\n/);
						for (const line of lines) {
							const dataStr = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
							if (!dataStr || dataStr === '[DONE]') continue;
							try {
								const parsed = JSON.parse(stripGeminiPrefix(dataStr));
								const chunk = parser ? parser(parsed) : null;
								if (chunk) textOut += chunk;
							} catch {
								if (platform === 'gemini') {
									const matches = dataStr.match(/[\x20-\x7E\u00A0-\uFFFF]{4,}/g) || [];
									if (matches.length > 0) textOut += matches.join(' ');
								}
							}
						}
					}
					dispatchOutput(textOut, fullUrl, startTime);
				} catch {
					// fail-open
				}
			});

			return xhr;
		};
		window.XMLHttpRequest.prototype = OriginalXHR.prototype;
	}

	// WebSocket interception. Copilot streams chat over wss://, not HTTP SSE,
	// so the fetch/XHR wrappers above never see the response body. We wrap
	// the WebSocket constructor to capture inbound message frames and feed
	// them through the platform parser. The wrapper is no-op for any URL
	// that doesn't match a known inference WS endpoint, so other ws traffic
	// (online-probe pings, etc.) flows through untouched.
	if (platform === 'copilot' && typeof WebSocket !== 'undefined') {
		const OriginalWebSocket = WebSocket;
		const isCopilotInferenceWS = (url) => {
			const s = String(url || '');
			return s.includes('copilot.microsoft.com/c/api/chat') ||
				s.includes('copilot.microsoft.com/c/api/eval/chat');
		};
		// Use a Proxy so the wrapped class still passes `instanceof WebSocket`.
		const WrappedWebSocket = new Proxy(OriginalWebSocket, {
			construct(target, args) {
				const ws = new target(...args);
				const url = String(args[0] || '');
				if (!isCopilotInferenceWS(url)) return ws;
				lastInterceptAt = Date.now();
				const startTime = Date.now();
				let accumulated = '';
				const wsParser = parsers.copilot;
				const onmessage = (event) => {
					try {
						const raw = typeof event.data === 'string'
							? event.data
							: (event.data instanceof ArrayBuffer
								? new TextDecoder().decode(event.data)
								: '');
						if (!raw) return;
						// Frames may be a single JSON object or NDJSON.
						const lines = raw.split(/\r?\n/);
						for (const line of lines) {
							const trimmed = line.trim();
							if (!trimmed) continue;
							try {
								const json = JSON.parse(trimmed);
								const text = wsParser ? wsParser(json) : null;
								if (text) accumulated += text;
								// End-of-stream markers Copilot uses.
								if (json.event === 'done' || json.type === 'done' || json.finalText === true) {
									dispatchOutput(accumulated, url, startTime);
									accumulated = '';
								}
							} catch {
								// non-JSON keepalive; ignore.
							}
						}
					} catch {
						// fail-open
					}
				};
				ws.addEventListener('message', onmessage);
				ws.addEventListener('close', () => {
					if (accumulated.length > 0) {
						dispatchOutput(accumulated, url, startTime);
						accumulated = '';
					}
				});
				return ws;
			}
		});
		// Preserve all original WebSocket properties (CONNECTING/OPEN/etc.)
		WrappedWebSocket.prototype = OriginalWebSocket.prototype;
		WrappedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
		WrappedWebSocket.OPEN = OriginalWebSocket.OPEN;
		WrappedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
		WrappedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
		window.WebSocket = WrappedWebSocket;
	}

	if (platform === 'gemini') {
		let lastKnownResponseText = '';
		const observeGeminiDOM = () => {
			const container = document.querySelector('main, [role="main"], .conversation-container, .chat-history, .conversation, .chat-app, .chat-window, [class*="conversation"]');
			if (!container) {
				setTimeout(observeGeminiDOM, 2000);
				return;
			}
			const observer = new MutationObserver(() => {
				const responses = container.querySelectorAll(
					'.model-response-text, .markdown-main-panel, .response-content, '
					+ '[data-message-author-role="model"], [data-response], '
					+ 'message-content[class*="model"], [class*="assistant"][class*="message"], '
					+ '.response-container [class*="markdown"], [class*="message-content"][class*="model"]'
				);
				if (responses.length === 0) return;
				const lastResponse = responses[responses.length - 1];
				const text = lastResponse.innerText || lastResponse.textContent || '';
				if (text.length > lastKnownResponseText.length + 20) {
					lastKnownResponseText = text;
					clearTimeout(window.__geminiDomTimeout);
					window.__geminiDomTimeout = setTimeout(() => {
						// Suppress if no real generation intercepted recently. Prevents
						// phantom output-token attribution when only the model picker
						// or other UI controls re-render the conversation container.
						if (Date.now() - lastInterceptAt > DOM_FALLBACK_WINDOW_MS) return;
						emitTrackerEvent('geminiDOMOutput', {
							__nonce: getNonce(),
							platform: 'gemini',
							outputText: text,
							timestamp: Date.now()
						});
					}, 1000);
				}
			});
			observer.observe(container, { childList: true, subtree: true, characterData: true });
		};
		setTimeout(observeGeminiDOM, 3000);
	}
})();
