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
//   --filler-dir <dir>   read filler sources from <dir> (afl/*.html index+show
//                        pages, anifiller/*.json) instead of scraping live
//   --no-filler          skip the filler merge entirely (licensing kill-switch)
const ARGS = process.argv.slice(2);
const flagValue = n => {
  const i = ARGS.indexOf(n);
  return i >= 0 && i + 1 < ARGS.length ? ARGS[i + 1] : null;
};
const ANIZIP_DIR = flagValue('--anizip-dir');
const ANIZIP_CACHE = ANIZIP_DIR || path.join(DATA, 'anizip');
const FILLER_DIR = flagValue('--filler-dir');
const NO_FILLER = ARGS.includes('--no-filler');

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

// ---------------------------------------------------------------------------
// ani.zip live fetch (incremental cache — RESEARCH Pattern 4)
//
// api.ani.zip is a per-ID API with no bulk dump: GET /v1/episodes?{from}_id={id}
// for from ∈ {anidb, anilist, mal, thetvdb}. Cache lives in data/anizip/:
//   {anidb_id}.json          one file per resolved doc (doc's own anidb_id)
//   {anidb_id}.missing.json  404 sentinel for anidb-keyed requests (90-day TTL)
//   _index.json              "from:id" → {file} | {missing:iso} bookkeeping so
//                            non-anidb lookups also resolve from cache
// Refetch per weekly run: never-fetched rows + releasing/airing rows + a
// rolling anidb_id % 8 == isoWeek % 8 slice (full refresh ≈ 2 months).
// Degrade-don't-fail: any network failure keeps the existing cache.
// ---------------------------------------------------------------------------

const ANIZIP_API = 'https://api.ani.zip/v1/episodes';
const ANIZIP_CONCURRENCY = 8;
const ANIZIP_TIMEOUT_MS = 10 * 1000;
const ANIZIP_RETRIES = 2;
const ANIZIP_MISSING_TTL_MS = 90 * 24 * 3600 * 1000;
const ANIZIP_INDEX = '_index.json';
const ANIZIP_FROM_KEYS = [
  ['anidb', 'anidb_id'],
  ['anilist', 'anilist_id'],
  ['mal', 'mal_id'],
  ['thetvdb', 'thetvdb_id'],
];

function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

// Minimal concurrency pool — workers drain a shared index.
async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// JSON GET with redirect following, per-request timeout, and retries with
// exponential backoff honoring Retry-After. Resolves {status, body} — 404 and
// exhausted-error statuses resolve (never throw) so callers can sentinel them;
// only transport failures past all retries reject.
function getJson(url, { timeout = ANIZIP_TIMEOUT_MS, retries = ANIZIP_RETRIES } = {}) {
  const backoff = attempt => Math.pow(2, ANIZIP_RETRIES - attempt) * 1000;
  return new Promise((resolve, reject) => {
    const attempt = (u, n, redirects = 5) => {
      const req = https.get(u, { headers: { 'User-Agent': 'MikoDB-Build/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return attempt(res.headers.location, n, redirects - 1);
        }
        if (res.statusCode === 404) {
          res.resume();
          return resolve({ status: 404, body: null });
        }
        if (res.statusCode === 429 || res.statusCode >= 500) {
          const ra = parseFloat(res.headers['retry-after']);
          res.resume();
          if (n > 0) {
            const wait = Number.isFinite(ra) ? ra * 1000 : backoff(n);
            console.warn(`anizip: HTTP ${res.statusCode} for ${u} — retry in ${wait}ms`);
            return setTimeout(() => attempt(u, n - 1, redirects), wait);
          }
          return resolve({ status: res.statusCode, body: null });
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ status: res.statusCode ?? 0, body: null });
        }
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: 200, body: JSON.parse(data) });
          } catch (e) {
            resolve({ status: 200, body: null, parseError: e.message });
          }
        });
      });
      req.setTimeout(timeout, () => req.destroy(new Error('request timeout')));
      req.on('error', err => {
        if (n > 0) return setTimeout(() => attempt(u, n - 1, redirects), backoff(n));
        reject(err);
      });
    };
    attempt(url, retries);
  });
}

// Decide which anime rows need a (re)fetch this run and fetch them into the
// cache. Never throws past the stage guard in main() — every failure mode
// leaves the prior cache intact.
async function refreshAnizipCache(db) {
  fs.mkdirSync(ANIZIP_CACHE, { recursive: true });
  const indexPath = path.join(ANIZIP_CACHE, ANIZIP_INDEX);
  let idx = {};
  try {
    idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (_) { /* no index yet */ }

  const week = isoWeek();
  const rows = db
    .prepare('SELECT anidb_id, anilist_id, mal_id, thetvdb_id, status FROM anime')
    .all();

  // Each task = one row's candidate id chain, walked in order at fetch time:
  // first candidate without a fresh cache record is tried; on 404 the next id
  // space is tried (a row may exist under anilist/mal/thetvdb but not anidb).
  const tasks = new Map(); // signature -> {keys: [[from,id]...]}
  for (const row of rows) {
    const cands = ANIZIP_FROM_KEYS
      .map(([from, col]) => [from, numOr(row[col])])
      .filter(([, v]) => v != null);
    if (!cands.length) continue;
    let resolvedKey = null;
    let firstUnresolved = -1;
    for (let i = 0; i < cands.length; i++) {
      const e = idx[`${cands[i][0]}:${cands[i][1]}`];
      if (e && e.file && fs.existsSync(path.join(ANIZIP_CACHE, e.file))) {
        resolvedKey = `${cands[i][0]}:${cands[i][1]}`;
        break;
      }
      if (e && e.missing && Date.now() - Date.parse(e.missing) < ANIZIP_MISSING_TTL_MS) {
        continue; // fresh 404 — try the next id space
      }
      if (firstUnresolved < 0) firstUnresolved = i; // no record / dead file / stale 404
    }
    if (resolvedKey) {
      const airing = /releas|airing/i.test(row.status || '');
      const anidbId = numOr(row.anidb_id);
      const inSlice = anidbId != null && ((anidbId % 8) + 8) % 8 === week % 8;
      if (airing || inSlice) {
        const [from, id] = resolvedKey.split(':');
        tasks.set(`refetch:${resolvedKey}`, { keys: [[from, numOr(id)]] });
      }
      continue;
    }
    if (firstUnresolved >= 0) {
      const keys = cands.slice(firstUnresolved);
      tasks.set(keys.map(([f, i]) => `${f}:${i}`).join('|'), { keys });
    }
    // else: every candidate already has a fresh 404 sentinel — nothing to do
  }

  if (!tasks.size) {
    console.log('anizip fetch: nothing to refresh this run');
    return;
  }
  const stats = { fetched: 0, missed: 0, errors: 0 };
  const items = [...tasks.values()];
  let done = 0;
  await pool(items, ANIZIP_CONCURRENCY, async ({ keys }) => {
    try {
      for (const [from, id] of keys) {
        const key = `${from}:${id}`;
        const res = await getJson(`${ANIZIP_API}?${from}_id=${encodeURIComponent(id)}`);
        if (res.status === 200 && res.body && res.body.episodes && typeof res.body.episodes === 'object') {
          const docAnidb = numOr(res.body.mappings?.anidb_id);
          const file = `${docAnidb ?? (from === 'anidb' ? id : `${from}-${id}`)}.json`;
          fs.writeFileSync(path.join(ANIZIP_CACHE, file), JSON.stringify(res.body));
          // every provider id the doc declares becomes a cache hit key
          for (const [f2, col] of ANIZIP_FROM_KEYS) {
            const v = numOr(res.body.mappings?.[col]);
            if (v != null) idx[`${f2}:${v}`] = { file };
          }
          idx[key] = { file };
          stats.fetched++;
          break; // doc resolved — remaining candidates unnecessary
        }
        if (res.status === 404) {
          const iso = new Date().toISOString();
          idx[key] = { missing: iso };
          if (from === 'anidb') {
            fs.writeFileSync(
              path.join(ANIZIP_CACHE, `${id}.missing.json`),
              JSON.stringify({ from, id, status: 404, at: iso }),
            );
          }
          stats.missed++;
          continue; // try the next id space
        }
        stats.errors++;
        break; // transient failure — don't hammer every id space of a sick API
      }
    } catch (e) {
      stats.errors++;
      console.warn(`anizip: fetch ${keys[0][0]}:${keys[0][1]}… failed — ${e.message}`);
    }
    if (++done % 200 === 0) console.log(`anizip fetch: ${done}/${items.length} (${stats.fetched} ok, ${stats.missed} 404, ${stats.errors} err)`);
  });
  fs.writeFileSync(indexPath, JSON.stringify(idx));
  console.log(`anizip fetch: ${stats.fetched} fetched, ${stats.missed} 404-sentinels, ${stats.errors} errors of ${items.length} tasks`);
}

// ---------------------------------------------------------------------------
// Filler ingest (D-03c) — animefillerlist.com scrape is primary; AniFiller
// per-show JSON is the ID-exact cross-check that wins only where AFL has no
// coverage. Stores episode-number facts only (no creative content); --no-filler
// disables the whole stage.
// ---------------------------------------------------------------------------

const cheerio = require('cheerio');
const AFL_BASE = 'https://animefillerlist.com';
const ANIFILLER_API = 'https://api.github.com/repos/AniraTeam/AniFiller/contents/data/shows';
const ANIFILLER_RAW = 'https://raw.githubusercontent.com/AniraTeam/AniFiller/main/data/shows';
const AFL_CONCURRENCY = 4;

function normalizeTitle(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 10) return 99;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// AFL /shows index → [{slug, title}]. Fixture mode reads {dir}/afl/index.html;
// live mode fetches the page once.
function parseAflIndex(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('div.Group ul li a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = href.match(/\/shows\/([^/?#]+)/);
    if (m) out.push({ slug: m[1], title: $(el).text().trim() });
  });
  return out;
}

// AFL show page → Set<episodeNumber> for rows classed filler (filler AND
// mixed_canon/filler both count — matches Seanime's isFiller semantics).
function parseAflShow(html) {
  const $ = cheerio.load(html);
  const eps = new Set();
  $('tr').each((_, tr) => {
    const cls = ($(tr).attr('class') || '');
    if (!/(^|[\s/])filler([\s/]|$)/.test(cls) && !cls.includes('filler')) return;
    const raw = $(tr).find('td.Number').first().text().trim();
    const n = parseFloat(raw);
    if (Number.isFinite(n)) eps.add(n);
  });
  return eps;
}

async function loadAfl() {
  // Map<slug, {title, eps:Set<number>}>
  if (FILLER_DIR) {
    const dir = path.join(FILLER_DIR, 'afl');
    const out = new Map();
    const indexPath = path.join(dir, 'index.html');
    if (!fs.existsSync(indexPath)) return out;
    const entries = parseAflIndex(fs.readFileSync(indexPath, 'utf8'));
    for (const { slug, title } of entries) {
      const p = path.join(dir, `${slug}.html`);
      if (!fs.existsSync(p)) continue;
      out.set(slug, { title, eps: parseAflShow(fs.readFileSync(p, 'utf8')) });
    }
    return out;
  }
  const html = await getText(`${AFL_BASE}/shows`);
  if (html == null) throw new Error('animefillerlist /shows index unreachable');
  const entries = parseAflIndex(html);
  const out = new Map();
  let done = 0;
  await pool(entries, AFL_CONCURRENCY, async ({ slug, title }) => {
    try {
      const showHtml = await getText(`${AFL_BASE}/shows/${slug}`);
      if (showHtml != null) out.set(slug, { title, eps: parseAflShow(showHtml) });
    } catch (e) {
      console.warn('filler: AFL show fetch failed:', slug, '-', e.message);
    }
    if (++done % 50 === 0) console.log(`filler: AFL ${done}/${entries.length}`);
  });
  return out;
}

// Plain-text GET sharing getJson's retry/timeout policy (AFL serves HTML).
function getText(url, { timeout = 15000, retries = ANIZIP_RETRIES } = {}) {
  const backoff = attempt => Math.pow(2, ANIZIP_RETRIES - attempt) * 1000;
  return new Promise((resolve, reject) => {
    const attempt = (u, n, redirects = 5) => {
      const req = https.get(u, { headers: { 'User-Agent': 'MikoDB-Build/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return attempt(res.headers.location, n, redirects - 1);
        }
        if ((res.statusCode === 429 || res.statusCode >= 500) && n > 0) {
          const ra = parseFloat(res.headers['retry-after']);
          res.resume();
          const wait = Number.isFinite(ra) ? ra * 1000 : backoff(n);
          return setTimeout(() => attempt(u, n - 1, redirects), wait);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => resolve(data));
      });
      req.setTimeout(timeout, () => req.destroy(new Error('request timeout')));
      req.on('error', err => {
        if (n > 0) return setTimeout(() => attempt(u, n - 1, redirects), backoff(n));
        reject(err);
      });
    };
    attempt(url, retries);
  });
}

// AniFiller → [{slug, title, anilist_id, mal_id, eps:Set<number>}] — per-show
// JSON joined by mappings.anilist_id/mal_id. Episode type vocab:
// manga-canon | filler | mixed-manga | anime-canon — filler + mixed-manga flag.
function parseAniFillerDoc(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.episodes)) return null;
  const eps = new Set();
  for (const e of j.episodes) {
    const n = numOr(e.episode);
    if (n != null && (e.type === 'filler' || e.type === 'mixed-manga')) eps.add(n);
  }
  return {
    slug: j.slug || null,
    title: j.title || null,
    anilist_id: numOr(j.mappings?.anilist_id),
    mal_id: numOr(j.mappings?.mal_id),
    eps,
  };
}

async function loadAniFiller() {
  const out = [];
  if (FILLER_DIR) {
    const dir = path.join(FILLER_DIR, 'anifiller');
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = parseAniFillerDoc(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
        if (d) out.push(d);
      } catch (e) {
        console.warn('filler: bad AniFiller fixture', f, '-', e.message);
      }
    }
    return out;
  }
  const listing = await getJson(ANIFILLER_API, { timeout: 15000 });
  if (listing.status !== 200 || !Array.isArray(listing.body)) {
    throw new Error(`AniFiller index unreachable (HTTP ${listing.status})`);
  }
  const slugs = listing.body.filter(f => f.name.endsWith('.json')).map(f => f.name.replace(/\.json$/, ''));
  let done = 0;
  await pool(slugs, ANIZIP_CONCURRENCY, async slug => {
    try {
      const res = await getJson(`${ANIFILLER_RAW}/${encodeURIComponent(slug)}.json`, { timeout: 15000 });
      const d = res.status === 200 ? parseAniFillerDoc(res.body) : null;
      if (d) out.push(d);
    } catch (e) {
      console.warn('filler: AniFiller fetch failed:', slug, '-', e.message);
    }
    if (++done % 50 === 0) console.log(`filler: AniFiller ${done}/${slugs.length}`);
  });
  return out;
}

// Join filler sources onto ingested docs and flag anime_episodes rows.
// coveredPairs: [{row, anidbId}] — anime rows that resolved a doc (supplies
// the mal_title join side). Returns { flaggedShows, applied, drift }.
async function applyFiller(db, docs, coveredPairs) {
  const result = { flaggedShows: 0, applied: 0, drift: [] };
  if (NO_FILLER) {
    console.log('filler: disabled via --no-filler');
    return result;
  }

  // Title → anidb index: ani.zip titles.en / titles.x-jat + mal_title of every
  // anime row resolved to that doc. A normalized title mapping to multiple
  // docs is ambiguous — never joined.
  const titleToAnidb = new Map();
  const addTitle = (title, anidbId) => {
    const n = normalizeTitle(title);
    if (!n) return;
    if (!titleToAnidb.has(n)) titleToAnidb.set(n, new Set());
    titleToAnidb.get(n).add(anidbId);
  };
  for (const [anidbId, doc] of docs) {
    const t = doc.titles || {};
    addTitle(t.en, anidbId);
    addTitle(t['x-jat'], anidbId);
  }
  for (const { row, anidbId } of coveredPairs) addTitle(row.mal_title, anidbId);

  // ID-exact index for AniFiller: doc mappings.anilist_id / mal_id → anidb.
  const idToAnidb = new Map();
  for (const [anidbId, doc] of docs) {
    const m = doc.mappings || {};
    for (const key of ['anilist_id', 'mal_id']) {
      const v = numOr(m[key]);
      if (v != null && !idToAnidb.has(`${key}:${v}`)) idToAnidb.set(`${key}:${v}`, anidbId);
    }
  }

  const uniqueJoin = (set) => (set && set.size === 1 ? [...set][0] : null);
  const fuzzyJoin = normTitle => {
    let best = null, bestDist = 11;
    for (const [t, set] of titleToAnidb) {
      if (t[0] !== normTitle[0] || Math.abs(t.length - normTitle.length) > 10) continue;
      const d = levenshtein(t, normTitle);
      if (d < bestDist) { bestDist = d; best = set; }
      else if (d === bestDist && best && ![...set].every(x => best.has(x))) { best = null; } // tie → ambiguous
    }
    return bestDist <= 10 ? uniqueJoin(best) : null;
  };

  let afl, anifiller;
  try {
    afl = await loadAfl();
  } catch (e) {
    console.warn('filler: animefillerlist unreachable —', e.message);
    afl = new Map();
  }
  try {
    anifiller = await loadAniFiller();
  } catch (e) {
    console.warn('filler: AniFiller unreachable —', e.message);
    anifiller = [];
  }

  // Resolve each source's shows to anidb ids.
  const aflByAnidb = new Map(); // anidbId -> {slug, eps}
  for (const [slug, { title, eps }] of afl) {
    if (!eps.size) continue;
    let anidbId = uniqueJoin(titleToAnidb.get(normalizeTitle(title)));
    if (anidbId == null) anidbId = uniqueJoin(titleToAnidb.get(normalizeTitle(slug.replace(/-/g, ' '))));
    if (anidbId == null) {
      anidbId = fuzzyJoin(normalizeTitle(title));
      if (anidbId != null) console.log(`filler: fuzzy-join ${slug} → anidb:${anidbId}`);
    }
    if (anidbId == null) continue; // no confident join → skip, don't guess
    aflByAnidb.set(anidbId, { slug, eps });
  }
  const aniByAnidb = new Map(); // anidbId -> {slug, eps}
  for (const d of anifiller) {
    let anidbId = null;
    if (d.anilist_id != null) anidbId = idToAnidb.get(`anilist_id:${d.anilist_id}`);
    if (anidbId == null && d.mal_id != null) anidbId = idToAnidb.get(`mal_id:${d.mal_id}`);
    if (anidbId == null || !d.eps.size) continue;
    aniByAnidb.set(anidbId, { slug: d.slug, eps: d.eps });
  }

  // AFL is primary; AniFiller only fills where AFL has no coverage. Both
  // covered → diff into the drift report.
  const flagUpd = db.prepare(`UPDATE anime_episodes SET filler = 1
    WHERE anidb_id = ? AND type = 'main' AND number = ?`);
  const anidbToFlags = new Map(); // anidbId -> Set<number>
  for (const [anidbId, a] of aflByAnidb) {
    anidbToFlags.set(anidbId, a.eps);
    const b = aniByAnidb.get(anidbId);
    if (b) {
      const aflOnly = [...a.eps].filter(x => !b.eps.has(x));
      const aniOnly = [...b.eps].filter(x => !a.eps.has(x));
      if (aflOnly.length || aniOnly.length) {
        result.drift.push({
          slug: a.slug, anidb_id: anidbId,
          afl: [...a.eps].sort((x, y) => x - y), anifiller: [...b.eps].sort((x, y) => x - y),
          afl_only: aflOnly.sort((x, y) => x - y), anifiller_only: aniOnly.sort((x, y) => x - y),
        });
      }
    }
  }
  for (const [anidbId, b] of aniByAnidb) {
    if (!anidbToFlags.has(anidbId)) anidbToFlags.set(anidbId, b.eps);
  }

  const tx = db.transaction(() => {
    for (const [anidbId, eps] of anidbToFlags) {
      let appliedHere = 0;
      for (const n of eps) appliedHere += flagUpd.run(anidbId, n).changes;
      if (appliedHere > 0) result.flaggedShows++;
      result.applied += appliedHere;
    }
  });
  tx();
  console.log(`filler: afl=${aflByAnidb.size} joined, anifiller=${aniByAnidb.size} joined, flagged ${result.applied} eps on ${result.flaggedShows} docs, drift=${result.drift.length}`);
  return result;
}

// Otaku range cross-check: parse anime_media_episodes ("1 - 26", possibly
// comma-separated ranges) into an expected main-episode count.
function parseEpisodeRange(range) {
  if (!range || typeof range !== 'string') return null;
  let total = 0, matched = false;
  for (const m of range.matchAll(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/g)) {
    total += Math.floor(parseFloat(m[2]) - parseFloat(m[1])) + 1;
    matched = true;
  }
  if (!matched) {
    const bare = range.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
    if (bare) { total = 1; matched = true; }
  }
  return matched ? total : null;
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
  const epStats = { docs: 0, rows: 0, covered: 0, animeTotal: 0, fillerShows: 0 };
  let driftSummary = { mismatched: 0, coverage: 0, filler_divergent: 0 };
  {
    // Live mode only: populate/refresh the per-doc cache before loading it.
    // Degrade-don't-fail — any fetch failure keeps whatever the cache holds.
    if (!ANIZIP_DIR) {
      try {
        await refreshAnizipCache(db);
      } catch (e) {
        console.warn('anizip: fetch stage failed — using cached docs only:', e.message);
      }
    }

    const { docs, altIndex } = loadAnizipDir(ANIZIP_CACHE);
    epStats.animeTotal = db.prepare('SELECT COUNT(*) c FROM anime').get().c;
    if (docs.size === 0) {
      console.log('anizip: no cached docs — shipping without anime_episodes');
    } else {
      // Row → doc resolution (anidb → anilist → mal → thetvdb chain).
      // `direct` marks rows whose OWN anidb_id produced the doc — the drift
      // cross-check only compares same-work pairs, not fallback coverage.
      const coveredPairs = [];
      for (const r of db.prepare('SELECT anidb_id, anilist_id, mal_id, thetvdb_id, mal_title, anime_media_episodes FROM anime').all()) {
        const a = resolveAnizipDoc(r, docs, altIndex);
        if (a != null) {
          epStats.covered++;
          coveredPairs.push({ row: r, anidbId: a, direct: numOr(r.anidb_id) === a });
        }
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

      // Filler flags (D-03c): AFL scrape primary, AniFiller ID-join where AFL
      // has no coverage; disagreements land in the drift report.
      const fillerStats = await applyFiller(db, docs, coveredPairs);
      epStats.fillerShows = fillerStats.flaggedShows;

      // Otaku drift cross-check (informational — never fails the build):
      // expected main count from anime_media_episodes ranges vs stored rows.
      const mainsCount = db.prepare("SELECT COUNT(*) c FROM anime_episodes WHERE anidb_id = ? AND type = 'main'");
      const episodeDrift = [];
      let compared = 0;
      for (const { row, anidbId, direct } of coveredPairs) {
        if (!direct) continue;
        const expected = parseEpisodeRange(row.anime_media_episodes);
        if (expected == null) continue;
        compared++;
        const actual = mainsCount.get(anidbId).c;
        if (actual !== expected) {
          episodeDrift.push({
            work: row.mal_title || `anidb:${anidbId}`,
            anidb_id: anidbId,
            expected,
            actual,
            kind: actual < expected ? 'missing' : 'extra',
          });
        }
      }
      driftSummary = {
        mismatched: episodeDrift.length,
        coverage: epStats.animeTotal ? +(epStats.covered / epStats.animeTotal).toFixed(4) : 0,
        filler_divergent: fillerStats.drift.length,
      };
      try {
        fs.writeFileSync(
          path.join(DIST, 'anizip_drift.json'),
          JSON.stringify({
            generated: new Date().toISOString(),
            episode_drift: episodeDrift,
            filler_drift: fillerStats.drift,
            summary: driftSummary,
          }, null, 2) + '\n',
        );
      } catch (e) {
        console.warn('anizip: drift report write failed —', e.message);
      }
      console.log(`anizip drift: ${episodeDrift.length}/${compared} same-work rows diverge from Otaku ranges`);
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
    filler_shows: epStats.fillerShows,
    anizip_drift_summary: driftSummary,
  };
  fs.writeFileSync(MIKO_JSON, JSON.stringify(miko, null, 2) + '\n');
  console.log(`miko.json db block: v${version} sha=${sha256.slice(0, 12)}… gz=${(gz.length / 1e6).toFixed(2)}MB`);
}

main().catch(e => { console.error('BUILD FAILED:', e.message); process.exit(1); });
