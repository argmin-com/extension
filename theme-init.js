// theme-init.js
// Run synchronously in <head> to set data-theme before paint and avoid a
// flash of the wrong theme. We mirror the saved preference into the popup
// origin's localStorage so it can be read synchronously here, and also
// into chrome.storage.local (written later by popup.js) so it survives
// across browser-storage clears.
(function () {
	try {
		const stored = localStorage.getItem('themePref') || 'auto';
		const sysLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
		const theme = stored === 'auto' ? (sysLight ? 'light' : 'dark') : stored;
		document.documentElement.setAttribute('data-theme', theme);
	} catch (_e) {
		document.documentElement.setAttribute('data-theme', 'dark');
	}
})();
