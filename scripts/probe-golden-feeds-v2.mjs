// probe-golden-feeds-v2.mjs — deeper probe of S/A-tier manga sources.
//
// v2 differences vs v1:
//  - search-endpoint discovery: tries ~10 URL patterns per source until
//    one yields a series link (v1 tried only `?s=` madara patterns)
//  - page verification: the landed series page's <title>/h1/og:title must
//    share a word with the query, else status=UNVERIFIED_PICK
//  - pagination: generic extraction follows next-page links (≤4 pages)
//  - script-embedded chapter data: scans all <script> bodies for JSON
//    chapter arrays / "name":"Chapter N" strings (covers app-router SPAs)
//  - JSON API search fallbacks on /api/* paths
//
// Same 2 titles × ch.1/ch.50 targets for comparability with v1.
// LOGS ONLY. Run: node scripts/probe-golden-feeds-v2.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const miko = JSON.parse(readFileSync(join(ROOT, 'miko.json'), 'utf8'));
const { parseChapter } = require('C:/Users/karol/AppData/Local/Temp/chapterparse.cjs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TITLES = ['Naruto', 'Solo Leveling'];
const TARGETS = [1, 50];

const sources = Object.entries(miko.manga_sources)
    .filter(([, v]) => v.tier === 'S' || v.tier === 'A')
    .map(([pkg, v]) => ({ pkg, name: v.name, tier: v.tier, lang: v.lang, base: v.baseUrl }))
    .sort((a, b) => a.tier.localeCompare(b.tier) || a.name.localeCompare(b.name));

async function fetchText(url, { method = 'GET', headers = {}, body, timeout = 25000 } = {}) {
    const res = await fetch(url, {
        method, body, redirect: 'follow', signal: AbortSignal.timeout(timeout),
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            ...headers,
        },
    });
    const text = await res.text();
    const cf = res.status === 403 || res.status === 503 ||
        /cf-chl|cf-browser-verification|challenge-platform|just a moment|cf-mitigated/i.test(text.slice(0, 4000));
    return { status: res.status, text, url: res.url, cf };
}
const safeFetch = async (u, o) => { try { return await fetchText(u, o); } catch { return null; } };

const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#039;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const anchors = (html) => [...html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ href: m[1], text: strip(m[2]) }));
const words = (t) => t.toLowerCase().split(/\s+/).filter(w => w.length > 1);

const SERIES_PATH = /\/(manga|series|comic|webtoon|manhwa|manhua|title|novel|book|read|works|project)s?\/[\w-]/i;
const CHAPTER_TEXT = /\b(chapter|chap|ch\.|episode|ep\.|vol\.|act|stage|prologue|epilogue|oneshot|omake|extra|side story|bonus)\b|^\s*\d+(\.\d+)?[a-z]?\s*$/i;

function pageTitle(html) {
    return (html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1]
        ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
        ?? html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
}

function verified(html, q) {
    const t = pageTitle(html).toLowerCase();
    return words(q).some(w => t.includes(w));
}

// pick a series link out of a search-results page
function pickSeriesLink(html, base, q) {
    const host = new URL(base).host;
    const qw = words(q);
    const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const cand = anchors(html)
        .filter(a => (a.href.includes(host) || a.href.startsWith('/'))
            && !/\/(chapter|page|viewer|read-online|chapter-list)/i.test(a.href))
        .filter(a => SERIES_PATH.test(a.href) || a.href.toLowerCase().includes(slug))
        .map(a => a.href.startsWith('/') ? `https://${host}${a.href}` : a.href.replace(/[?#].*$/, ''));
    const uniq = [...new Set(cand)];
    return uniq.find(u => qw.every(w => u.toLowerCase().includes(w)))
        ?? uniq.find(u => qw.some(w => u.toLowerCase().includes(w)))
        ?? uniq[0] ?? null;
}

// ---------- chapter extraction ----------

function* walkStrings(obj, path = []) {
    if (obj == null) return;
    if (typeof obj === 'string' || typeof obj === 'number') { yield { v: String(obj), path }; return; }
    if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) yield* walkStrings(obj[i], [...path, i]); return; }
    if (typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) yield* walkStrings(v, [...path, k]); }
}

function namesFromJson(json) {
    const found = new Set();
    for (const { v, path } of walkStrings(json)) {
        const key = String(path[path.length - 1] ?? '');
        if (/^(name|title|chaptername|chapter_name|chapter|label)$/i.test(key)
            && CHAPTER_TEXT.test(v) && v.length < 120) found.add(v.trim());
    }
    return [...found];
}

function extractChapters(html) {
    // madara inline
    let names = [...html.matchAll(/<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)]
        .map(m => strip(m[1])).filter(Boolean);
    if (names.length > 2) return { via: 'madara-inline', names };
    // themesia
    const nums = [...html.matchAll(/class="chapternum"[^>]*>([\s\S]*?)</gi)].map(m => strip(m[1])).filter(Boolean);
    if (nums.length > 2) return { via: 'themesia', names: nums };
    const cl = html.match(/id="chapterlist"[\s\S]*?<\/ul>/i);
    if (cl) {
        names = anchors(cl[0]).map(a => a.text).filter(t => CHAPTER_TEXT.test(t));
        if (names.length > 2) return { via: 'themesia', names };
    }
    // script-embedded JSON (next.js / RSC / data blobs)
    const found = new Set();
    for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
        const body = m[1];
        if (!/chapter|episode/i.test(body) || body.length < 100) continue;
        // whole-json scripts
        for (const jm of body.matchAll(/\{[\s\S]*\}/g)) {
            try { for (const n of namesFromJson(JSON.parse(jm[0]))) found.add(n); } catch { /* nested */ }
        }
        // raw "name":"..." string pairs (RSC streams aren't valid json wholesale)
        for (const sm of body.matchAll(/"(?:name|title|chapterName)":\s*"((?:[^"\\]|\\.){0,110})"/g)) {
            try { const v = JSON.parse(`"${sm[1]}"`); if (CHAPTER_TEXT.test(v)) found.add(v.trim()); }
            catch { /* skip */ }
        }
    }
    if (found.size > 2) return { via: 'script-json', names: [...found] };
    // generic anchors
    names = anchors(html).filter(a => CHAPTER_TEXT.test(a.text) && a.text.length < 120).map(a => a.text);
    if (names.length) return { via: 'generic-anchors', names };
    return null;
}

function nextPageLinks(html, pageUrl) {
    const links = new Set();
    for (const a of anchors(html)) {
        if (/rel="?next/i.test(a.href)) links.add(a.href);
        const u = a.href.startsWith('/') ? new URL(a.href, pageUrl).href : a.href;
        if (u.startsWith(pageUrl.split('?')[0]) && /[?&](page|paged)=\d+/.test(u)) links.add(u);
    }
    return [...links].slice(0, 4);
}

// ---------- special handlers ----------

async function hMangadex(q) {
    const s = JSON.parse((await fetchText(`https://api.mangadex.org/manga?title=${encodeURIComponent(q)}&limit=5`)).text);
    const hit = (s.data ?? [])[0];
    if (!hit) return { status: 'NO_SEARCH_HIT' };
    const names = [];
    for (let offset = 0; offset < 4000; offset += 500) {
        const f = JSON.parse((await fetchText(
            `https://api.mangadex.org/manga/${hit.id}/feed?translatedLanguage[]=en&limit=500&offset=${offset}&order[chapter]=asc`)).text);
        for (const c of f.data ?? []) {
            const a = c.attributes;
            names.push(a.chapter ? `Chapter ${a.chapter}${a.title ? ` - ${a.title}` : ''}` : (a.title ?? 'Oneshot'));
        }
        if (!f.data || f.data.length < 500 || names.length >= (f.total ?? 0)) break;
    }
    return { status: 'OK', via: 'api', chapters: names.map(name => ({ name })), picked: hit.id };
}

async function hWeebcentral(q) {
    const s = await fetchText(`https://weebcentral.com/search/simple?location=main&search_input=${encodeURIComponent(q)}`,
        { headers: { 'HX-Request': 'true' } });
    const link = anchors(s.text).find(a => /\/series\//.test(a.href));
    if (!link) return { status: 'NO_SEARCH_HIT' };
    const page = await fetchText(link.href);
    const chapters = anchors(page.text)
        .filter(a => /\bchapter\b|\/chapters\//i.test(a.href + a.text))
        .map(a => ({ name: a.text }));
    return chapters.length ? { status: 'OK', via: 'htmx', chapters, picked: link.href } : { status: 'NO_CHAPTER_LIST', picked: link.href };
}

async function hKakalot(base, q) {
    for (const slug of [q.toLowerCase().replace(/[^a-z0-9]+/g, '_'), q.toLowerCase().replace(/[^a-z0-9]+/g, '-')]) {
        const s = await safeFetch(`${base}/search/story/${slug}`);
        if (!s || s.status !== 200) continue;
        const link = anchors(s.text).find(a => /\/(manga|read-manga)\//.test(a.href));
        if (!link) continue;
        const page = await fetchText(link.href);
        const chapters = anchors(page.text).filter(a => /chapter/i.test(a.href)).map(a => ({ name: a.text }));
        return chapters.length ? { status: 'OK', via: 'kakalot', chapters, picked: link.href } : { status: 'NO_CHAPTER_LIST', picked: link.href };
    }
    return { status: 'NO_SEARCH_HIT' };
}

async function hWebtoons(q) {
    const s = await fetchText(`https://www.webtoons.com/en/search?keyword=${encodeURIComponent(q)}`);
    const link = anchors(s.text).find(a => /list\?title_no=\d+/.test(a.href));
    if (!link) return { status: 'NO_SEARCH_HIT' };
    const m = link.href.match(/title_no=(\d+)/);
    const page = await fetchText(`https://www.webtoons.com/episodeList?titleNo=${m[1]}`,
        { headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: link.href } });
    const chapters = anchors(page.text)
        .map(a => ({ name: a.text.match(/(ep(?:isode)?\.?\s*\d+|chapter\s*\d+|prologue|epilogue)/i)?.[0] ?? '' }))
        .filter(c => c.name);
    return chapters.length ? { status: 'OK', via: 'webtoons-ajax', chapters, picked: m[1] } : { status: 'NO_CHAPTER_LIST', picked: m[1] };
}

// ---------- generic discovery ----------

const SEARCH_PATTERNS = [
    (b, q) => `${b}/?s=${q}&post_type=wp-manga`,
    (b, q) => `${b}/?s=${q}`,
    (b, q) => `${b}/search?query=${q}`,
    (b, q) => `${b}/search?q=${q}`,
    (b, q) => `${b}/search?keyword=${q}`,
    (b, q) => `${b}/search?title=${q}`,
    (b, q) => `${b}/search?name=${q}`,
    (b, q, slug) => `${b}/search/${slug}`,
    (b, q) => `${b}/series?name=${q}`,
    (b, q) => `${b}/series?search=${q}`,
    (b, q) => `${b}/comics?q=${q}`,
    (b, q) => `${b}/manga?title=${q}`,
];

async function hGeneric(src, q) {
    const base = src.base.replace(/\/$/, '');
    const enc = encodeURIComponent(q);
    const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const tried = [];
    let cfSeen = false;
    for (const pat of SEARCH_PATTERNS) {
        const url = pat(base, enc, slug);
        const s = await safeFetch(url);
        tried.push(url.replace(base, ''));
        if (!s) continue;
        if (s.cf) { cfSeen = true; continue; }
        if (s.status !== 200) continue;
        const hit = pickSeriesLink(s.text, base, q);
        if (!hit) continue;
        const page = await safeFetch(hit);
        if (!page) return { status: 'ERR_PAGE', tried };
        if (page.cf) { cfSeen = true; continue; }
        if (page.status !== 200) continue;
        // madara ajax
        if (page.text.includes('ajax/chapters')) {
            const ajax = await safeFetch(`${hit.replace(/\/?$/, '/')}ajax/chapters/`,
                { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: hit } });
            const names = ajax ? [...ajax.text.matchAll(/<li[^>]*wp-manga-chapter[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)].map(m => strip(m[1])) : [];
            if (names.length) return { status: verified(page.text, q) ? 'OK' : 'OK_UNVERIFIED', via: 'madara-ajax', chapters: names.map(name => ({ name })), picked: hit };
        }
        const ex = extractChapters(page.text);
        const names = ex ? [...ex.names] : [];
        // paginate generic results that look truncated
        if (ex && ex.via === 'generic-anchors' && names.length < 60) {
            const seen = new Set(names);
            for (const np of nextPageLinks(page.text, page.url)) {
                const p2 = await safeFetch(np);
                if (!p2 || p2.status !== 200) continue;
                const ex2 = extractChapters(p2.text);
                for (const n of ex2?.names ?? []) { if (!seen.has(n)) { seen.add(n); names.push(n); } }
            }
        }
        if (names.length) return { status: verified(page.text, q) ? 'OK' : 'OK_UNVERIFIED', via: ex.via, chapters: names.map(name => ({ name })), picked: hit };
        return { status: verified(page.text, q) ? 'NO_CHAPTER_LIST' : 'WRONG_PAGE', picked: hit, tried };
    }
    return { status: cfSeen ? 'CF_BLOCKED' : 'NO_SEARCH_HIT', tried };
}

const SPECIAL = {
    'all.mangadex': (s, q) => hMangadex(q),
    'en.weebcentral': (s, q) => hWeebcentral(q),
    'en.mangakakalot': (s, q) => hKakalot(s.base, q),
    'en.manganelo': (s, q) => hKakalot(s.base, q),
    'en.mangabat': (s, q) => hKakalot(s.base, q),
    'all.webtoons': (s, q) => hWebtoons(q),
};

async function probe(src, title) {
    const short = src.pkg.replace('eu.kanade.tachiyomi.extension.', '');
    try {
        const fn = SPECIAL[short];
        const r = fn ? await fn(src, title) : await hGeneric(src, title);
        const out = { source: short, tier: src.tier, title, ...r };
        if (r.status?.startsWith('OK') && r.chapters) {
            const parsed = r.chapters.map(c => ({ ...c, p: safeParse(c.name) }));
            for (const t of TARGETS) {
                const hits = parsed.filter(c => c.p?.kind === 'chapter' && c.p.number === t);
                out[`ch${t}`] = hits.length ? hits.slice(0, 3).map(h => `${h.name}  => ${JSON.stringify(h.p)}`) : null;
            }
            out.parsedCount = parsed.filter(c => c.p && c.p.kind !== 'unknown').length;
            out.totalNames = parsed.length;
            delete out.chapters;
        }
        return out;
    } catch (e) {
        return { source: short, tier: src.tier, title, status: 'ERR', error: String(e.message ?? e).slice(0, 120) };
    }
}
const safeParse = (name) => { try { return parseChapter(name); } catch { return null; } };

const results = [];
const queue = [];
for (const s of sources) for (const t of TITLES) queue.push([s, t]);
let done = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
        const [s, t] = queue.shift();
        const r = await probe(s, t);
        results.push(r);
        process.stdout.write(`\r${++done}/${sources.length * TITLES.length} ${r.source} "${r.title}" -> ${r.status}${' '.repeat(24)}`);
    }
}));
console.log('\nprobe v2 complete');

const stamp = new Date().toISOString().slice(0, 10);
const dir = join(ROOT, 'reports');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `golden-probe-v2-${stamp}.json`), JSON.stringify(results, null, 2));
const lines = ['| tier | source | title | status | total | parsed | 1 | 50 | via |', '|---|---|---|---|---|---|---|---|---|'];
for (const r of results.sort((a, b) => a.tier.localeCompare(b.tier) || a.source.localeCompare(b.source) || a.title.localeCompare(b.title))) {
    const cell = v => v ? v[0].slice(0, 55) : (r.status?.startsWith('OK') ? 'MISS' : '-');
    lines.push(`| ${r.tier} | ${r.source} | ${r.title} | ${r.status}${r.error ? ' ' + r.error : ''} | ${r.totalNames ?? '-'} | ${r.parsedCount ?? '-'} | ${cell(r.ch1)} | ${cell(r.ch50)} | ${r.via ?? r.picked ?? '-'} |`);
}
writeFileSync(join(dir, `golden-probe-v2-${stamp}.md`), `# Golden-source feed probe v2 — ${stamp}\n\n${lines.join('\n')}\n`);
console.log(`wrote reports/golden-probe-v2-${stamp}.{json,md} — ${results.length} cells`);
