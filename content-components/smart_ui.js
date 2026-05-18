/* global CURRENT_PLATFORM, sendBackgroundMessage, adapterQuery, getComposerText, observeComposer, Log, sleep, escapeHtml, replaceInnerHtml */
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

		// Cost estimate header (close button always present).
		html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">';
		html += '<div style="display:flex;align-items:baseline;gap:6px;">';
		html += `<span style="font-size:9px;font-weight:600;letter-spacing:0.08em;color:#94a3b8;text-transform:uppercase;">Est. cost</span>`;
		html += `<span style="font-size:15px;font-weight:700;color:#10b981;letter-spacing:-0.02em;font-variant-numeric:tabular-nums;">$${cost.toFixed(4)}</span>`;
		html += '</div>';
		html += `<span style="font-size:10px;color:#94a3b8;flex:1;text-align:right;font-variant-numeric:tabular-nums;">${tokens.toLocaleString()} tok</span>`;
		html += '<button class="ai-dec-close" aria-label="Dismiss cost preview" title="Dismiss" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:6px;transition:background 0.15s ease, color 0.15s ease;">×</button>';
		html += '</div>';

		// Task classification
		if (taskLabel && taskLabel !== 'chat') {
			html += `<div style="font-size:10px;opacity:0.5;margin-top:2px;">Detected: ${escapeHtml(taskLabel)} (${Math.round(confidence * 100)}%)</div>`;
		}

		// Sensitive-content warning. We never receive matched substrings --
		// just per-category counts -- so rendering them is safe.
		const sensitivity = decision.sensitivity;
		if (sensitivity?.findings?.length > 0) {
			const sev = sensitivity.maxSeverity;
			const sevColor = sev === 'block' ? '#ef4444' : sev === 'warn' ? '#f59e0b' : '#94a3b8';
			const sevIcon = sev === 'block' ? '⚠' : sev === 'warn' ? '⚠' : 'ⓘ';
			const sevLabel = sev === 'block' ? 'Sensitive content detected'
				: sev === 'warn' ? 'Possibly sensitive content'
				: 'Personal data detected';
			html += `<div style="margin-top:8px;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:8px;border-left:3px solid ${sevColor};">`;
			html += `<div style="font-size:11px;font-weight:600;color:${sevColor};">${escapeHtml(sevIcon)} ${escapeHtml(sevLabel)}</div>`;
			// Render up to 3 distinct categories with counts; truncate the
			// rest into a "+N more" tail.
			const top = sensitivity.findings.slice(0, 3);
			const tail = sensitivity.findings.length - top.length;
			html += '<div style="font-size:10px;color:#cbd5e1;margin-top:3px;line-height:1.4;">';
			html += top.map(f => `${escapeHtml(f.label)} ×${Number(f.count)}`).join(' · ');
			if (tail > 0) html += ` · +${Number(tail)} more`;
			html += '</div>';
			html += '</div>';
		}

		// Budget pressure
		if (budgetPct > 50) {
			const c = budgetPct > 90 ? '#ef4444' : budgetPct > 70 ? '#f59e0b' : '#6b7280';
			html += `<div style="font-size:10px;color:${c};margin-top:4px;">Budget: ${budgetPct.toFixed(0)}% used today</div>`;
		}

		// Recommendation panel
		if (rec && policy.action !== 'silent_pass') {
			const accent = policy.action === 'confirmation_gate' ? '#ef4444'
				: policy.action === 'inline_recommendation' ? '#f59e0b' : '#10b981';

			html += `<div style="margin-top:10px;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:10px;border:1px solid rgba(255,255,255,0.08);border-left:3px solid ${accent};">`;
			html += `<div style="font-size:11.5px;line-height:1.4;"><strong style="font-weight:700;">${escapeHtml(rec.candidateModel)}</strong> would save about <strong style="color:${accent};">${rec.savingsPct.toFixed(0)}%</strong></div>`;

			if (rec.qualityRisk && rec.qualityRisk !== 'unknown') {
				const rc = rec.qualityRisk === 'low' ? '#10b981' : rec.qualityRisk === 'medium' ? '#f59e0b' : '#ef4444';
				html += `<div style="font-size:10px;color:#cbd5e1;margin-top:4px;">Quality risk: <span style="color:${rc};font-weight:600;">${escapeHtml(rec.qualityRisk)}</span> for ${escapeHtml(rec.taskClass || 'this task')}</div>`;
			}

			html += `<div style="font-size:10px;color:#94a3b8;margin-top:4px;line-height:1.4;">${escapeHtml(rec.reason)}</div>`;

			if (policy.action === 'inline_recommendation' || policy.action === 'confirmation_gate') {
				html += '<div style="margin-top:8px;display:flex;gap:6px;">';
				html += `<button class="ai-dec-accept" style="background:${accent};color:white;border:none;border-radius:7px;padding:5px 10px;font-size:10.5px;font-weight:600;cursor:pointer;letter-spacing:0.005em;box-shadow:0 4px 10px rgba(0,0,0,0.2);transition:filter 0.15s ease;">Switch model</button>`;
				html += '<button class="ai-dec-dismiss" style="background:transparent;color:#cbd5e1;border:1px solid rgba(255,255,255,0.12);border-radius:7px;padding:5px 10px;font-size:10.5px;font-weight:500;cursor:pointer;transition:background 0.15s ease;">Dismiss</button>';
				html += '</div>';
			}
			html += '</div>';
		}

		if (policy.action === 'rewrite_first') {
			html += '<div style="margin-top:6px;font-size:10px;color:#f59e0b;">Consider shortening your prompt to reduce cost.</div>';
		}

		replaceInnerHtml(this.panelEl, html);
		this.panelEl.style.opacity = '1';
		this.panelEl.style.transform = 'translateY(0) scale(1)';

		// Wire buttons
		this.panelEl.querySelector('.ai-dec-accept')?.addEventListener('click', () => {
			this.recordAction('accepted', rec?.savingsPct);
			this.hidePanel();
		});
		this.panelEl.querySelector('.ai-dec-dismiss')?.addEventListener('click', () => {
			this.recordAction('dismissed');
			this.hidePanel();
		});
		this.panelEl.querySelector('.ai-dec-close')?.addEventListener('click', () => {
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
			this.panelEl.setAttribute('role', 'status');
			this.panelEl.setAttribute('aria-live', 'polite');
			this.panelEl.style.cssText = `
				position:fixed; bottom:80px; right:20px; pointer-events:auto;
				background:linear-gradient(180deg, rgba(22,33,62,0.96), rgba(15,23,42,0.96));
				color:#e6ecf7; border-radius:14px;
				padding:12px 14px; font-size:12px; max-width:320px; min-width:220px;
				border:1px solid rgba(255,255,255,0.10);
				font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
				box-shadow:0 12px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08);
				backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px);
				transition:opacity 0.2s ease, transform 0.2s ease;
				transform-origin: bottom right;
			`;
			this.portalRoot?.appendChild(this.panelEl);
		}
	}

	hidePanel() {
		if (this.panelEl) {
			this.panelEl.style.opacity = '0';
			this.panelEl.style.transform = 'translateY(4px) scale(0.98)';
			this.lastText = '';
		}
	}
}

const decisionUI = new DecisionUI();
decisionUI.init();
