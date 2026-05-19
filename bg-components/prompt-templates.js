// bg-components/prompt-templates.js
// Local prompt-template library. Templates are short, named snippets
// the user creates from the popup. A template body may contain
// `{{name}}` placeholders that the composer-side filler swaps in before
// inserting. All storage is local; no off-device sync.
//
// Storage shape:
//   getStorageValue('promptTemplates', []) -> [
//     { id, name, body, slug, createdAt, updatedAt }
//   ]
//
// `id`   - stable across renames/edits, used as the lookup key
// `slug` - lowercase shortcut prefixed with `/`, e.g. `/code-review`
// `body` - free-text template with optional `{{var}}` placeholders.
//          Renders verbatim if no placeholders; the popup's preview
//          shows which placeholders the body will ask for at insert.

import { getStorageValue, setStorageValue } from './utils.js';

const STORAGE_KEY = 'promptTemplates';
const MAX_TEMPLATES = 200;
const MAX_NAME_LEN = 80;
const MAX_BODY_LEN = 8000;
const MAX_SLUG_LEN = 32;

function genId() {
	return 'tpl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function normalizeSlug(raw) {
	if (typeof raw !== 'string') return '';
	let s = raw.trim().toLowerCase();
	if (s.startsWith('/')) s = s.slice(1);
	s = s.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
	return s.slice(0, MAX_SLUG_LEN);
}

function normalizeTemplate(t, existing = null) {
	const name = String(t.name ?? '').trim().slice(0, MAX_NAME_LEN);
	const body = String(t.body ?? '').slice(0, MAX_BODY_LEN);
	const slug = normalizeSlug(t.slug ?? name);
	const now = Date.now();
	return {
		id: existing?.id || t.id || genId(),
		name,
		slug,
		body,
		createdAt: existing?.createdAt || now,
		updatedAt: now
	};
}

/**
 * Extract the placeholder names a template body asks for, in order of
 * first appearance, deduplicated. Returns ['name', 'role'] for a body
 * like "Hello {{name}}, your role is {{role}}. ({{name}})".
 */
function extractPlaceholders(body) {
	const out = [];
	const seen = new Set();
	const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
	let m;
	while ((m = re.exec(String(body || ''))) !== null) {
		const name = m[1];
		if (!seen.has(name)) { seen.add(name); out.push(name); }
	}
	return out;
}

/**
 * Fill placeholders. Unknown placeholders are left as `{{name}}` so the
 * user sees what wasn't substituted rather than getting a silently
 * mangled prompt. Values are converted to string via String().
 */
function renderTemplate(body, values = {}) {
	if (typeof body !== 'string') return '';
	return body.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (full, name) => {
		if (!Object.prototype.hasOwnProperty.call(values, name)) return full;
		return String(values[name] ?? '');
	});
}

async function listTemplates() {
	const raw = await getStorageValue(STORAGE_KEY, []);
	return Array.isArray(raw) ? raw : [];
}

async function saveTemplate(t) {
	const list = await listTemplates();
	if (!t || typeof t !== 'object') throw new Error('saveTemplate: missing payload');
	const existing = t.id ? list.find(x => x.id === t.id) : null;
	const normalized = normalizeTemplate(t, existing);
	if (!normalized.name) throw new Error('saveTemplate: name is required');

	// Slug uniqueness: if a different template already owns this slug,
	// suffix with -2, -3, ... until free. Keeps the user's typed slug
	// intact when there's no collision. Truncate the BASE before
	// appending the suffix -- truncating after means a base at
	// MAX_SLUG_LEN-1 with suffix "-2" gets sliced back to the same
	// string as the colliding base, looping until the n>1000 break and
	// shipping a non-unique slug.
	if (normalized.slug) {
		let candidate = normalized.slug;
		let n = 2;
		while (list.some(x => x.slug === candidate && x.id !== normalized.id)) {
			const suffix = `-${n++}`;
			const baseRoom = Math.max(0, MAX_SLUG_LEN - suffix.length);
			candidate = normalized.slug.slice(0, baseRoom) + suffix;
			if (n > 1000) break;
		}
		normalized.slug = candidate;
	}

	let next;
	if (existing) {
		next = list.map(x => x.id === existing.id ? normalized : x);
	} else {
		next = [...list, normalized];
	}
	// Cap library size; drop oldest if over.
	if (next.length > MAX_TEMPLATES) {
		next.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
		next = next.slice(0, MAX_TEMPLATES);
	}
	await setStorageValue(STORAGE_KEY, next);
	return normalized;
}

async function deleteTemplate(id) {
	const list = await listTemplates();
	const next = list.filter(x => x.id !== id);
	if (next.length === list.length) return false;
	await setStorageValue(STORAGE_KEY, next);
	return true;
}

async function findTemplateBySlug(slug) {
	const norm = normalizeSlug(slug);
	if (!norm) return null;
	const list = await listTemplates();
	return list.find(x => x.slug === norm) || null;
}

export {
	listTemplates,
	saveTemplate,
	deleteTemplate,
	findTemplateBySlug,
	extractPlaceholders,
	renderTemplate,
	normalizeSlug,
	MAX_TEMPLATES,
	MAX_NAME_LEN,
	MAX_BODY_LEN,
	MAX_SLUG_LEN
};
