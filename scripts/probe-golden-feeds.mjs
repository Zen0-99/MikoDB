// probe-golden-feeds.mjs — live probe of S/A-tier manga sources.
//
// For each S/A source in miko.json: search "Naruto" + "Solo Leveling",
// open the best-matching series page, extract the chapter list, find
// the entries that represent Chapter 1 and Chapter 50, and run the
// real worker chapter parser (chapterparse.ts, esbuilt to a temp .cjs)
// on the raw names. LOGS ONLY — fixes nothing.
//
//   node scripts/probe-golden-feeds.mjs
//
// Rebuild the parser bundle first if chapterparse.ts changed:
//   cd ../Miko/worker && ./node_modules/.bin/esbuild src/chapterparse.ts \
//     --bundle --format=cjs --outfile="$TMP/chapterparse.cjs"

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
    const cf = res.status === 403 || /cf-chl|cf-browser-verification|challenge-platform|just a moment/i.test(text.slice(0, 4000));
    return { status: res.status, text, url: res.url, cf };
}

const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const anchors = (html) => [...html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
    .map(m => ({ href: m[1], text: strip(m[2]) }));
const slugWords = (t) => t.toLowerCase().split(/\s+/);

// ---------- special handlers ----------

async function hMangadex(q) {
    const s = JSON.parse((await fetchText(`https://api.mangadex.org/manga?title=${encodeURIComponent(q)}&limit=5`)).text);
    const hit = (s.data ?? [])[0];
    if (!hit) return { status: 'NO_SEARCH_HIT' };
    const f = JSON.parse((await fetchText(`https://api.mangadex.org/manga/${hit.id}/feed?translatedLanguage[]=en&limit=500&order[chapter]=asc`)).text);
    const chapters = (f.data ?? []).map(c => {
        const a = c.attributes;
        const base = a.chapter ? `Chapter ${a.chapter}` : (a.title ?? 'Oneshot');
        return { name: a.volume ? `Vol.${a.volume} ${base}${a.title ? ` - ${a.title}` : ''}` : `${base}${a.title ? ` - ${a.title}` : ''}` };
    });
    return { status: 'OK', chapters, picked: hit.id };
}

async function hComick(q) {
    const s = JSON.parse((await fetchText(`https://api.comick.io/v1.0/search?q=${encodeURIComponent(q)}`)).text);
    const hit = (s ?? [])[0];
    if (!hit) return { status: 'NO_SEARCH_HIT' };
    const f = JSON.parse((await fetchText(`https://api.comick.fun/comic/${hit.hid}/chapters?lang=en&limit=2000`)).text);
    const chapters = (f.chapters ?? []).map(c => ({ name: `Chapter ${c.chap ?? '?'}${c.title ? ` - ${c.title}` : ''}` }));
    return { status: 'OK', chapters, picked: hit.hid };
}

async function hMangaplus(q) {
    const list = JSON.parse((await fetchText('https://jumpg-webapi.tokyo-cdn.com/api/title_list/allV2')).text);
    const all = list.allTitlesGroupV2?.theWholeTitleList ?? list.allTitlesGroupV2?.mangaTitleList ?? [];
    const hit = all.find(t => t.name?.toLowerCase() === q.toLowerCase())
        ?? all.find(t => t.name?.toLowerCase().includes(q.toLowerCase()));
    if (!hit) return { status: 'NO_SEARCH_HIT' };
    const d = JSON.parse((await fetchText(`https://jumpg-webapi.tokyo-cdn.com/api/title_detailV3?title_id=${hit.titleId}`)).text);
    const g = d.titleDetailV3?.chapterListGroup;
    const chapters = [...(g?.firstChapterList ?? []), ...(g?.midChapterList ?? []), ...(g?.lastChapterList ?? [])]
        .map(c => ({ name: c.name }));
    return { status: 'OK', chapters, picked: hit.name };
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
    return chapters.length ? { status: 'OK', chapters, picked: link.href } : { status: 'NO_CHAPTER_LIST' };
}

async function hKakalot(base, q) {
    const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const s = await fetchText(`${base}/search/story/${slug}`);
    const link = anchors(s.text).find(a => /\/(manga|read-manga)\//.test(a.href));
    if (!link) return { status: 'NO_SEARCH_HIT' };
    const page = await fetchText(link.href);
    const chapters = anchors(page.text)
        .filter(a => /chapter/i.test(a.href))
        .map(a => ({ name: a.text }));
    return chapters.length ? { status: 'OK', chapters, picked: link.href } : { status: 'NO_CHAPTER_LIST' };
}

async function hWebtoons(q) {
    const s = await fetchText(`https://www.webtoons.com/en/search?keyword=${encodeURIComponent(q)}`);
    const link = anchors(s.text).find(a => /list\?title_no=\d+/.test(a.href));
    if (!link) return { status: 'NO_SEARCH_HIT' };
    const url = link.href.startsWith('http') ? link.href : `https://www.webtoons.com${link.href}`;
    const m = url.match(/title_no=(\d+)/);
    const page = await fetchText(`https://www.webtoons.com/episodeList?titleNo=${m[1]}`,
        { headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: url } });
    const chapters = anchors(page.text)
        .map(a => ({ name: a.text.match(/(ep(?:isode)?\.?\s*\d+|chapter\s*\d+|prologue|epilogue)/i)?.[0] ?? '' }))
        .filter(c => c.name);
    return chapters.length ? { status: 'OK', chapters, picked: m[1] } : { status: 'NO_CHAPTER_LIST' };
}

// ---------- generic html pipeline (madara / themesia / next / fallback) ----------

const MANGA_PATH = /\/(manga|series|comic|webtoon|manhwa|title|novel|project)s?\/[\w-]/i;
const CHAPTER_TEXT = /\b(chapter|chap|ch\.|episode|ep\.|vol\.|book|act|stage|part|prologue|epilogue|oneshot|omake|extra|side story)\b|^\s*\d+(\.\d+)?[a-z]?\s*$/i;

function pickSearchHit(html, base, q) {
    const words = slugWords(q);
    const cand = anchors(html)
        .filter(a => a.href.startsWith('http') && a.href.startsWith(base.replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, m => m)) || a.href.includes(new URL(base).host))
        .filter(a => MANGA_PATH.test(a.href) && !/chapter|episode|page/i.test(a.href.split('/').pop() ?? ''))
        .map(a => a.href.replace(/[?#].*$/, ''));
    const uniq = [...new Set(cand)];
    return uniq.find(u => words.every(w => u.toLowerCase().includes(w))) ?? uniq[0] ?? null;
}

function extractNextJson(html) {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

function* walkStrings(obj, path = []) {
    if (typeof obj === 'string' || typeof obj === 'number') { yield { v: String(obj), path }; return; }
    if (Array.isArray(obj)) { for (let i = 0; i < obj.length; i++) yield* walkStrings(obj[i], [...path, i]); return; }
    if (obj && typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) yield* walkStrings(v, [...path, k]); }
}

function extractChapters(html, mangaUrl) {
    // madara embedded
    let names = [...html.matchAll(/<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)]
        .map(m => strip(m[1]));
    if (names.length) return { via: 'madara-inline', names };
    // themesia
    names = [...html.matchAll(/<li[^>]*data-num="([\d.]+)"[\s\S]*?<a[^>]*>[\s\S]*?<span[^>]*class="chapternum"[^>]*>([\s\S]*?)<\/span>/gi)]
        .map(m => strip(m[2]));
    if (names.length) return { via: 'themesia', names };
    const cl = html.match(/<div[^>]*id="chapterlist"[\s\S]*?<\/ul>/i);
    if (cl) {
        names = anchors(cl[0]).map(a => a.text.match(/chapternum/i) ? '' : a.text).filter(Boolean);
        const nums = [...cl[0].matchAll(/class="chapternum"[^>]*>([\s\S]*?)</gi)].map(m => strip(m[1]));
        if (nums.length) return { via: 'themesia', names: nums };
        if (names.length) return { via: 'themesia', names };
    }
    // next.js embedded json
    const nj = extractNextJson(html);
    if (nj) {
        const found = new Set();
        for (const { v, path } of walkStrings(nj)) {
            const key = String(path[path.length - 1] ?? '');
            if (/^(name|title|chaptername|chapter_name)$/i.test(key) && CHAPTER_TEXT.test(v) && v.length < 120) found.add(v);
        }
        if (found.size) return { via: 'next-json', names: [...found] };
    }
    // generic anchors
    names = anchors(html)
        .filter(a => CHAPTER_TEXT.test(a.text) && a.text.length < 120)
        .map(a => a.text);
    if (names.length) return { via: 'generic-anchors', names };
    return null;
}

async function hGeneric(src, q) {
    const base = src.base.replace(/\/$/, '');
    // madara-style search first, then plain
    for (const url of [`${base}/?s=${encodeURIComponent(q)}&post_type=wp-manga`, `${base}/?s=${encodeURIComponent(q)}`]) {
        const s = await fetchText(url);
        if (s.cf) return { status: 'CF_BLOCKED' };
        if (s.status === 404) continue;
        if (s.status !== 200) return { status: `HTTP_${s.status}` };
        const hit = pickSearchHit(s.text, base, q);
        if (!hit) continue;
        const page = await fetchText(hit);
        if (page.cf) return { status: 'CF_BLOCKED' };
        if (page.status !== 200) return { status: `HTTP_${page.status}_PAGE` };
        // madara ajax chapters
        if (page.text.includes('ajax/chapters')) {
            const ajax = await fetchText(`${hit.replace(/\/?$/, '/')}ajax/chapters/`, {
                method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: hit },
            });
            const names = [...ajax.text.matchAll(/<li[^>]*wp-manga-chapter[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/gi)].map(m => strip(m[1]));
            if (names.length) return { status: 'OK', via: 'madara-ajax', chapters: names.map(name => ({ name })), picked: hit };
        }
        const ex = extractChapters(page.text, hit);
        if (ex) return { status: 'OK', via: ex.via, chapters: ex.names.map(name => ({ name })), picked: hit };
        return { status: 'NO_CHAPTER_LIST', picked: hit };
    }
    return { status: 'NO_SEARCH_HIT' };
}

// ---------- dispatch ----------

const SPECIAL = {
    'all.mangadex': (s, q) => hMangadex(q),
    'all.mangaplus': (s, q) => hMangaplus(q),
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
        if (r.status === 'OK') {
            const parsed = r.chapters.map(c => ({ ...c, p: safeParse(c.name) }));
            for (const t of TARGETS) {
                const hits = parsed.filter(c => c.p?.kind === 'chapter' && c.p.number === t);
                out[`ch${t}`] = hits.length
                    ? hits.slice(0, 3).map(h => `${h.name}  => ${JSON.stringify(h.p)}`)
                    : null;
            }
            out.parsedCount = parsed.filter(c => c.p && c.p.kind !== 'unknown').length;
            delete out.chapters;
        }
        return out;
    } catch (e) {
        return { source: short, tier: src.tier, title, status: 'ERR', error: String(e.message ?? e).slice(0, 120) };
    }
}

const safeParse = (name) => { try { return parseChapter(name); } catch { return null; } };

// ---------- run ----------

const results = [];
const queue = [];
for (const s of sources) for (const t of TITLES) queue.push([s, t]);
const CONC = 4;
let done = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
    while (queue.length) {
        const [s, t] = queue.shift();
        const r = await probe(s, t);
        results.push(r);
        process.stdout.write(`\r${++done}/${sources.length * TITLES.length} ${r.source} "${r.title}" -> ${r.status}${' '.repeat(20)}`);
    }
}));
console.log('\nprobe complete');

const stamp = new Date().toISOString().slice(0, 10);
const dir = join(ROOT, 'reports');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `golden-probe-${stamp}.json`), JSON.stringify(results, null, 2));

// markdown log
const lines = ['| tier | source | title | status | ch found | 1 | 50 | via/picked |', '|---|---|---|---|---|---|---|---|'];
for (const r of results.sort((a, b) => a.tier.localeCompare(b.tier) || a.source.localeCompare(b.source) || a.title.localeCompare(b.title))) {
    const ch1 = r.ch1 ? r.ch1[0].slice(0, 60) : (r.status === 'OK' ? 'MISS' : '-');
    const ch50 = r.ch50 ? r.ch50[0].slice(0, 60) : (r.status === 'OK' ? 'MISS' : '-');
    lines.push(`| ${r.tier} | ${r.source} | ${r.title} | ${r.status}${r.error ? ' ' + r.error : ''} | ${r.parsedCount ?? '-'} | ${ch1} | ${ch50} | ${r.via ?? r.picked ?? '-'} |`);
}
writeFileSync(join(dir, `golden-probe-${stamp}.md`), `# Golden-source feed probe — ${stamp}\n\n${lines.join('\n')}\n`);
console.log(`wrote reports/golden-probe-${stamp}.{json,md} — ${results.length} cells`);
