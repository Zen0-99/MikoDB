#!/usr/bin/env node
/**
 * check-episodes — validation gate for the anime_episodes table inside a built
 * miko-anime-map.db. Runs locally and in CI before the artifact is published.
 *
 *   node scripts/check-episodes.mjs [path/to/miko-anime-map.db]
 *
 * Exits 1 on: db unreadable, table missing/empty, ep_key/type outside the
 * locked vocabulary, main rows without abs_number, specials with a non-zero
 * season, ep_key/number divergence (verbatim-storage check), or residual
 * "Source: X" overview trailers. Exits 0 and prints row/type counts on a sane
 * build.
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2] || 'dist/miko-anime-map.db';

let db;
try {
  db = new Database(dbPath, { readonly: true });
} catch (e) {
  console.error('check-episodes: FAIL — cannot open', dbPath, ':', e.message);
  process.exit(1);
}

const fail = msg => {
  console.error('check-episodes: FAIL —', msg);
  process.exit(1);
};

const table = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anime_episodes'")
  .get();
if (!table) fail('anime_episodes table missing');

const total = db.prepare('SELECT COUNT(*) c FROM anime_episodes').get().c;
if (total === 0) fail('anime_episodes table is empty');

const badKeyOrType = db
  .prepare(
    `SELECT COUNT(*) c FROM anime_episodes
     WHERE ep_key IS NULL OR ep_key = ''
        OR type NOT IN ('main','special','nc','trailer','parody')`,
  )
  .get().c;
if (badKeyOrType) fail(`${badKeyOrType} rows with empty ep_key or type outside the locked vocabulary`);

const badAbs = db
  .prepare(`SELECT COUNT(*) c FROM anime_episodes WHERE type = 'main' AND abs_number IS NULL`)
  .get().c;
if (badAbs) fail(`${badAbs} main rows with NULL abs_number`);

const badSeason = db
  .prepare(`SELECT COUNT(*) c FROM anime_episodes WHERE type = 'special' AND COALESCE(season, 0) != 0`)
  .get().c;
if (badSeason) fail(`${badSeason} special rows with non-zero season`);

// Verbatim-storage check: ep_key must parse back to the stored doc-local
// number ("1"→1 for mains; "S3"/"C2"/"T1"/"P1"→ suffix digits for aux types).
const badMainNum = db
  .prepare(
    `SELECT COUNT(*) c FROM anime_episodes
     WHERE type = 'main' AND (number IS NULL OR CAST(ep_key AS REAL) != number)`,
  )
  .get().c;
if (badMainNum) fail(`${badMainNum} main rows where ep_key does not parse to number`);

const badAuxNum = db
  .prepare(
    `SELECT COUNT(*) c FROM anime_episodes
     WHERE type != 'main' AND (number IS NULL OR CAST(substr(ep_key, 2) AS REAL) != number)`,
  )
  .get().c;
if (badAuxNum) fail(`${badAuxNum} aux rows where ep_key suffix does not parse to number`);

const badOverview = db
  .prepare(
    `SELECT COUNT(*) c FROM anime_episodes
     WHERE overview LIKE 'Source:%' OR instr(overview, char(10) || 'Source:') > 0`,
  )
  .get().c;
if (badOverview) fail(`${badOverview} rows still carrying a "Source: X" overview trailer`);

// Declared-vs-stored counts: each ingested doc records its upstream
// episodeCount/specialCount in anizip_docs — a deleted or duplicated row
// breaks the equality (catches hand-corruption a row-level scan can't see).
const meta = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anizip_docs'")
  .get();
if (!meta) fail('anizip_docs meta table missing — episode provenance unverifiable');

const badMainCount = db
  .prepare(
    `SELECT COUNT(*) c FROM anizip_docs d
     WHERE d.episode_count IS NOT NULL AND d.episode_count != (
       SELECT COUNT(*) FROM anime_episodes e
       WHERE e.anidb_id = d.anidb_id AND e.type = 'main')`,
  )
  .get().c;
if (badMainCount) fail(`${badMainCount} docs whose stored main count diverges from declared episodeCount`);

const badSpecialCount = db
  .prepare(
    `SELECT COUNT(*) c FROM anizip_docs d
     WHERE d.special_count IS NOT NULL AND d.special_count != (
       SELECT COUNT(*) FROM anime_episodes e
       WHERE e.anidb_id = d.anidb_id AND e.type = 'special')`,
  )
  .get().c;
if (badSpecialCount) fail(`${badSpecialCount} docs whose stored special count diverges from declared specialCount`);

const byType = db
  .prepare('SELECT type, COUNT(*) c FROM anime_episodes GROUP BY type ORDER BY type')
  .all();
const shows = db.prepare('SELECT COUNT(DISTINCT anidb_id) c FROM anime_episodes').get().c;
console.log(
  `check-episodes: OK — ${total} rows across ${shows} docs; by type:`,
  JSON.stringify(Object.fromEntries(byType.map(r => [r.type, r.c]))),
);
db.close();
