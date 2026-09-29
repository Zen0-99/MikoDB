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
// Keiyoushi — the full manga extension catalog (already ranked in miko.json's
// `manga_sources` block). Served via index.pb with absolute apkUrl/iconUrl —
// no APK mirroring; installs link straight to keiyoushi's release hosting.
const KEIYOUSHI_INDEX = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json';
const KEIYOUSHI_SNAPSHOT = path.join(ROOT, 'keiyoushi-index.json');
// Canonical hosting base for this repo's mirrored artifacts — used in
// index.pb's absolute resource URLs so they resolve regardless of which
// repo URL variant the user pasted.
const SELF_BASE = 'https://raw.githubusercontent.com/Zen0-99/MikoDB/main';

// ---------- minimal protobuf wire encoder (index.pb schema) ----------
// Field shapes mirror the app's ExtensionIndexProto.kt:
//   IndexProto       name=1 badgeLabel=2 signingKey=3 contact=4
//                    extensionList=101 extensionListUrl=102
//   ContactProto     website=1 discord=2
//   ExtensionListProto extensions=1 (repeated)
//   ExtensionProto   name=1 packageName=2 resources=3 extensionLib=4
//                    versionCode=5 versionName=6 contentWarning=7 sources=8
//   ResourcesProto   apkUrl=1 iconUrl=2
//   SourceProto      id=1 name=2 language=3 homeUrl=4 mirrorUrls=5 message=7
function bvarint(n) {
  n = BigInt(n);
  const out = [];
  while (n > 0x7fn) { out.push(Number(n & 0x7fn) | 0x80); n >>= 7n; }
  out.push(Number(n));
  return Buffer.from(out);
}
const btag = (field, wire) => bvarint((BigInt(field) << 3n) | BigInt(wire));
const bstr = (field, s) => {
  if (s === undefined || s === null || s === '') return Buffer.alloc(0);
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([btag(field, 2), bvarint(b.length), b]);
};
const bvint = (field, n) => {
  if (n === undefined || n === null || n === 0 || n === 0n) return Buffer.alloc(0);
  return Buffer.concat([btag(field, 0), bvarint(n)]);
};
const bmsg = (field, buf) =>
  !buf || buf.length === 0 ? Buffer.alloc(0) : Buffer.concat([btag(field, 2), bvarint(buf.length), buf]);

const CONTENT_WARNING = { CONTENT_WARNING_SAFE: 1, CONTENT_WARNING_MIXED: 2, CONTENT_WARNING_NSFW: 3 };

function sourceProto(s) {
  return Buffer.concat([
    bvint(1, s.id),
    bstr(2, s.name),
    bstr(3, s.language ?? s.lang),
    bstr(4, s.homeUrl ?? s.baseUrl),
    ...(s.mirrorUrls ?? []).map(u => bstr(5, u)),
    bstr(7, s.message),
  ]);
}

function extensionProto(e) {
  return Buffer.concat([
    bstr(1, e.name),
    bstr(2, e.packageName),
    bmsg(3, Buffer.concat([bstr(1, e.apkUrl), bstr(2, e.iconUrl)])),
    bstr(4, e.extensionLib),
    bvint(5, e.versionCode),
    bstr(6, e.versionName),
    bvint(7, e.contentWarning),
    ...(e.sources ?? []).map(s => bmsg(8, sourceProto(s))),
  ]);
}

function indexProto(name, contactWebsite, extensions) {
  const list = Buffer.concat(extensions.map(e => bmsg(1, extensionProto(e))));
  return Buffer.concat([
    bstr(1, name),
    bstr(3, ''), // signingKey — repo.json carries the canonical fingerprint
    bmsg(4, bstr(1, contactWebsite)),
    bmsg(101, list),
  ]);
}

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
  const protoExts = []; // index.pb entries — absolute resource URLs
  const mikoSources = {};
  const jobs = [];

  for (const [pkg, meta] of Object.entries(curation)) {
    const up = byPkg.get(pkg);
    // Prefer fresh upstream fields; fall back to curated snapshot
    const entry = up || meta;
    const name = entry.name.startsWith('Aniyomi:') || entry.name.startsWith('Tachiyomi:')
      ? entry.name : `Aniyomi: ${meta.name}`;
    index.push({
      name,
      pkg,
      apk: entry.apk,
      lang: entry.lang,
      code: entry.code,
      version: entry.version,
      nsfw: entry.nsfw ?? 0,
      ...(entry.sources ? { sources: entry.sources } : {}),
    });
    protoExts.push({
      name,
      packageName: pkg,
      apkUrl: `${SELF_BASE}/apk/${entry.apk}`,
      iconUrl: `${SELF_BASE}/icon/${pkg}.png`,
      extensionLib: String(entry.version).split('.').slice(0, -1).join('.'),
      versionCode: entry.code,
      versionName: String(entry.version),
      contentWarning: (entry.nsfw ?? 0) === 1 ? 3 : 1,
      sources: (entry.sources ?? []).map(s => ({
        id: s.id, name: s.name, language: s.lang, homeUrl: s.baseUrl,
      })),
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
    protoExts.push({
      name: e.name,
      packageName: e.pkg,
      apkUrl: `${SELF_BASE}/apk/${e.apk}`,
      iconUrl: `${SELF_BASE}/icon/${e.pkg}.png`,
      extensionLib: String(e.version).split('.').slice(0, -1).join('.'),
      versionCode: e.code,
      versionName: String(e.version),
      contentWarning: (e.nsfw ?? 0) === 1 ? 3 : 1,
      sources: (e.sources ?? []).map(s => ({
        id: s.id, name: s.name, language: s.lang ?? s.language, homeUrl: s.baseUrl ?? s.homeUrl,
      })),
    });
    jobs.push(download(`${NOVEL_REPO}/apk/${e.apk}`, path.join(ROOT, 'apk', e.apk))
      .catch(err => console.log(`novel apk ${e.pkg}: ${err.message}`)));
    jobs.push(download(`${NOVEL_REPO}/icon/${e.pkg}.png`, path.join(ROOT, 'icon', `${e.pkg}.png`))
      .catch(() => {}));
  }

  // Merge the ranked keiyoushi manga catalog. No mirroring — the proto
  // index carries keiyoushi's absolute apk/icon URLs, so installs stream
  // straight from their release hosting. The local snapshot covers
  // offline rebuilds; live index.json wins when reachable.
  let kIndex = await fetchJson(KEIYOUSHI_INDEX).catch(e => {
    console.log(`keiyoushi index fetch failed: ${e.message} — using snapshot`);
    return null;
  });
  if (!kIndex && fs.existsSync(KEIYOUSHI_SNAPSHOT)) {
    kIndex = JSON.parse(fs.readFileSync(KEIYOUSHI_SNAPSHOT, 'utf8'));
  }
  const mangaExts = kIndex?.extensionList?.extensions ?? (Array.isArray(kIndex) ? kIndex : []);
  let mangaCount = 0;
  for (const e of mangaExts) {
    const pkg = e.packageName ?? e.pkg;
    // Keiyoushi's own "update your app" placeholder entries are not real
    // extensions (the app's JSON path filters the same two pkgs).
    if (!pkg || pkg === 'eu.kanade.tachiyomi.extension.all.keiyoushi' ||
        pkg === 'eu.kanade.tachiyomi.extension.all.mihon') continue;
    protoExts.push({
      name: e.name,
      packageName: pkg,
      apkUrl: e.resources?.apkUrl ?? '',
      iconUrl: e.resources?.iconUrl ?? '',
      extensionLib: String(e.extensionLib ?? ''),
      versionCode: e.versionCode,
      versionName: String(e.versionName ?? ''),
      contentWarning: CONTENT_WARNING[e.contentWarning] ?? 0,
      sources: (e.sources ?? []).map(s => ({
        id: s.id, name: s.name, language: s.language, homeUrl: s.homeUrl,
      })),
    });
    mangaCount++;
  }

  // Download with modest concurrency
  const CHUNK = 12;
  for (let i = 0; i < jobs.length; i += CHUNK) await Promise.all(jobs.slice(i, i + CHUNK));

  index.sort((a, b) => a.pkg.localeCompare(b.pkg));
  fs.writeFileSync(path.join(ROOT, 'index.min.json'), JSON.stringify(index));

  // index.pb — the app's preferred index format. Carries every medium
  // (anime + novel mirrored, manga linked out) in one protobuf document.
  const pb = indexProto('MikoDB', 'https://github.com/Zen0-99/MikoDB', protoExts);
  fs.writeFileSync(path.join(ROOT, 'index.pb'), pb);

  const mikoPath = path.join(ROOT, 'miko.json');
  const miko = fs.existsSync(mikoPath) ? JSON.parse(fs.readFileSync(mikoPath, 'utf8')) : {};
  miko.sources = mikoSources;
  fs.writeFileSync(mikoPath, JSON.stringify(miko, null, 2) + '\n');

  console.log(`index.min.json: ${index.length} extensions; index.pb: ${protoExts.length} (${mangaCount} manga); miko.json sources: ${Object.keys(mikoSources).length}`);
}

main().catch(e => { console.error('INDEX BUILD FAILED:', e.message); process.exit(1); });
