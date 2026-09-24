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
  };
  fs.writeFileSync(MIKO_JSON, JSON.stringify(miko, null, 2) + '\n');
  console.log(`miko.json db block: v${version} sha=${sha256.slice(0, 12)}… gz=${(gz.length / 1e6).toFixed(2)}MB`);
}

main().catch(e => { console.error('BUILD FAILED:', e.message); process.exit(1); });
