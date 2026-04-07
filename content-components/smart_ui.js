/* global CURRENT_PLATFORM, sendBackgroundMessage, adapterQuery, getComposerText, observeComposer, Log, sleep */
'use strict';

// content-components/smart_ui.js
// Unified decision UI. One panel, one evaluation pipeline, one feedback loop.
// Replaces the fragmented preview/chip/toast approach.

class DecisionUI {
	constructor() {
		this.portalRoot = null;
		this.panelEl = null;
		this.disconnectComposer = null;
		this.lastText = '';
		this.debounceTimer = null;
		this.lastDecision = null;
		this.sessionId = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
	}

	async init() {
		if (!CURRENT_PLATFORM) return;
		await sleep(2000);
		this.createPortalRoot();
		this.startComposerObserver();
	}

	createPortalRoot() {
		if (document.getElementById('ai-tracker-decision-root')) return;
		this.portalRoot = document.createElement('div');
		this.portalRoot.id = 'ai-tracker-decision-root';
		this.portalRoot.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483640;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;';
		document.body.appendChild(this.portalRoot);
	}

	startComposerObserver() {
		const tryConnect = () => {
			this.disconnectComposer = observeComposer((text) => {
				clearTimeout(this.debounceTimer);
				this.debounceTimer = setTimeout(() => this.onTextChange(text), 400);
			});
		};
		tryConnect();
		const retry = setInterval(() => {
			if (adapterQuery('textarea')) {
				if (this.disconnectComposer) this.disconnectComposer();
				tryConnect();
				clearInterval(retry);
			}
		}, 5000);
		setTimeout(() => clearInterval(retry), 30000);
	}

	async onTextChange(text) {
		if (!text || text.length < 10) { this.hidePanel(); return; }
		if (text === this.lastText) return;
		this.lastText = text;

		try {
			const decision = await sendBackgroundMessage({
				type: 'evaluateDecision',
				platform: CURRENT_PLATFORM,
				text: text.slice(0, 10000),
				phase: 'typing',
				sessionId: this.sessionId
			});
			this.lastDecision = decision;
			this.renderDecision(decision);
		} catch (e) { /* ignore */ }
	}

	renderDecision(decision) {
		if (!decision) { this.hidePanel(); return; }
		const { policy, estimates, recommendations, budgetState } = decision;

		if (policy.action === 'silent_pass') { this.hidePanel(); return; }

		this.ensurePanel();

		const cost = estimates.costEstimateUSD || 0;
		const tokens = estimates.inputTokens || 0;
		const taskLabel = decision.task?.taskClass || '';
		const confidence = decision.task?.confidence || 0;
		const rec = recommendations?.[0];
		const budgetPct = budgetState?.dailyConsumedPct || 0;

		let html = '';

		// Cost estimate header
		html += '<div style="display:flex;justify-content:space-between;align-items:baseline;">';
		html += `<span style="font-size:14px;font-weight:600;color:#10b981;">$${cost.toFixed(4)}</span>`;
		html += `<span style="font-size:10px;opacity:0.5;">${tokens.toLocaleString()} tokens</span>`;
		html += '</div>';

		// Task classification
		if (taskLabel && taskLabel !== 'chat') {
			html += `<div style="font-size:10px;opacity:0.5;margin-top:2px;">Detected: ${taskLabel} (${Math.round(confidence * 100)}%)</div>`;
		}

		// Budget pressure
		if (budgetPct > 50) {
			const c = budgetPct > 90 ? '#ef4444' : budgetPct > 70 ? '#f59e0b' : '#6b7280';
			html += `<div style="font-size:10px;color:${c};margin-top:4px;">Budget: ${budgetPct.toFixed(0)}% used today</div>`;
		}

		// Recommendation panel
		if (rec && policy.action !== 'silent_pass') {
			const border = policy.action === 'confirmation_gate' ? 'border-left:3px solid #ef4444;' :
				policy.action === 'inline_recommendation' ? 'border-left:3px solid #f59e0b;' : '';

			html += `<div style="margin-top:8px;padding:6px 8px;background:rgba(255,255,255,0.05);border-radius:6px;${border}">`;
			html += `<div style="font-size:11px;"><strong>${rec.candidateModel}</strong> saves ~${rec.savingsPct.toFixed(0)}%</div>`;

			if (rec.qualityRisk && rec.qualityRisk !== 'unknown') {
				const rc = rec.qualityRisk === 'low' ? '#10b981' : rec.qualityRisk === 'medium' ? '#f59e0b' : '#ef4444';
				html += `<div style="font-size:10px;opacity:0.7;">Quality risk: <span style="color:${rc};">${rec.qualityRisk}</span> for ${rec.taskClass || 'this task'}</div>`;
			}

			html += `<div style="font-size:10px;opacity:0.5;margin-top:2px;">${rec.reason}</div>`;

			if (policy.action === 'inline_recommendation' || policy.action === 'confirmation_gate') {
				html += '<div style="margin-top:6px;display:flex;gap:6px;">';
				html += '<button class="ai-dec-accept" style="background:#10b981;color:white;border:none;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer;">Switch model</button>';
				html += '<button class="ai-dec-dismiss" style="background:none;color:#8899aa;border:1px solid #334155;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer;">Dismiss</button>';
				html += '</div>';
			}
			html += '</div>';
		}

		if (policy.action === 'rewrite_first') {
			html += '<div style="margin-top:6px;font-size:10px;color:#f59e0b;">Consider shortening your prompt to reduce cost.</div>';
		}

		this.panelEl.innerHTML = html;
		this.panelEl.style.opacity = '1';

		// Wire buttons
		this.panelEl.querySelector('.ai-dec-accept')?.addEventListener('click', () => {
			this.recordAction('accepted', rec?.savingsPct);
			this.hidePanel();
		});
		this.panelEl.querySelector('.ai-dec-dismiss')?.addEventListener('click', () => {
			this.recordAction('dismissed');
			this.hidePanel();
		});
	}

	async recordAction(action, savingsPct) {
		if (!this.lastDecision) return;
		try {
			const cost = this.lastDecision.estimates?.costEstimateUSD || 0;
			await sendBackgroundMessage({
				type: 'recordUserAction',
				requestId: this.lastDecision.requestId,
				action,
				savingsCaptured: action === 'accepted' ? cost * (savingsPct || 0) / 100 : 0,
				savingsMissed: action === 'dismissed' ? cost * (savingsPct || 0) / 100 : 0
			});
		} catch (e) { /* non-critical */ }
	}

	ensurePanel() {
		if (!this.panelEl) {
			this.panelEl = document.createElement('div');
			this.panelEl.style.cssText = `
				position:fixed; bottom:80px; right:20px; pointer-events:auto;
				background:rgba(22,33,62,0.95); color:#e0e0e0; border-radius:10px;
				padding:10px 14px; font-size:12px; max-width:300px; min-width:200px;
				border:1px solid rgba(255,255,255,0.1); backdrop-filter:blur(8px);
				box-shadow:0 4px 20px rgba(0,0,0,0.3); transition:opacity 0.2s;
			`;
			this.portalRoot?.appendChild(this.panelEl);
		}
	}

	hidePanel() {
		if (this.panelEl) { this.panelEl.style.opacity = '0'; this.lastText = ''; }
	}
}

const decisionUI = new DecisionUI();
decisionUI.init();
