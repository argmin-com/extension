#!/usr/bin/env node
// scripts/check-dataclasses.js
// CI/pre-commit guard: ensure content-components/ui_dataclasses.js is in sync
// with shared/dataclasses.js. Fails if regenerating would change the file.
const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const sourceFile = path.join(rootDir, 'shared', 'dataclasses.js');
const outputFile = path.join(rootDir, 'content-components', 'ui_dataclasses.js');

const source = fs.readFileSync(sourceFile, 'utf8');
const expected = source
	.replace(/^import\s+.*?;\s*\n/gm, '')
	.replace(/^export\s+/gm, '')
	.replace(/^/, '/* global CONFIG */\n\'use strict\';\n\n');

const actual = fs.readFileSync(outputFile, 'utf8');

if (actual !== expected) {
	console.error('FAIL: content-components/ui_dataclasses.js is out of sync with shared/dataclasses.js');
	console.error('Run `node scripts/build-dataclasses.js` and commit the result.');
	process.exit(1);
}
console.log('PASS: ui_dataclasses.js is in sync with shared/dataclasses.js');
