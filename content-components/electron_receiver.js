'use strict';

// FIX #12: Renamed from electron_reciever.js (typo).
// FIX #11: setupRequestInterception is now defined once in content_utils.js, not duplicated here.

async function initElectronReceiver() {
	const isElectron = await browser.runtime.sendMessage({ type: 'isElectron' });
	if (!isElectron) return;

	console.log('Electron receiver initializing...');

	const patterns = await browser.runtime.sendMessage({ type: 'getMonkeypatchPatterns' });
	if (patterns) {
		// setupRequestInterception is defined in content_utils.js
		setupRequestInterception(patterns);
	}

	window.addEventListener('electronAlarmFired', (event) => {
		chrome.runtime.sendMessage({ type: 'electron-alarm', name: event.detail.name });
	});
	window.addEventListener('electronTabActivated', (event) => {
		chrome.runtime.sendMessage({ type: 'electronTabActivated', details: event.detail });
	});
	window.addEventListener('electronTabDeactivated', (event) => {
		chrome.runtime.sendMessage({ type: 'electronTabDeactivated', details: event.detail });
	});
	window.addEventListener('electronTabRemoved', (event) => {
		chrome.runtime.sendMessage({ type: 'electronTabRemoved', details: event.detail });
	});

	console.log('Electron receiver initialized');
}

initElectronReceiver();
