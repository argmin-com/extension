const fs = require('fs');
const os = require('os');
const path = require('path');
const { test: base, expect, chromium } = require('@playwright/test');

const extensionPath = path.resolve(__dirname, '..', '..', '..');

const test = base.extend({
	extensionContext: [async ({}, use) => {
		const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tracker-e2e-'));
		const extensionContext = await chromium.launchPersistentContext(userDataDir, {
			channel: 'chromium',
			headless: true,
			args: [
				`--disable-extensions-except=${extensionPath}`,
				`--load-extension=${extensionPath}`
			]
		});

		await use(extensionContext);
		await extensionContext.close();
		fs.rmSync(userDataDir, { recursive: true, force: true });
	}, { scope: 'worker' }],

	serviceWorker: [async ({ extensionContext }, use) => {
		let serviceWorker = extensionContext.serviceWorkers()[0];
		if (!serviceWorker) {
			serviceWorker = await extensionContext.waitForEvent('serviceworker');
		}

		await use(serviceWorker);
	}, { scope: 'worker' }],

	extensionId: [async ({ serviceWorker }, use) => {
		await use(new URL(serviceWorker.url()).host);
	}, { scope: 'worker' }],

	extensionPage: async ({ extensionContext, extensionId }, use) => {
		await use(async (relativePath) => {
			const page = await extensionContext.newPage();
			await page.goto(`chrome-extension://${extensionId}/${relativePath}`);
			return page;
		});
	},

	storage: async ({ serviceWorker }, use) => {
		const clear = async () => {
			await serviceWorker.evaluate(async () => {
				await browser.storage.local.clear();
			});
		};
		const get = async (keys = null) => {
			return await serviceWorker.evaluate(async (requestedKeys) => {
				return await browser.storage.local.get(requestedKeys);
			}, keys);
		};
		const set = async (values) => {
			await serviceWorker.evaluate(async (items) => {
				await browser.storage.local.set(items);
			}, values);
		};

		await clear();
		await use({ clear, get, set });
		await clear();
	}
});

module.exports = { test, expect };
