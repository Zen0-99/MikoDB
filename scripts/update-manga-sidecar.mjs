#!/usr/bin/env node
// update-manga-sidecar.mjs — refresh miko.json's mangaDb block after a
// successful build-manga-map.mjs run. Reads sha256 from
// dist/miko-manga-map.db.gz.sha256 and row count from the built DB's
// meta table. Run from the repo root.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const gzSha = fs.readFileSync('dist/miko-manga-map.db.gz.sha256', 'utf8').trim().split(/\s+/)[0];
const db = new DatabaseSync('dist/miko-manga-map.db', { open: true, readOnly: true });
const rows = Number(db.prepare("SELECT value FROM meta WHERE key = 'works'").get().value);
db.close();

const miko = JSON.parse(fs.readFileSync('miko.json', 'utf8'));
const dumpSha = fs.existsSync('dist/series.full.sqlite.zst.sha256')
    ? fs.readFileSync('dist/series.full.sqlite.zst.sha256', 'utf8').trim().split(/\s+/)[0]
    : null;
miko.mangaDb = {
    version: new Date().toISOString().slice(0, 10),
    sha256: gzSha,
    rows,
    url: 'https://github.com/Zen0-99/MikoDB/releases/download/db-latest/miko-manga-map.db.gz',
    // Raw upstream dump preserved alongside — lets the map be rebuilt
    // without MangaBaka (Phase 12-03 hardening).
    sourceDump: dumpSha && {
        sha256: dumpSha,
        url: 'https://github.com/Zen0-99/MikoDB/releases/download/db-latest/series.full.sqlite.zst',
    },
};
fs.writeFileSync('miko.json', JSON.stringify(miko, null, 2) + '\n');
console.log(`mangaDb -> v${miko.mangaDb.version} sha ${gzSha.slice(0, 12)}… rows ${rows}`);
