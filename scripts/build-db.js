#!/usr/bin/env node
/**
 * MikoDB — build the anime identity mapping artifact.
 *
 * Inputs (all tolerant-of-absence; build degrades, never hard-fails):
 *   - Otaku-Mappings anime_mappings.db  (base: all canonical IDs, tvdb season/part, episode ranges)
 *   - Fribb anime-list-full.json        (fresher IMDB coverage)
 *   - MAL-Dubs dubInfo.json             (dub status per mal_id)
 *
 * Output:
 *   dist/miko-anime-map.db.gz   (SQLite, gzipped)
 *   updates miko.json {db:{version,sha256,rows,url}} (url placeholder resolved by release tag)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const DIST = path.join(ROOT, 'dist');
const DB_OUT = path.join(DIST, 'miko-anime-map.db');
const GZ_OUT = DB_OUT + '.gz';
const MIKO_JSON = path.join(ROOT, 'miko.json');
const RELEASE_TAG = 'db-latest';

// --- CLI flags ---
//   --anizip-dir <dir>   read ani.zip docs from <dir> (fixture mode) instead of
//                        the live fetch cache at data/anizip/
const ARGS = process.argv.slice(2);
const flagValue = n => {
  const i = ARGS.indexOf(n);
  return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : null;
};
const ANIZIP_DIR = flagValue('--anizip-dir');
const ANIZIP_CACHE = ANIZIP_DIR || path.join(DATA, 'anizip');

const URLS = {
  otaku: 'https://github.com/Goldenfreddy0703/Otaku-Mappings/raw/refs/heads/main/anime_mappings.db',
  fribb: 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
  maldubs: 'https://raw.githubusercontent.com/MAL-Dubs/MAL-Dubs/main/data/dubInfo.json',
};

function fetchFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, redirects = 5) => {
      https.get(u, { headers: { 'User-Agent': 'MikoDB-Build/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return get(res.headers.location, redirects - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${u} -> HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      }).on('error', reject);
    };
    get(url);
  });
}

async function fetchJson(url) {
  const tmp = path.join(DATA, crypto.createHash('md5').update(url).digest('hex') + '.json');
  await fetchFile(url, tmp);
  return JSON.parse(fs.readFileSync(tmp, 'utf8'));
}

// ---------------------------------------------------------------------------
// ani.zip episode ingestion (D-01/D-02)
//
// Docs live in a per-doc JSON store ({anidb_id}.json + {anidb_id}.missing.json
// sentinels) — either the fetch cache data/anizip/ or a fixture dir passed via
// --anizip-dir. Episode map keys are AniDB episode strings ("1","S3","C2","T1",
// "P1"); aligned TVDB numbers are stored VERBATIM (never assume key == abs).
// ---------------------------------------------------------------------------

// Locked type derivation by ep_key prefix. Anything else: warn + skip — never
// guess (an unknown prefix means upstream invented a class we don't model).
function epType(key) {
  if (/^\d+$/.test(key)) return 'main';
  if (key.startsWith('S')) return 'special';
  if (key.startsWith('C')) return 'nc';
  if (key.startsWith('T')) return 'trailer';
  if (key.startsWith('P')) return 'parody';
  return null;
}

const numOr = v => {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const intOr = v => {
  const n = numOr(v);
  return n == null ? null : Math.trunc(n);
};
const strOr = v => (v == null ? null : String(v));

// Doc-local number parsed from the episode string ("1"→1, "S3"→3, "12.5"→12.5).
function epNumber(ep, key) {
  const raw = String((ep && ep.episode) ?? key).replace(/^[A-Za-z]+/, '');
  return numOr(raw);
}

// title.en ?? first non-empty locale value.
function pickTitle(t) {
  if (!t) return null;
  if (typeof t === 'string') return t.trim() || null;
  if (typeof t !== 'object') return null;
  if (typeof t.en === 'string' && t.en.trim()) return t.en;
  for (const v of Object.values(t)) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

// overview ?? summary, with "Source: X" trailer lines stripped.
function pickOverview(ep) {
  const t = ep.overview ?? ep.summary;
  if (typeof t !== 'string') return null;
  const s = t.replace(/^Source:[^\n]*$/gm, '').trim();
  return s || null;
}

// runtime ?? length (animap carries length as "30m" — parseInt handles).
function pickRuntime(ep) {
  const v = ep.runtime ?? ep.length;
  const n = typeof v === 'number' ? v : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Load every doc in a store dir. Returns { docs: Map<anidbId, doc>, altIndex:
// Map<"anilist:1"|"mal:1"|"thetvdb:1" → anidbId> } so anime rows without an
// anidb_id can still resolve through the fallback id chain.
function loadAnizipDir(dir) {
  const docs = new Map();
  const altIndex = new Map();
  if (!fs.existsSync(dir)) return { docs, altIndex };
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json') || f.endsWith('.missing.json') || f.startsWith('_')) continue;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch (e) {
      console.warn('anizip: unreadable doc', f, '-', e.message);
      continue;
    }
    // Shape-validate: hostile/malformed payloads are skipped, never trusted.
    if (!doc || typeof doc !== 'object' || !doc.episodes ||
        typeof doc.episodes !== 'object' || Array.isArray(doc.episodes)) {
      console.warn('anizip: malformed doc (episodes map missing):', f);
      continue;
    }
    const m = doc.mappings || {};
    const anidbId = numOr(m.anidb_id) ?? numOr(f.replace(/\.json$/, ''));
    if (anidbId == null) {
      console.warn('anizip: doc with no resolvable anidb_id:', f);
      continue;
    }
    if (docs.has(anidbId)) {
      console.warn('anizip: duplicate doc for anidb', anidbId, '-', f, 'ignored');
      continue;
    }
    docs.set(anidbId, doc);
    for (const [from, key] of [['anilist', 'anilist_id'], ['mal', 'mal_id'], ['thetvdb', 'thetvdb_id']]) {
      const v = numOr(m[key]);
      if (v != null && !altIndex.has(`${from}:${v}`)) altIndex.set(`${from}:${v}`, anidbId);
    }
  }
  return { docs, altIndex };
}

// Resolve an anime row to its ani.zip doc anidb_id via the fallback chain
// anidb → anilist → mal → thetvdb. Returns null when no doc covers the row.
function resolveAnizipDoc(row, docs, altIndex) {
  const chain = [
    ['anidb', row.anidb_id],
    ['anilist', row.anilist_id],
    ['mal', row.mal_id],
    ['thetvdb', row.thetvdb_id],
  ];
  for (const [from, id] of chain) {
    const v = numOr(id);
    if (v == null) continue;
    const anidbId = from === 'anidb' ? v : altIndex.get(`${from}:${v}`);
    if (anidbId != null && docs.has(anidbId)) return anidbId;
  }
  return null;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  // --- 1. Base: Otaku-Mappings ---
  const otakuPath = path.join(DATA, 'otaku_mappings.db');
  try {
    await fetchFile(URLS.otaku, otakuPath);
    console.log('otaku-mappings downloaded');
  } catch (e) {
    if (!fs.existsSync(otakuPath)) throw new Error('Otaku-Mappings unavailable and no cache: ' + e.message);
    console.log('otaku-mappings download failed, using cached copy');
  }

  if (fs.existsSync(DB_OUT)) fs.unlinkSync(DB_OUT);
  fs.copyFileSync(otakuPath, DB_OUT);
  const db = new Database(DB_OUT);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');

  // Ensure expected table exists
  const hasAnime = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anime'").get();
  if (!hasAnime) throw new Error('Otaku DB missing `anime` table — upstream schema changed?');

  // --- 2. MAL-Dubs enrichment ---
  try {
    db.exec("ALTER TABLE anime ADD COLUMN dub_status TEXT");
  } catch (_) { /* column exists */ }
  try {
    const dub = await fetchJson(URLS.maldubs);
    const full = new Set(dub.dubbed || []);
    const part = new Set(dub.incomplete || []);
    const upd = db.prepare('UPDATE anime SET dub_status = ? WHERE mal_id = ?');
    const tx = db.transaction(() => {
      for (const id of full) upd.run('full', id);
      for (const id of part) if (!full.has(id)) upd.run('partial', id);
    });
    tx();
    console.log(`mal-dubs merged: ${full.size} full, ${part.size} partial`);
  } catch (e) {
    console.log('mal-dubs skipped:', e.message);
  }

  // --- 3. Fribb rows missing from Otaku (keyed on mal_id) ---
  try {
    const fribb = await fetchJson(URLS.fribb);
    const haveMal = new Set(db.prepare('SELECT mal_id FROM anime WHERE mal_id IS NOT NULL').all().map(r => r.mal_id));
    const haveAnilist = new Set(db.prepare('SELECT anilist_id FROM anime WHERE anilist_id IS NOT NULL').all().map(r => r.anilist_id));
    const haveAnidb = new Set(db.prepare('SELECT anidb_id FROM anime WHERE anidb_id IS NOT NULL').all().map(r => r.anidb_id));
    const haveKitsu = new Set(db.prepare('SELECT kitsu_id FROM anime WHERE kitsu_id IS NOT NULL').all().map(r => r.kitsu_id));
    const ins = db.prepare(`INSERT INTO anime
      (mal_id, anilist_id, kitsu_id, anidb_id, imdb_id, themoviedb_id, thetvdb_id,
       thetvdb_season, mal_title, anime_media_type)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    let added = 0;
    const tx = db.transaction(() => {
      for (const e of fribb) {
        if (!e.mal_id || haveMal.has(e.mal_id)) continue;
        if (e.anilist_id && haveAnilist.has(e.anilist_id)) continue;
        if (e.anidb_id && haveAnidb.has(e.anidb_id)) continue;
        if (e.kitsu_id && haveKitsu.has(e.kitsu_id)) continue;
        const tmdb = typeof e.themoviedb_id === 'object' && e.themoviedb_id
          ? (e.themoviedb_id.tv || e.themoviedb_id.movie || null) : e.themoviedb_id;
        const season = e.season && typeof e.season === 'object' ? e.season.tvdb : e.season;
        ins.run(e.mal_id, e.anilist_id ?? null, e.kitsu_id ?? null, e.anidb_id ?? null,
          Array.isArray(e.imdb_id) ? e.imdb_id[0] : e.imdb_id ?? null,
          tmdb ?? null, e.tvdb_id ?? null, season ?? null,
          e.title ?? null, e.type ?? null);
        added++;
      }
    });
    tx();
    console.log(`fribb merge: +${added} rows`);
  } catch (e) {
    console.log('fribb merge skipped:', e.message);
  }

  // --- 3.5 ani.zip episode rows (additive anime_episodes table; D-01/D-02) ---
  // The `anime` table is untouched — episode data is strictly additive so old
  // app versions keep working on the same artifact.
  const epStats = { docs: 0, rows: 0, covered: 0, animeTotal: 0 };
  {
    const { docs, altIndex } = loadAnizipDir(ANIZIP_CACHE);
    epStats.animeTotal = db.prepare('SELECT COUNT(*) c FROM anime').get().c;
    if (docs.size === 0) {
      console.log('anizip: no cached docs — shipping without anime_episodes');
    } else {
      epStats.covered = 0;
      for (const r of db.prepare('SELECT anidb_id, anilist_id, mal_id, thetvdb_id FROM anime').all()) {
        if (resolveAnizipDoc(r, docs, altIndex) != null) epStats.covered++;
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS anime_episodes (
          anidb_id       INTEGER NOT NULL,
          ep_key         TEXT NOT NULL,          -- ani.zip key verbatim: "1","S1","C2","T1","P1"
          type           TEXT NOT NULL,          -- main | special | nc | trailer | parody
          number         REAL,                   -- doc-local number: parse of 'episode' ("1"→1; "S3"→3)
          season         INTEGER,                -- TVDB seasonNumber (0 = specials season)
          ep_in_season   INTEGER,                -- TVDB episodeNumber
          abs_number     INTEGER,                -- ani.zip absoluteEpisodeNumber VERBATIM (may gap)
          title          TEXT,
          overview       TEXT,                   -- overview ?? summary, "Source: X" trailer stripped
          image          TEXT,
          air_date       TEXT,                   -- TVDB airDate — the Cinemeta-consistent date
          anidb_air_date TEXT,                   -- AniDB airdate — kept verbatim (dates differ)
          air_date_utc   TEXT,
          runtime        INTEGER,                -- runtime ?? length
          rating         REAL,
          anidb_eid      INTEGER,
          tvdb_eid       INTEGER,
          tvdb_show_id   INTEGER,
          filler         INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (anidb_id, ep_key)
        );
        CREATE INDEX IF NOT EXISTS idx_anime_episodes_tvdb ON anime_episodes(tvdb_show_id, season, ep_in_season);
        CREATE INDEX IF NOT EXISTS idx_anime_episodes_show ON anime_episodes(tvdb_show_id, ep_key);
        -- per-doc declared counts so the check-episodes gate can detect
        -- deleted/duplicated rows (upstream episodeCount/specialCount fields)
        CREATE TABLE IF NOT EXISTS anizip_docs (
          anidb_id      INTEGER PRIMARY KEY,
          episode_count INTEGER,
          special_count INTEGER
        );
      `);
      const insEp = db.prepare(`INSERT OR REPLACE INTO anime_episodes
        (anidb_id, ep_key, type, number, season, ep_in_season, abs_number,
         title, overview, image, air_date, anidb_air_date, air_date_utc,
         runtime, rating, anidb_eid, tvdb_eid, tvdb_show_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insDoc = db.prepare(`INSERT OR REPLACE INTO anizip_docs
        (anidb_id, episode_count, special_count) VALUES (?,?,?)`);
      const tx = db.transaction(() => {
        for (const [anidbId, doc] of docs) {
          insDoc.run(anidbId, intOr(doc.episodeCount), intOr(doc.specialCount));
          for (const key of Object.keys(doc.episodes)) {
            const ep = doc.episodes[key];
            if (!ep || typeof ep !== 'object' || Array.isArray(ep)) {
              console.warn('anizip: non-object episode skipped — anidb', anidbId, 'key', key);
              continue;
            }
            const type = epType(key);
            if (!type) {
              console.warn('anizip: unknown ep_key prefix', key, '— skipped (anidb', anidbId + ')');
              continue;
            }
            insEp.run(
              anidbId, key, type,
              epNumber(ep, key),
              intOr(ep.seasonNumber),
              intOr(ep.episodeNumber ?? ep.number),                 // animap vocab: number
              intOr(ep.absoluteEpisodeNumber ?? ep.absoluteNumber), // animap vocab: absoluteNumber
              pickTitle(ep.title),
              pickOverview(ep),
              typeof ep.image === 'string' ? ep.image : null,
              strOr(ep.airDate), strOr(ep.airdate), strOr(ep.airDateUtc),
              pickRuntime(ep),
              numOr(ep.rating),
              intOr(ep.anidbEid),
              intOr(ep.tvdbId ?? ep.tvdbEid),                       // animap vocab: tvdbEid
              intOr(ep.tvdbShowId),
            );
            epStats.rows++;
          }
          epStats.docs++;
        }
      });
      tx();
      console.log(`anizip: docs=${epStats.docs} episode_rows=${epStats.rows} coverage=${epStats.covered}/${epStats.animeTotal}`);
    }
  }

  // --- 4. Indexes for the lookup patterns Miko uses ---
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_anime_imdb    ON anime(imdb_id);
    CREATE INDEX IF NOT EXISTS idx_anime_anilist ON anime(anilist_id);
    CREATE INDEX IF NOT EXISTS idx_anime_mal     ON anime(mal_id);
    CREATE INDEX IF NOT EXISTS idx_anime_kitsu   ON anime(kitsu_id);
    CREATE INDEX IF NOT EXISTS idx_anime_tvdb    ON anime(thetvdb_id, thetvdb_season, thetvdb_part);
  `);
  try {
    db.prepare('INSERT INTO activities (sync_id, last_updated) VALUES (1, ?)').run(Math.floor(Date.now() / 1000));
  } catch (_) { /* non-fatal — activities schema may differ upstream */ }

  const rows = db.prepare('SELECT COUNT(*) c FROM anime').get().c;
  const withImdb = db.prepare("SELECT COUNT(*) c FROM anime WHERE imdb_id IS NOT NULL AND imdb_id != ''").get().c;
  db.close();
  console.log(`artifact rows=${rows} imdb-keyed=${withImdb}`);

  // --- 5. gzip + manifest ---
  const gz = zlib.gzipSync(fs.readFileSync(DB_OUT), { level: 9 });
  fs.writeFileSync(GZ_OUT, gz);
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');
  const version = new Date().toISOString().slice(0, 10);

  const miko = fs.existsSync(MIKO_JSON)
    ? JSON.parse(fs.readFileSync(MIKO_JSON, 'utf8'))
    : {};
  miko.db = {
    version,
    sha256,
    rows,
    url: `https://github.com/Zen0-99/MikoDB/releases/download/${RELEASE_TAG}/miko-anime-map.db.gz`,
    anime_episodes: epStats.rows,
    anizip_docs: epStats.docs,
    anizip_coverage: epStats.animeTotal ? +(epStats.covered / epStats.animeTotal).toFixed(4) : 0,
  };
  fs.writeFileSync(MIKO_JSON, JSON.stringify(miko, null, 2) + '\n');
  console.log(`miko.json db block: v${version} sha=${sha256.slice(0, 12)}… gz=${(gz.length / 1e6).toFixed(2)}MB`);
}

main().catch(e => { console.error('BUILD FAILED:', e.message); process.exit(1); });
