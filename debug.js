// debug.js
// Debug log viewer with: configurable durations, expiration notifications,
// timeline + by-topic views, and downloadable raw JSON. All behavior is
// backwards-compatible with users who only used the original button.

let autoRefreshInterval;
let currentView = 'timeline'; // 'timeline' | 'topics'
let lastSeenDebugUntil = null; // tracks expiration transitions for notifications

const VIEWS = {
	TIMELINE: 'timeline',
	TOPICS: 'topics'
};

document.getElementById('refresh').addEventListener('click', showLogs);
document.getElementById('clear').addEventListener('click', clearLogs);
document.getElementById('enableDebug').addEventListener('click', toggleDebugMode);
document.getElementById('downloadLogs').addEventListener('click', downloadLogs);

document.querySelectorAll('.view-tab').forEach(tab => {
	tab.addEventListener('click', () => {
		document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t === tab));
		currentView = tab.dataset.view;
		showLogs();
	});
});

// Persist duration choice across sessions so users don't have to reset it each
// time they open the debug page.
const durationSelect = document.getElementById('debugDuration');
browser.storage.local.get('debug_duration_minutes').then(r => {
	const saved = r.debug_duration_minutes;
	if (saved && [5, 10, 15, 30, 45, 60].includes(Number(saved))) durationSelect.value = String(saved);
});
durationSelect.addEventListener('change', () => {
	browser.storage.local.set({ debug_duration_minutes: Number(durationSelect.value) });
});

// Light/dark mode toggle
const themeToggle = document.getElementById('themeToggle');

function initTheme() {
	const saved = localStorage.getItem('debugTheme');
	if (saved) {
		setTheme(saved);
	} else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
		setTheme('light');
	} else {
		setTheme('dark');
	}
}

function setTheme(theme) {
	document.documentElement.setAttribute('data-theme', theme);
	themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
	themeToggle.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
	localStorage.setItem('debugTheme', theme);
}

themeToggle.addEventListener('click', () => {
	const current = document.documentElement.getAttribute('data-theme');
	setTheme(current === 'dark' ? 'light' : 'dark');
});

initTheme();

// Classify a log line into a topic for the "By topic" view. Pure pattern match,
// keeps the categorization stable across runs so users can build intuition.
const TOPIC_ORDER = [
	{ key: 'errors', label: 'Errors & warnings' },
	{ key: 'requests', label: 'Requests & interception' },
	{ key: 'models', label: 'Models & tokens' },
	{ key: 'storage', label: 'Storage & state' },
	{ key: 'messaging', label: 'Messaging & tab events' },
	{ key: 'misc', label: 'Other' }
];
function classifyTopic(log) {
	if (log.level === 'warn' || log.level === 'error') return 'errors';
	const m = String(log.message || '').toLowerCase();
	if (/(intercept|request|completion|fetch|webrequest|http)/.test(m)) return 'requests';
	if (/(model=|token|input|output|sonnet|opus|haiku|gpt-|gemini|mistral)/.test(m)) return 'models';
	if (/(storage|cache|state|map|persist|alarm)/.test(m)) return 'storage';
	if (/(sendmessage|tab|navigation|content script|background)/.test(m)) return 'messaging';
	return 'misc';
}

function buildLogLine(log) {
	const logLine = document.createElement('div');
	logLine.className = 'log-line';
	logLine.dataset.level = log.level || 'debug';

	const timestamp = document.createElement('span');
	timestamp.className = 'log-timestamp';
	timestamp.textContent = log.timestamp;

	const sender = document.createElement('span');
	sender.className = 'log-sender';
	sender.dataset.sender = log.sender;
	sender.textContent = log.sender;

	const message = document.createElement('span');
	message.className = 'log-message';
	message.textContent = log.message;

	logLine.appendChild(timestamp);
	logLine.appendChild(sender);
	logLine.appendChild(message);
	return logLine;
}

function showLogs() {
	browser.storage.local.get('debug_logs').then(result => {
		const logs = result.debug_logs || [];
		const preElement = document.getElementById('logs');
		preElement.innerHTML = '';

		if (logs.length === 0) {
			const emptyState = document.createElement('div');
			emptyState.className = 'log-empty';
			emptyState.textContent = 'No debug logs yet. Enable debug mode and interact with a supported site to start collecting sanitized events.';
			preElement.appendChild(emptyState);
			return;
		}

		if (currentView === VIEWS.TOPICS) {
			renderTopics(preElement, logs);
		} else {
			for (const log of logs) preElement.appendChild(buildLogLine(log));
			scrollToBottom();
		}
	});
}

function renderTopics(container, logs) {
	const groups = new Map();
	for (const log of logs) {
		const t = classifyTopic(log);
		if (!groups.has(t)) groups.set(t, []);
		groups.get(t).push(log);
	}
	for (const { key, label } of TOPIC_ORDER) {
		const entries = groups.get(key);
		if (!entries || entries.length === 0) continue;
		const group = document.createElement('div');
		group.className = 'topic-group';

		const header = document.createElement('div');
		header.className = 'topic-header';
		const labelEl = document.createElement('span');
		labelEl.textContent = label;
		const countEl = document.createElement('span');
		countEl.className = 'topic-count';
		countEl.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
		header.appendChild(labelEl);
		header.appendChild(countEl);
		group.appendChild(header);

		const body = document.createElement('div');
		body.className = 'topic-body';
		for (const log of entries) body.appendChild(buildLogLine(log));
		group.appendChild(body);

		container.appendChild(group);
	}
}

function scrollToBottom() {
	const preElement = document.getElementById('logs');
	preElement.scrollTop = preElement.scrollHeight;
}

function clearLogs() {
	browser.storage.local.set({ debug_logs: [] }).then(showLogs);
}

function downloadLogs() {
	browser.storage.local.get('debug_logs').then(result => {
		const logs = result.debug_logs || [];
		const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `ai-tracker-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
}

function updateDebugStatus() {
	browser.storage.local.get('debug_mode_until').then(result => {
		const debugUntil = result.debug_mode_until;
		const now = Date.now();
		const isEnabled = debugUntil && debugUntil > now;
		const timeLeft = isEnabled ? Math.ceil((debugUntil - now) / 60000) : 0;

		const statusElement = document.getElementById('debugStatus');
		statusElement.textContent = isEnabled
			? `Debug mode enabled (${timeLeft} minute${timeLeft === 1 ? '' : 's'} remaining)`
			: 'Debug mode disabled';

		const debugButton = document.getElementById('enableDebug');
		debugButton.textContent = isEnabled ? 'Disable Debug Mode' : 'Enable Debug Mode';
		debugButton.dataset.state = isEnabled ? 'enabled' : 'disabled';

		// Detect transition from enabled → disabled while this page is open.
		// The background script also fires a notification via an alarm; this
		// in-page banner gives instant feedback when the user is already here.
		if (lastSeenDebugUntil && lastSeenDebugUntil > 0 && !isEnabled) {
			flashCompletionBanner();
		}
		lastSeenDebugUntil = isEnabled ? debugUntil : 0;

		if (!isEnabled && autoRefreshInterval) {
			stopAutoRefresh();
		} else if (isEnabled && !autoRefreshInterval) {
			startAutoRefresh();
		}
	});
}

function flashCompletionBanner() {
	const status = document.getElementById('debugStatus');
	const original = status.textContent;
	status.textContent = 'Debug mode finished — logs are ready';
	status.style.background = 'rgba(16,163,127,0.2)';
	setTimeout(() => {
		status.style.background = '';
		// Don't overwrite a fresh message; only restore if still the completion text.
		if (status.textContent === 'Debug mode finished — logs are ready') status.textContent = original;
	}, 6000);
	showLogs();
}

function toggleDebugMode() {
	browser.storage.local.get('debug_mode_until').then(result => {
		const debugUntil = result.debug_mode_until;
		const now = Date.now();
		const isEnabled = debugUntil && debugUntil > now;
		const minutes = Number(durationSelect.value) || 60;

		if (isEnabled) {
			// Cancel and clear the scheduled expiration notification alarm.
			return Promise.all([
				browser.storage.local.set({ debug_mode_until: now }),
				browser.runtime.sendMessage({ type: 'cancelDebugExpiration' }).catch(() => null)
			]);
		}
		const until = Date.now() + minutes * 60 * 1000;
		return Promise.all([
			browser.storage.local.set({ debug_mode_until: until }),
			browser.runtime.sendMessage({ type: 'scheduleDebugExpiration', until }).catch(() => null)
		]);
	}).then(() => updateDebugStatus());
}

function startAutoRefresh() {
	if (!autoRefreshInterval) {
		autoRefreshInterval = setInterval(() => {
			if (document.getElementById('autoUpdate').checked) showLogs();
			updateDebugStatus();
		}, 5000);
	}
}

function stopAutoRefresh() {
	if (autoRefreshInterval) {
		clearInterval(autoRefreshInterval);
		autoRefreshInterval = null;
	}
}

showLogs();
updateDebugStatus();
startAutoRefresh();

if (!chrome.tabs?.create) {
	const returnButton = document.getElementById('returnToClaude');
	returnButton.style.display = 'inline-block';
	returnButton.addEventListener('click', () => { window.location.href = 'https://claude.ai'; });
}

window.addEventListener('beforeunload', stopAutoRefresh);
