#!/usr/bin/env node
// build-manga-map.mjs — MangaBaka series.sqlite → miko-manga-map.db
//
// Run:  node --experimental-sqlite build-manga-map.mjs <series.sqlite> [outDir] [--sample N]
//
// Emits miko-manga-map.db (+ .gz + .sha256) with:
//   works(miko_work_id, mangabaka_id, type, title, romanized_title,
//         native_title, year, total_chapters, status, content_rating)
//   titles(miko_work_id, title, lang, normalized, is_primary)
//   source_ids(miko_work_id, provider, external_id)
//   provider_links(miko_work_id, provider, external_id, url)
//   meta(key, value)
//
// Normalizer MUST match the Kotlin TitleNormalizer (NFKC + casefold +
// non-word strip + space collapse). Golden vectors live in
// app/src/test/resources/title_normalizer_golden.json (07-02).

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const [,, src, outDir = '.', ...flags] = process.argv;
const sampleIdx = flags.indexOf('--sample');
const SAMPLE = sampleIdx >= 0 ? parseInt(flags[sampleIdx + 1], 10) : null;

if (isMain && (!src || !fs.existsSync(src))) {
    console.error('usage: node --experimental-sqlite build-manga-map.mjs <series.sqlite> [outDir] [--sample N]');
    process.exit(1);
}

// ---- TitleNormalizer twin (keep in sync with TitleNormalizer.kt) ----
const NONWORD = /[^\p{L}\p{N}\s]/gu;
const SPACES = /\s+/g;
export function normalize(t) {
    if (!t) return '';
    return t.normalize('NFKC').toLowerCase().replace(NONWORD, ' ').replace(SPACES, ' ').trim();
}

async function build() {
fs.mkdirSync(outDir, { recursive: true });
const outDb = path.join(outDir, 'miko-manga-map.db');
if (fs.existsSync(outDb)) fs.unlinkSync(outDb);

const PROVIDER_ID_COLS = {
    anilist: 'source_anilist_id',
    mal: 'source_my_anime_list_id',
    manga_updates: 'source_manga_updates_id',
    kitsu: 'source_kitsu_id',
    anime_planet: 'source_anime_planet_id',
    shikimori: 'source_shikimori_id',
    anime_news_network: 'source_anime_news_network_id',
};

// provider_links external_id extractors (chapter-alignment seeds)
const LINK_EXTRACTORS = [
    [/mangadex\.org\/title\/([0-9a-f-]{36})/i, 'mangadex'],
    [/webtoons\.com[^?]*\?[^"]*title_no=(\d+)/i, 'webtoons'],
    [/webtoons\.com\/[^/]+\/[^/]+\/[^/]+\/list\?title_no=(\d+)/i, 'webtoons'],
    [/novelupdates\.com\/series\/([\w-]+)/i, 'novelupdates'],
    [/royalroad\.com\/fiction\/(\d+)/i, 'royalroad'],
    [/comic\.naver\.com\/webtoon\/list.*titleId=(\d+)/i, 'naver'],
];

const srcDb = new DatabaseSync(src, { open: true, readOnly: true });
const cols = srcDb.prepare('PRAGMA table_info(series)').all().map(c => c.name);
const altCols = cols.filter(c => c.startsWith('secondary_titles'));
const selectCols = ['id', 'type', 'title', 'romanized_title', 'native_title', 'year',
    'total_chapters', 'status', 'content_rating', 'authors', 'titles',
    ...altCols, ...Object.values(PROVIDER_ID_COLS).filter(c => cols.includes(c)),
    'links_v2'].filter(c => cols.includes(c));

const out = new DatabaseSync(outDb);
out.exec(`
PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
CREATE TABLE works(
    miko_work_id TEXT PRIMARY KEY, mangabaka_id INTEGER, type TEXT,
    title TEXT, romanized_title TEXT, native_title TEXT, year INTEGER,
    total_chapters TEXT, status TEXT, content_rating TEXT, author TEXT);
CREATE TABLE titles(
    miko_work_id TEXT NOT NULL, title TEXT, lang TEXT,
    normalized TEXT NOT NULL, is_primary INTEGER DEFAULT 0);
CREATE INDEX idx_titles_norm ON titles(normalized);
CREATE TABLE source_ids(
    miko_work_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT NOT NULL,
    PRIMARY KEY(provider, external_id));
CREATE INDEX idx_source_work ON source_ids(miko_work_id);
CREATE TABLE provider_links(
    miko_work_id TEXT NOT NULL, provider TEXT NOT NULL, external_id TEXT, url TEXT);
CREATE INDEX idx_plinks ON provider_links(provider, external_id);
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
`);

const insWork = out.prepare('INSERT INTO works VALUES (?,?,?,?,?,?,?,?,?,?,?)');
const insTitle = out.prepare('INSERT INTO titles VALUES (?,?,?,?,?)');
const insSrc = out.prepare('INSERT OR IGNORE INTO source_ids VALUES (?,?,?)');
const insLink = out.prepare('INSERT INTO provider_links VALUES (?,?,?,?)');

let rows = 0, titleRows = 0, linkRows = 0, srcRows = 0;
const limit = SAMPLE ? ` LIMIT ${SAMPLE}` : '';
const seenTitles = new Set();

out.exec('BEGIN');
for (const r of srcDb.prepare(`SELECT ${selectCols.map(c => `"${c}"`).join(',')} FROM series${limit}`).iterate()) {
    const wid = `mk:mb:${r.id}`;
    let author = null;
    try { author = JSON.parse(r.authors || '[]')[0] ?? null; } catch { /* ignore */ }
    insWork.run(wid, r.id, r.type, r.title, r.romanized_title, r.native_title,
        r.year, r.total_chapters != null ? String(r.total_chapters) : null,
        r.status, r.content_rating, author);

    seenTitles.clear();
    const addTitle = (t, lang, primary) => {
        const n = normalize(t);
        if (!n || seenTitles.has(n)) return;
        seenTitles.add(n);
        insTitle.run(wid, t, lang, n, primary ? 1 : 0);
        titleRows++;
    };
    addTitle(r.title, 'en', true);
    addTitle(r.romanized_title, 'ja-ro', false);
    addTitle(r.native_title, 'native', false);
    try {
        for (const t of JSON.parse(r.titles || '[]'))
            if (t && t.title) addTitle(t.title, t.language || 'unknown', t.is_primary ? 1 : 0);
    } catch { /* ignore */ }
    for (const c of altCols) {
        const v = r[c];
        if (!v) continue;
        const lang = c.replace('secondary_titles_', '');
        try { for (const t of JSON.parse(v)) addTitle(t, lang, false); } catch { /* ignore */ }
    }

    for (const [provider, col] of Object.entries(PROVIDER_ID_COLS)) {
        const v = r[col];
        if (v != null && v !== '') { insSrc.run(wid, provider, String(v)); srcRows++; }
    }

    try {
        for (const l of JSON.parse(r.links_v2 || '[]')) {
            if (!l || !l.url) continue;
            let provider = null, ext = null;
            for (const [re, name] of LINK_EXTRACTORS) {
                const m = re.exec(l.url);
                if (m) { provider = name; ext = m[1]; break; }
            }
            if (provider) {
                insLink.run(wid, provider, ext, l.url);
                linkRows++;
            }
        }
    } catch { /* ignore */ }
    rows++;
    if (rows % 50000 === 0) console.log(`  ${rows} works...`);
}
out.exec('COMMIT');

async function fileHash(file, algo) {
    const h = createHash(algo);
    await new Promise((res, rej) => fs.createReadStream(file)
        .on('data', d => h.update(d)).on('end', res).on('error', rej));
    return h.digest('hex');
}

const version = new Date().toISOString().slice(0, 10);
const srcSha1 = await fileHash(src, 'sha1');
out.prepare('INSERT INTO meta VALUES (?,?)').run('version', version);
out.prepare('INSERT INTO meta VALUES (?,?)').run('source_dump_sha1', srcSha1);
out.prepare('INSERT INTO meta VALUES (?,?)').run('works', String(rows));
out.close();

const gz = outDb + '.gz';
fs.createReadStream(outDb)
    .pipe(createGzip({ level: 9 }))
    .pipe(fs.createWriteStream(gz))
    .on('finish', async () => {
        const sha = await fileHash(gz, 'sha256');
        fs.writeFileSync(gz + '.sha256', `${sha}  miko-manga-map.db.gz\n`);
        const sz = fs.statSync(gz).size;
        console.log(JSON.stringify({ works: rows, titles: titleRows, source_ids: srcRows, provider_links: linkRows, gz_bytes: sz, sha256: sha }, null, 2));
    });
}

if (isMain) build();
