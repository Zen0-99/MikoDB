#!/usr/bin/env node
/**
 * MikoDB — build the extension index + mirror curated APKs/icons.
 *
 * Inputs:
 *   curation.json   {pkg: {name,tier,idType,numbering,lang,apk,version,code,nsfw,sources}}
 *   upstream index  https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json
 *                   (refreshes apk/version for curated pkgs; also picks up icons)
 *
 * Output:
 *   index.min.json  vanilla aniyomi-format index (bare array) for curated pkgs
 *   apk/, icon/     mirrored binaries
 *   miko.json       merges a `sources` block: {pkg:{tier,idType,numbering,baseUrl}}
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const CURATION = path.join(ROOT, 'curation.json');
const UPSTREAM = 'https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json';
const UPSTREAM_RAW = 'https://raw.githubusercontent.com/yuzono/anime-repo/repo';
// MikoNovelSources — novel/book APK extensions merged into this repo so one
// GitHub URL gives Miko both anime extensions and novel sources.
const NOVEL_REPO = 'https://raw.githubusercontent.com/Zen0-99/MikoNovelSources/main';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MikoDB-Build/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> ${res.statusCode}`)); }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const get = (u, redirects = 5) => {
      https.get(u, { headers: { 'User-Agent': 'MikoDB-Build/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return get(res.headers.location, redirects - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${u} -> ${res.statusCode}`)); }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    get(url);
  });
}

async function main() {
  const curation = JSON.parse(fs.readFileSync(CURATION, 'utf8'));
  const upstream = await fetchJson(UPSTREAM);
  const byPkg = new Map(upstream.map(e => [e.pkg, e]));

  const index = [];
  const mikoSources = {};
  const jobs = [];

  for (const [pkg, meta] of Object.entries(curation)) {
    const up = byPkg.get(pkg);
    // Prefer fresh upstream fields; fall back to curated snapshot
    const entry = up || meta;
    index.push({
      name: entry.name.startsWith('Aniyomi:') || entry.name.startsWith('Tachiyomi:')
        ? entry.name : `Aniyomi: ${meta.name}`,
      pkg,
      apk: entry.apk,
      lang: entry.lang,
      code: entry.code,
      version: entry.version,
      nsfw: entry.nsfw ?? 0,
      ...(entry.sources ? { sources: entry.sources } : {}),
    });

    const baseUrl = entry.sources?.[0]?.baseUrl || '';
    mikoSources[pkg] = {
      name: meta.name, tier: meta.tier, idType: meta.idType,
      numbering: meta.numbering, baseUrl,
    };

    jobs.push(download(`${UPSTREAM_RAW}/apk/${entry.apk}`, path.join(ROOT, 'apk', entry.apk))
      .catch(e => console.log(`apk ${pkg}: ${e.message}`)));
    jobs.push(download(`${UPSTREAM_RAW}/icon/${pkg}.png`, path.join(ROOT, 'icon', `${pkg}.png`))
      .catch(() => {})); // icons optional
  }

  // Merge the MikoNovelSources index — novel entries pass through as-is
  // (already `Miko:`-named, yokai.extension.novel.* pkgs); APKs and icons are
  // mirrored into this repo's apk/ and icon/ dirs.
  const novelIndex = await fetchJson(`${NOVEL_REPO}/index.min.json`).catch(e => {
    console.log(`novel index fetch failed: ${e.message}`);
    return [];
  });
  for (const e of novelIndex) {
    index.push({
      name: e.name,
      pkg: e.pkg,
      apk: e.apk,
      lang: e.lang,
      code: e.code,
      version: e.version,
      nsfw: e.nsfw ?? 0,
      ...(e.sources ? { sources: e.sources } : {}),
      ...(e.mikoNovel ? { mikoNovel: e.mikoNovel } : {}),
    });
    jobs.push(download(`${NOVEL_REPO}/apk/${e.apk}`, path.join(ROOT, 'apk', e.apk))
      .catch(err => console.log(`novel apk ${e.pkg}: ${err.message}`)));
    jobs.push(download(`${NOVEL_REPO}/icon/${e.pkg}.png`, path.join(ROOT, 'icon', `${e.pkg}.png`))
      .catch(() => {}));
  }

  // Download with modest concurrency
  const CHUNK = 12;
  for (let i = 0; i < jobs.length; i += CHUNK) await Promise.all(jobs.slice(i, i + CHUNK));

  index.sort((a, b) => a.pkg.localeCompare(b.pkg));
  fs.writeFileSync(path.join(ROOT, 'index.min.json'), JSON.stringify(index));

  const mikoPath = path.join(ROOT, 'miko.json');
  const miko = fs.existsSync(mikoPath) ? JSON.parse(fs.readFileSync(mikoPath, 'utf8')) : {};
  miko.sources = mikoSources;
  fs.writeFileSync(mikoPath, JSON.stringify(miko, null, 2) + '\n');

  console.log(`index.min.json: ${index.length} extensions; miko.json sources: ${Object.keys(mikoSources).length}`);
}

main().catch(e => { console.error('INDEX BUILD FAILED:', e.message); process.exit(1); });
