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
		return 'unknown';
	})();
	const platform = datasetPlatform || hostPlatform;

	if (window.__aiTrackerStreamWrapped) return;
	window.__aiTrackerStreamWrapped = true;

	function getNonce() {
		return document.documentElement?.dataset?.aiTrackerNonce || null;
	}

	const originalFetch = window.fetch;

	const parsers = {
		claude(json) {
			if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') return json.delta.text || '';
			if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta') return json.delta.thinking || '';
			if (json.completion) return json.completion;
			return null;
		},
		chatgpt(json) {
			// Standard OpenAI SSE format
			if (json.choices?.[0]?.delta?.content) return json.choices[0].delta.content;
			if (json.choices?.[0]?.delta?.reasoning) return json.choices[0].delta.reasoning;
			if (typeof json.v === 'string') return json.v;
			if (json.message?.content?.parts && Array.isArray(json.message.content.parts)) {
				return json.message.content.parts.filter(p => typeof p === 'string').join('');
			}
			if (json.content?.parts && Array.isArray(json.content.parts)) {
				return json.content.parts.filter(p => typeof p === 'string').join('');
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
				url.includes('BardChatUi') ||
				url.includes('StreamGenerate') ||
				url.includes('GenerateContent') ||
				url.includes('/_/') ||
				url.includes('assistant.lamda')
			),
		mistral: (url) => url.includes('chat.mistral.ai') && url.includes('/api/')
	};

	function shouldIntercept(url) {
		const matcher = urlMatchers[platform];
		return matcher ? matcher(url) : false;
	}

	function dispatchOutput(accumulatedText, fullUrl, startTime) {
		if (!accumulatedText || accumulatedText.length === 0) return;
		window.dispatchEvent(new CustomEvent('streamOutputComplete', {
			detail: {
				__nonce: getNonce(),
				platform,
				url: fullUrl,
				outputText: accumulatedText,
				outputCharCount: accumulatedText.length,
				durationMs: Date.now() - startTime,
				timestamp: Date.now()
			}
		}));
	}

	window.fetch = async function (...args) {
		const response = await originalFetch.apply(this, args);
		const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0] instanceof Request ? args[0].url : '';
		const fullUrl = url.startsWith('/') ? window.location.origin + url : url;

		if (fullUrl.includes('/api/') || fullUrl.includes('/backend') || fullUrl.includes('/_/')) {
			console.log('[AI Tracker] fetch:', fullUrl.split('?')[0], 'content-type:', response.headers.get('content-type') || 'none');
		}

		const contentType = response.headers.get('content-type') || '';
		const isStream = contentType.includes('event-stream') ||
			contentType.includes('x-ndjson') ||
			contentType.includes('text/plain') ||
			contentType.includes('application/json') ||
			contentType.includes('x-protobuf') ||
			contentType.includes('octet-stream');

		const urlMatch = shouldIntercept(fullUrl);
		if (urlMatch && (isStream || response.body)) {
			console.log('[AI Tracker] INTERCEPTING stream:', fullUrl.split('?')[0]);
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
					if (err.name !== 'AbortError') {
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
					resetTime = isNaN(seconds) ? new Date(retryAfter).getTime() : Date.now() + seconds * 1000;
				}
				window.dispatchEvent(new CustomEvent('platformRateLimitHit', {
					detail: { __nonce: getNonce(), platform, url: fullUrl, status: 429, headers, resetTime, timestamp: Date.now() }
				}));
			} catch {
				// ignore
			}
		}

		return response;
	};

	if (platform === 'chatgpt' || platform === 'gemini') {
		const OriginalXHR = window.XMLHttpRequest;
		window.XMLHttpRequest = function XHRWrapper() {
			const xhr = new OriginalXHR();
			let requestUrl = '';
			let startTime = Date.now();

			const originalOpen = xhr.open;
			xhr.open = function (...openArgs) {
				requestUrl = openArgs[1] || '';
				startTime = Date.now();
				return originalOpen.apply(this, openArgs);
			};

			xhr.addEventListener('loadend', () => {
				try {
					const fullUrl = typeof requestUrl === 'string' && requestUrl.startsWith('/') ? window.location.origin + requestUrl : String(requestUrl || '');
					if (!shouldIntercept(fullUrl)) return;
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
						window.dispatchEvent(new CustomEvent('geminiDOMOutput', {
							detail: { __nonce: getNonce(), platform: 'gemini', outputText: text, timestamp: Date.now() }
						}));
					}, 1000);
				}
			});
			observer.observe(container, { childList: true, subtree: true, characterData: true });
		};
		setTimeout(observeGeminiDOM, 3000);
	}
})();
