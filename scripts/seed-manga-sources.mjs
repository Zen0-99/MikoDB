#!/usr/bin/env node
// seed-manga-sources.mjs — seed miko.json's `manga_sources` tier block
// from the keiyoushi extension index (Phase 12-03).
//
//   node scripts/seed-manga-sources.mjs [--index <path-or-url>]
//
// Each extension gets a SourceMeta block keyed by its package name:
//   name, tier (S/A/B/C), providers[] (MangaBaka provider ids it serves),
//   baseUrl, numbering, lang.
//
// Tiers are curated data — this script seeds defaults; hand-tune the
// generated block afterwards. S = golden reference for chapter layout;
// A = reliable; B = default; C = fragile/reserved.

import fs from 'node:fs';

const INDEX_URL = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json';

// Curated source tiers (Phase 12-03 curation pass).
//
// Provider ids match miko-manga-map.db's provider_links vocabulary
// (LINK_EXTRACTORS in build-manga-map.mjs): mangadex, webtoons, naver,
// novelupdates, royalroad, tapas, comikey, mangaup, toomics, manta,
// tappytoon, inkr, kakao, lezhin, mangaplus.
//
// S — official platforms + MangaDex: canonical chapter numbering,
//     structurally clean feeds, and the targets of provider_links.
// A — reliable aggregators/scrapers: no provider_links coverage (the
//     map only links official platforms), found via title search;
//     their chapter lists are the fallback structure reference.
// B — default.
// C — dead, domain-dead clones, or notorious-quality sources kept
//     only so they never get promoted.
// S — official platforms + MangaDex: canonical chapter numbering,
//     structurally clean feeds, and the targets of provider_links.
// A — reliable aggregators + active scanlation groups (the community
//     backbone — probe-verified alive, maintained, clean naming).
//     Join via title search: scanlators never appear in links_v2.
// B — default.
// C — probe-verified dead (ERR/404/52x origin errors), dead-site
//     clones, or notorious quality. Probed 2026-09-27.
const TIERS = {
    // ---- S: official / canonical feeds ----
    'eu.kanade.tachiyomi.extension.all.mangadex': { tier: 'S', providers: ['mangadex'], numbering: 'volume-chapter' },
    'eu.kanade.tachiyomi.extension.all.mangaplus': { tier: 'S', providers: ['mangaplus'], numbering: 'volume-chapter' },
    'eu.kanade.tachiyomi.extension.all.webtoons': { tier: 'S', providers: ['webtoons'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.ko.navercomic': { tier: 'S', providers: ['naver'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.en.tapastic': { tier: 'S', providers: ['tapas'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.all.comikey': { tier: 'S', providers: ['comikey'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.all.mangaup': { tier: 'S', providers: ['mangaup'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.all.toomics': { tier: 'S', providers: ['toomics'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.all.manta': { tier: 'S', providers: ['manta'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.all.tappytoon': { tier: 'S', providers: ['tappytoon'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.en.inkr': { tier: 'S', providers: ['inkr'], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.en.vizshonenjump': { tier: 'S', providers: [], numbering: 'decimal' },
    'eu.kanade.tachiyomi.extension.en.kmanga': { tier: 'S', providers: [], numbering: 'decimal' },

    // ---- A: large aggregators ----
    'eu.kanade.tachiyomi.extension.en.allanime': { tier: 'A' },        // AllManga — AllAnime's manga arm
    'eu.kanade.tachiyomi.extension.en.weebcentral': { tier: 'A' },      // MangaSee/Manga4Life successor
    'eu.kanade.tachiyomi.extension.en.mangapill': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangago': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.comix': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangahubio': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangademon': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangareadorg': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangagg': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.rizzcomic': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.xoxocomics': { tier: 'A' },       // Western comics
    'eu.kanade.tachiyomi.extension.en.s2manga': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.manhuaplus': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.manhuaus': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.lilymanga': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.asurascans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.flamecomics': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.bbato': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.all.comicklive': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.all.mangafire': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangabat': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangakakalot': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.manganelo': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangahere': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.vyvymanga': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangabuddy': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.webtoonxyz': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.all.niadd': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mangadistrict': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.toonily': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.topmanhua': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.zinmanga': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.manhwatop': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.kunmangaonline': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.hiperdex': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.atsumaru': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.ja.mangaparkpublisher': { tier: 'A' },

    // ---- A: active scanlation groups (the community backbone) ----
    'eu.kanade.tachiyomi.extension.en.arvenscans': { tier: 'A' },        // Vortex Scans
    'eu.kanade.tachiyomi.extension.en.magusmanga': { tier: 'A' },        // Magus Manga
    'eu.kanade.tachiyomi.extension.en.infernalvoidscans': { tier: 'A' }, // Hive Scans
    'eu.kanade.tachiyomi.extension.en.dragontea': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.tritiniascans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.setsuscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.luascans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.suryascans': { tier: 'A' },        // Genz Toons
    'eu.kanade.tachiyomi.extension.en.templescan': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.omegascans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.murimscan': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.infinityscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.witchscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.grimscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.ritharscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.ravenscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.shojoscans': { tier: 'A' },        // Violet Scans
    'eu.kanade.tachiyomi.extension.en.decadencescans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.rosesquadscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.gourmetscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.sleepytranslations': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.lhtranslation': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.nyxscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.lunatoons': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.nyrascans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.aryascans': { tier: 'A' },         // BrainRotComics
    'eu.kanade.tachiyomi.extension.en.mangasushi': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.webdexscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.galaxydegenscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.valirscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.mistscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.kenscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.kaynscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.hijalascans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.orionscans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.renascans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.sanascans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.drakescans': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.elftoon': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.toongod': { tier: 'A' },

    // ---- A: specialist/official-adjacent feeds ----
    'eu.kanade.tachiyomi.extension.en.dynasty': { tier: 'A' },          // Dynasty Scans — excellent metadata
    'eu.kanade.tachiyomi.extension.all.projectsuki': { tier: 'A' },
    'eu.kanade.tachiyomi.extension.en.tcbscans': { tier: 'A' },          // TCB — WSJ official-speed scans
    'eu.kanade.tachiyomi.extension.en.wuxiaworld': { tier: 'A' },        // Wuxia official publisher
    'eu.kanade.tachiyomi.extension.en.kodansha': { tier: 'A' },         // Kodansha official

    // ---- C: probe-verified dead (ERR/404/52x origin) ----
    'eu.kanade.tachiyomi.extension.all.izneo': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.akaicomic': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.asmotoon': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.comickfan': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.cucumbermanga': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.duskscans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.dflowscans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.erisscans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.fairyscans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.frierenonline': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.greedscans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.kewnscans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.all.leagueoflegends': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangabay': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangadia': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangahe': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangaka': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangakiss': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangapdf': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangatx': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.manhuarush': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.manhwahub': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.manhwaz': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.nexcomic': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.nixmanga': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.nyanukafe': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.onepunchmanonline': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.readallcomicscom': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.readblackclovermangaonline': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.readcomiconline': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.rizzcomicunoriginal': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.sirenscans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.all.simplycosplay': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.todaymanga': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.vanillascans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.writerscans': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.all.xgmn': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.yorai': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.all.hentai3': { tier: 'C' },

    // ---- C: alive but clones of dead originals (never golden) ----
    'eu.kanade.tachiyomi.extension.en.mangaowlio': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangapandaonl': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangatown': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.kissmangain': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangareadercc': { tier: 'C' },
    'eu.kanade.tachiyomi.extension.en.mangareadersite': { tier: 'C' },
};

const arg = process.argv.find((a, i) => process.argv[i - 1] === '--index');
const raw = arg
    ? JSON.parse(fs.readFileSync(arg, 'utf8'))
    : await (await fetch(INDEX_URL)).json();
const exts = raw.extensionList?.extensions ?? raw;

const out = {};
let seeded = 0;
for (const ext of exts) {
    const pkg = ext.packageName ?? ext.pkg;
    if (!pkg || pkg === 'eu.kanade.tachiyomi.extension.all.keiyoushi') continue;
    // Multi-source packages (e.g. MangaDex ships ~60 language variants):
    // prefer the 'en' entry, then 'all', then first — otherwise metadata
    // like baseUrl/lang comes from an arbitrary language variant.
    const sources = ext.sources ?? [];
    const src = sources.find(s => s.language === 'en')
        ?? sources.find(s => s.language === 'all')
        ?? sources[0]
        ?? {};
    const cur = TIERS[pkg] ?? {};
    out[pkg] = {
        name: ext.name ?? '',
        tier: cur.tier ?? 'B',
        providers: cur.providers ?? [],
        baseUrl: src.homeUrl ?? src.baseUrl ?? '',
        numbering: cur.numbering ?? 'decimal',
        lang: src.language ?? ext.lang ?? '',
    };
    seeded++;
}

const miko = JSON.parse(fs.readFileSync('miko.json', 'utf8'));
miko.manga_sources = out;
fs.writeFileSync('miko.json', JSON.stringify(miko, null, 2) + '\n');
const tiers = Object.values(out).reduce((m, s) => ((m[s.tier] = (m[s.tier] ?? 0) + 1), m), {});
console.log(`manga_sources: ${seeded} extensions seeded — tiers ${JSON.stringify(tiers)}`);
