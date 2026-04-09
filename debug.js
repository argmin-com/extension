// debug.js
let autoRefreshInterval;

document.getElementById('refresh').addEventListener('click', showLogs);
document.getElementById('clear').addEventListener('click', clearLogs);
document.getElementById('enableDebug').addEventListener('click', toggleDebugMode);

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

function showLogs() {
	browser.storage.local.get('debug_logs')
		.then(result => {
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

			logs.forEach(log => {
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
				preElement.appendChild(logLine);
			});

			scrollToBottom();
		});
}

function scrollToBottom() {
	const preElement = document.getElementById('logs');
	preElement.scrollTop = preElement.scrollHeight;
}

function clearLogs() {
	browser.storage.local.set({ debug_logs: [] }).then(showLogs);
}

function updateDebugStatus() {
	browser.storage.local.get('debug_mode_until')
		.then(result => {
			const debugUntil = result.debug_mode_until;
			const now = Date.now();
			const isEnabled = debugUntil && debugUntil > now;
			const timeLeft = isEnabled ? Math.ceil((debugUntil - now) / 60000) : 0;

			const statusElement = document.getElementById('debugStatus');
			statusElement.textContent = isEnabled
				? `Debug mode enabled (${timeLeft} minutes remaining)`
				: 'Debug mode disabled';

			const debugButton = document.getElementById('enableDebug');
			debugButton.textContent = isEnabled
				? 'Disable Debug Mode'
				: 'Enable Debug Mode (1 hour)';
			debugButton.dataset.state = isEnabled ? 'enabled' : 'disabled';

			if (!isEnabled && autoRefreshInterval) {
				stopAutoRefresh();
			} else if (isEnabled && !autoRefreshInterval) {
				startAutoRefresh();
			}
		});
}

function toggleDebugMode() {
	browser.storage.local.get('debug_mode_until')
		.then(result => {
			const debugUntil = result.debug_mode_until;
			const now = Date.now();
			const isEnabled = debugUntil && debugUntil > now;

			if (isEnabled) {
				return browser.storage.local.set({ debug_mode_until: now });
			} else {
				return browser.storage.local.set({ debug_mode_until: Date.now() + 60 * 60 * 1000 });
			}
		})
		.then(() => updateDebugStatus());
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
