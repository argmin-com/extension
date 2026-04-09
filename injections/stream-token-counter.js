// injections/stream-token-counter.js
// Injected into page context. Intercepts SSE streams, parses platform-specific
// delta formats, accumulates output text, and dispatches it for proper tokenization
// in the content script context (which has access to the o200k tokenizer).
(function () {
	const script = document.currentScript;
	// Detect platform from dataset (when injected via content script) or from hostname (when injected via manifest world:MAIN)
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

	// Security: read nonce from DOM attribute set by content script for event verification.
	// Lazily read on each dispatch so it works even if the content script loads after us.
	function getNonce() {
		return document.documentElement?.dataset?.aiTrackerNonce || null;
	}

	const originalFetch = window.fetch;

	// Platform-specific SSE parsers. Returns extracted text or null.
	const parsers = {
		claude(json) {
			if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta')
				return json.delta.text || '';
			if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta')
				return json.delta.thinking || '';
			if (json.completion) return json.completion;
			return null;
		},

		chatgpt(json) {
			if (json.choices?.[0]?.delta?.content) return json.choices[0].delta.content;
			if (json.choices?.[0]?.delta?.reasoning) return json.choices[0].delta.reasoning;
			return null;
		},

		// Fix 3: Gemini parser handles anti-XSSI prefix, nested arrays, and multiple response formats
		gemini(json) {
			if (json.candidates?.[0]?.content?.parts) {
				return json.candidates[0].content.parts
					.filter(p => p.text).map(p => p.text).join('');
			}
			if (json.textChunk) return json.textChunk;
			// Nested array format: [[["response text"],...]]
			if (Array.isArray(json)) {
				return extractTextFromGeminiArray(json);
			}
			return null;
		},

		mistral(json) {
			if (json.choices?.[0]?.delta?.content) return json.choices[0].delta.content;
			return null;
		}
	};

	// Recursively extract text from Gemini's deeply nested array responses
	function extractTextFromGeminiArray(arr, depth = 0) {
		if (depth > 10) return '';
		let text = '';
		for (const item of arr) {
			if (typeof item === 'string' && item.length > 2) text += item;
			else if (Array.isArray(item)) text += extractTextFromGeminiArray(item, depth + 1);
		}
		return text;
	}

	// Strip Gemini's anti-XSSI prefix: )]}' followed by newline
	function stripGeminiPrefix(str) {
		return str.replace(/^\)\]\}'\s*\n?/, '');
	}

	const urlMatchers = {
		claude: (url) => url.includes('claude.ai') && (url.includes('/completion') || url.includes('/retry_completion')),
		chatgpt: (url) => (url.includes('chatgpt.com') || url.includes('chat.openai.com')) && (url.includes('/backend-api/') || url.includes('/backend-anon/')),
		gemini: (url) => url.includes('gemini.google.com') && (url.includes('BardChatUi') || url.includes('/app/_/') || url.includes('StreamGenerate')),
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
				platform: platform,
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

		const url = typeof args[0] === 'string' ? args[0] :
			args[0] instanceof URL ? args[0].href :
			args[0] instanceof Request ? args[0].url : '';
		const fullUrl = url.startsWith('/') ? window.location.origin + url : url;

		// Diagnostic: log all fetch URLs on AI platforms (visible in DevTools console)
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

		// Intercept if URL matches a platform API. For Gemini, the content-type
		// may be non-standard (protobuf/html), so also accept any response from
		// matched URLs when the body is a readable stream.
		const urlMatch = shouldIntercept(fullUrl);
		if (urlMatch && (isStream || response.body)) {
			console.log('[AI Tracker] INTERCEPTING stream:', fullUrl.split('?')[0]);
			const clone = response.clone();
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

						// Fix 3: Strip Gemini anti-XSSI prefix from first chunk
						if (platform === 'gemini' && accumulatedText.length === 0) {
							decoded = stripGeminiPrefix(decoded);
						}

						chunkBuffer += decoded;
						const lines = chunkBuffer.split(/\r?\n/);
						chunkBuffer = lines.pop() || '';

						for (const line of lines) {
							let dataStr;

							// Standard SSE format
							if (line.startsWith('data:')) {
								dataStr = line.substring(5).trim();
							}
							// Gemini may send raw JSON lines
							else if (platform === 'gemini' && line.trim().startsWith('[')) {
								dataStr = line.trim();
							}
							else continue;

							if (!dataStr || dataStr === '[DONE]') continue;

							try {
								const json = JSON.parse(dataStr);
								if (parser) {
									const text = parser(json);
									if (text) accumulatedText += text;
								}
							} catch (e) {
								// Fix 3: Try Gemini nested array parse on failure
								if (platform === 'gemini') {
									try {
										const cleaned = dataStr.replace(/^\[|\s*\]$/g, '').trim();
										if (cleaned.startsWith('[') || cleaned.startsWith('{')) {
											const json = JSON.parse(dataStr);
											const text = parser(json);
											if (text) accumulatedText += text;
										}
									} catch (e2) { /* not parseable */ }
								}
							}
						}
					}
				} catch (err) {
					if (err.name !== 'AbortError') {
						console.error('[AITracker] Stream read error:', err);
					}
				}

				dispatchOutput(accumulatedText, fullUrl, startTime);
			};

			readStream();
		}

		// Rate limit detection
		if (response.status === 429 && shouldIntercept(fullUrl)) {
			try {
				const headers = {};
				for (const [k, v] of response.headers.entries()) {
					if (k.toLowerCase().includes('rate') || k.toLowerCase().includes('retry') || k.toLowerCase().includes('limit'))
						headers[k] = v;
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
			} catch (e) { /* ignore */ }
		}

		return response;
	};

	// Fix 3: Gemini DOM fallback observer.
	// If the SSE stream parser fails to extract text (protobuf, unusual format),
	// observe the response container and scrape the rendered output text.
	if (platform === 'gemini') {
		let lastKnownResponseText = '';

		const observeGeminiDOM = () => {
			// Use broad selectors to survive UI redesigns
			const container = document.querySelector('.conversation-container, .chat-history, main, [role="main"], #chat-history');
			if (!container) { setTimeout(observeGeminiDOM, 2000); return; }

			const observer = new MutationObserver(() => {
				// Find the last model response element - broad selectors for resilience
				const responses = container.querySelectorAll(
					'.model-response-text, .markdown-main-panel, ' +
					'[data-message-author-role="model"], ' +
					'message-content[class*="model"], ' +
					'.response-container [class*="markdown"], ' +
					'[class*="response"][class*="text"]'
				);
				if (responses.length === 0) return;

				const lastResponse = responses[responses.length - 1];
				const text = lastResponse.innerText || lastResponse.textContent || '';

				// Only dispatch if text changed significantly (new response)
				if (text.length > lastKnownResponseText.length + 20) {
					lastKnownResponseText = text;
					// Debounce: wait 1s for streaming to settle
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
