#!/usr/bin/env node
// validate-miko-json.mjs — schema + tier checks for miko.json source
// blocks (Phase 12-03). Exits non-zero on any violation so it can gate CI.
//
//   node scripts/validate-miko-json.mjs

import fs from 'node:fs';

const TIERS = new Set(['S', 'A', 'B', 'C']);
const miko = JSON.parse(fs.readFileSync('miko.json', 'utf8'));
let failures = 0;
const fail = (msg) => { failures++; console.error(`FAIL ${msg}`); };

function checkBlock(name, block, { requireProviders = false } = {}) {
    if (block === undefined) { fail(`${name}: missing`); return; }
    if (typeof block !== 'object' || Array.isArray(block)) {
        fail(`${name}: must be an object keyed by pkgName`);
        return;
    }
    for (const [pkg, meta] of Object.entries(block)) {
        if (!meta.name) fail(`${name}.${pkg}: missing name`);
        if (!TIERS.has(meta.tier)) fail(`${name}.${pkg}: bad tier '${meta.tier}'`);
        if (requireProviders && !Array.isArray(meta.providers)) {
            fail(`${name}.${pkg}: providers must be an array`);
        }
    }
    const tiers = {};
    for (const v of Object.values(block)) tiers[v.tier] = (tiers[v.tier] ?? 0) + 1;
    console.log(`${name}: ${Object.keys(block).length} sources — tiers ${JSON.stringify(tiers)}`);
}

checkBlock('sources', miko.sources);
checkBlock('manga_sources', miko.manga_sources, { requireProviders: true });
checkBlock('novel_sources', miko.novel_sources, { requireProviders: true });

// Golden-source joins need at least one S-tier entry per block that
// feeds canonical structure (manga + novel).
for (const name of ['manga_sources', 'novel_sources']) {
    const hasS = Object.values(miko[name] ?? {}).some((m) => m.tier === 'S');
    if (!hasS) fail(`${name}: no S-tier golden source`);
}

if (failures === 0) {
    console.log('miko.json: OK');
} else {
    console.error(`miko.json: ${failures} failure(s)`);
    process.exit(1);
}
