#!/usr/bin/env node
/**
 * check-episodes — validation gate for the anime_episodes table inside a built
 * miko-anime-map.db. Runs locally and in CI before the artifact is published.
 *
 *   node scripts/check-episodes.mjs [path/to/miko-anime-map.db]
 *
 * Exits 1 on: db unreadable, table missing/empty, ep_key/type outside the
 * locked vocabulary, specials with a non-zero season, ep_key/number
 * divergence (verbatim-storage check), >80% of mains missing abs_number
 * (a parse regression — upstream omits absoluteEpisodeNumber on ~half of
 * docs, so isolated NULLs are expected), or residual "Source: X" overview
 * trailers. Exits 0 and prints row/type counts on a sane build.
 * Specials may carry any TVDB season — AniDB S# rows legitimately map
 * inside real seasons (mini-anime, endings, previews), and that season
 * is the merge key the worker uses, so it is stored verbatim.
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

// abs_number is upstream-optional (absoluteEpisodeNumber exists on ~40% of
// docs — for NULL-abs mains, `number` is already the AniDB-absolute fallback
// key). A near-total absence would mean our parse broke, so floor-check it.
const mains = db.prepare(`SELECT COUNT(*) c FROM anime_episodes WHERE type = 'main'`).get().c;
const nullAbs = db
  .prepare(`SELECT COUNT(*) c FROM anime_episodes WHERE type = 'main' AND abs_number IS NULL`)
  .get().c;
if (mains > 0 && nullAbs / mains > 0.8) fail(`${nullAbs}/${mains} main rows with NULL abs_number — abs parse likely broken`);
if (nullAbs) console.warn(`check-episodes: ${nullAbs}/${mains} main rows lack abs_number (upstream omits it — number is the fallback key)`);

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

// Declared-vs-stored: anizip_docs records the upstream episodeCount /
// specialCount fields. specialCount counts the doc's actual S# entries —
// it matched stored specials exactly across the full corpus, so equality
// is a real integrity check. episodeCount is instead the work's TOTAL from
// AniDB metadata (a stub doc for a 1,500-ep show still declares 1,565), so
// it cannot be compared to stored mains — divergence there is upstream
// completeness, not corruption. Mains integrity is covered by the
// ep_key/number parse checks above.
const meta = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anizip_docs'")
  .get();
if (!meta) fail('anizip_docs meta table missing — episode provenance unverifiable');

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
