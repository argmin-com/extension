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
	const MAX_CAPTURE_BODY_CHARS = 120000;

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
				const view = body.byteLength > MAX_CAPTURE_BODY_CHARS ? body.slice(0, MAX_CAPTURE_BODY_CHARS) : body;
				return new TextDecoder().decode(view);
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

	if (platform === 'chatgpt' || platform === 'gemini') {
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
