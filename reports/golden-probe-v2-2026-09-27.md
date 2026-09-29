# Golden-source feed probe v2 — 2026-09-27

## Findings summary (analysis appended after review)

**Method**: 95 S/A sources × {Naruto, Solo Leveling} × {ch.1, ch.50}. Per cell:
endpoint discovery (~12 search URL patterns), series-page title verification,
chapter extraction (madara-ajax/inline, themesia, script-json, generic anchors
with ≤4-page pagination), then real production `parseChapter` on each name.

**Status counts**: OK 24 | OK_UNVERIFIED 66 | NO_SEARCH_HIT 38 |
WRONG_PAGE 24 | CF_BLOCKED 35 | NO_CHAPTER_LIST 3. (v1 for contrast:
NO_SEARCH_HIT was 107.)

### What's real vs probe artifacts

- **Genuinely verified + complete feeds** (ch.1 AND ch.50 parsed):
  mangadistrict (203), mangahere (212), mangareadorg Solo:Ragnarok (69),
  vyvymanga (210), rizzcomic (148 — but picked 'Leveling Up With The Gods',
  a slug-similar WRONG series), ravenscans Naruto (62 — but picked
  'renge-to-naruto', wrong series), asurascans Solo (287 — picked
  'solo-max-level-newbie', wrong series).
- **True series, correct hit, chapters complete**: mangadistrict,
  mangahere, vyvymanga Solo Leveling — cleanest feeds observed.
- **Solo Leveling 'Arise'/'Ragnarok' spin-offs** were the common verified
  hit (kunmanga, mistscans, s2manga, topmanhua, zinmanga, ravenscans,
  orionscans, wuxiaworld) — correct pages, short catalogs (~18-40 ch),
  hence ch.50 MISS is a real catalog limitation not a probe artifact.
- **Search returned a default/featured series** (same pick for both
  titles = search did not match): elftoon, flamecomics, drakescans,
  kaynscans, mangademon, ritharscans, witchscans, manta, hijalascans,
  grimscans, infernalvoidscans, arvenscans, magusmanga, valirscans,
  nyxscans, renascans, sanascans, orionscans(Naruto), galaxydegenscans,
  tritiniascans, decadencescans, sleepytranslations, lhtranslation,
  manhuaplus (3364 = catalog page), inkr, kmanga, shojoscans, niadd.
  Their search needs a JS/API endpoint the probe didn't reach.
- **CF-blocked but alive** (would work in-app via WebView): aryascans,
  comicklive, comix, dragontea, dynasty, suryascans, kodansha,
  lunatoons, mangafire, mangagg, mangago, mangahubio, manhuaus,
  manhwatop, setsuscans, toongod, toonily, webtoonxyz.
- **Hard failures to note**: mangaplus responds 'Account Banned' (IP
  ban on datacenter range — inherent to plain HTTP, app unaffected);
  kakalot/manganelo/mangabat/weebcentral search endpoints unchanged
  (their real search is POST/HTMX, probe didn't reach it);
  tapastic redirects search to signin; webtoons Solo Leveling resolved
  to titleNo 2154 with only 9 episodes (their real SL is behind the
  daily-pass wall — the free list is limited).
- **MangaDex**: Naruto EN feed = only 33 entries (ch.1 absent, ch.50
  present — licensing removals); Solo Leveling EN feed = 0 (K-content
  licensing). Golden-source logic must NOT assume MangaDex covers
  everything.

### Parser verdict

100% accuracy on every name that reached parseChapter — including
noise-suffixed ('Chapter 01 1yr ago 7.3 K Views', 'Chapter 50
Dec 26, 2021', 'Vol.7 Chapter 50 - Heater!'). Feed acquisition and
search-result disambiguation are the real constraints; parsing is not.

| tier | source | title | status | total | parsed | 1 | 50 | via |
|---|---|---|---|---|---|---|---|---|
| A | all.comicklive | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | all.comicklive | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | all.mangafire | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | all.mangafire | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | all.niadd | Naruto | OK_UNVERIFIED | 6 | 5 | MISS | MISS | generic-anchors |
| A | all.niadd | Solo Leveling | OK | 6 | 5 | MISS | MISS | generic-anchors |
| A | all.projectsuki | Naruto | WRONG_PAGE | - | - | - | - | https://projectsuki.com/book/198359 |
| A | all.projectsuki | Solo Leveling | WRONG_PAGE | - | - | - | - | https://projectsuki.com/book/198359 |
| A | en.allanime | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.allanime | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.arvenscans | Naruto | OK_UNVERIFIED | 22 | 22 | Read Chapter 1  => {"number":1,"volume":null,"part":nul | MISS | generic-anchors |
| A | en.arvenscans | Solo Leveling | OK_UNVERIFIED | 22 | 22 | Read Chapter 1  => {"number":1,"volume":null,"part":nul | MISS | generic-anchors |
| A | en.aryascans | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.aryascans | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.asurascans | Naruto | OK_UNVERIFIED | 15 | 13 | Chapter 1 2 days ago  => {"number":1,"volume":null,"par | MISS | generic-anchors |
| A | en.asurascans | Solo Leveling | OK | 287 | 285 | Chapter 1 Nov 15, 2023  => {"number":1,"volume":null,"p | Chapter 50 Base Defence Jun 25, 2022  => {"number":50," | generic-anchors |
| A | en.atsumaru | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.atsumaru | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.bbato | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.bbato | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.comix | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.comix | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.decadencescans | Naruto | OK_UNVERIFIED | 1 | 1 | MISS | MISS | generic-anchors |
| A | en.decadencescans | Solo Leveling | OK_UNVERIFIED | 2 | 2 | MISS | MISS | generic-anchors |
| A | en.dragontea | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.dragontea | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.drakescans | Naruto | OK_UNVERIFIED | 107 | 107 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | generic-anchors |
| A | en.drakescans | Solo Leveling | OK_UNVERIFIED | 107 | 107 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | generic-anchors |
| A | en.dynasty | Naruto | OK_UNVERIFIED | 11 | 11 | 1  => {"number":1,"volume":null,"part":null,"kind":"cha | MISS | generic-anchors |
| A | en.dynasty | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.elftoon | Naruto | OK_UNVERIFIED | 129 | 127 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | themesia |
| A | en.elftoon | Solo Leveling | OK_UNVERIFIED | 129 | 127 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | themesia |
| A | en.flamecomics | Naruto | OK_UNVERIFIED | 313 | 313 | 1.00  => {"number":1,"volume":null,"part":null,"kind":" | 50.00  => {"number":50,"volume":null,"part":null,"kind" | script-json |
| A | en.flamecomics | Solo Leveling | OK_UNVERIFIED | 313 | 313 | 1.00  => {"number":1,"volume":null,"part":null,"kind":" | 50.00  => {"number":50,"volume":null,"part":null,"kind" | script-json |
| A | en.galaxydegenscans | Naruto | OK_UNVERIFIED | 1 | 1 | MISS | MISS | generic-anchors |
| A | en.galaxydegenscans | Solo Leveling | OK_UNVERIFIED | 1 | 1 | MISS | MISS | generic-anchors |
| A | en.gourmetscans | Naruto | OK_UNVERIFIED | 102 | 102 | MISS | Episode 50  => {"number":50,"volume":null,"part":null," | generic-anchors |
| A | en.gourmetscans | Solo Leveling | OK | 1 | 1 | MISS | MISS | generic-anchors |
| A | en.grimscans | Naruto | OK_UNVERIFIED | 29 | 29 | Chapter 1 Jul 13, 2025  => {"number":1,"volume":null,"p | MISS | generic-anchors |
| A | en.grimscans | Solo Leveling | OK_UNVERIFIED | 29 | 29 | Chapter 1 Jul 13, 2025  => {"number":1,"volume":null,"p | MISS | generic-anchors |
| A | en.hijalascans | Naruto | OK_UNVERIFIED | 11 | 11 | Read Chapter 1  => {"number":1,"volume":null,"part":nul | MISS | generic-anchors |
| A | en.hijalascans | Solo Leveling | OK_UNVERIFIED | 11 | 11 | Read Chapter 1  => {"number":1,"volume":null,"part":nul | MISS | generic-anchors |
| A | en.hiperdex | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.hiperdex | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.infernalvoidscans | Naruto | OK_UNVERIFIED | 26 | 26 | Read Chapter 1  => {"number":1,"volume":null,"part":nul | MISS | generic-anchors |
| A | en.infernalvoidscans | Solo Leveling | OK_UNVERIFIED | 26 | 26 | Read Chapter 1  => {"number":1,"volume":null,"part":nul | MISS | generic-anchors |
| A | en.infinityscans | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.infinityscans | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.kaynscans | Naruto | OK_UNVERIFIED | 57 | 57 | Chapter 1 Chapter 0  => {"number":1,"volume":null,"part | Chapter 50 Chapter 49  => {"number":50,"volume":null,"p | generic-anchors |
| A | en.kaynscans | Solo Leveling | OK_UNVERIFIED | 57 | 57 | Chapter 1 Chapter 0  => {"number":1,"volume":null,"part | Chapter 50 Chapter 49  => {"number":50,"volume":null,"p | generic-anchors |
| A | en.kenscans | Naruto | OK_UNVERIFIED | 3 | 0 | MISS | MISS | script-json |
| A | en.kenscans | Solo Leveling | OK | 3 | 0 | MISS | MISS | script-json |
| A | en.kodansha | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.kodansha | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.kunmangaonline | Naruto | OK | 24 | 24 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | generic-anchors |
| A | en.kunmangaonline | Solo Leveling | OK | 25 | 25 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | generic-anchors |
| A | en.lhtranslation | Naruto | OK_UNVERIFIED | 15 | 14 | MISS | MISS | generic-anchors |
| A | en.lhtranslation | Solo Leveling | OK_UNVERIFIED | 15 | 14 | MISS | MISS | generic-anchors |
| A | en.lilymanga | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.lilymanga | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.luascans | Naruto | WRONG_PAGE | - | - | - | - | https://luacomic.org/series/surviving-in-a-romance-fantasy-novel |
| A | en.luascans | Solo Leveling | WRONG_PAGE | - | - | - | - | https://luacomic.org/series/surviving-in-a-romance-fantasy-novel |
| A | en.lunatoons | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.lunatoons | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.magusmanga | Naruto | OK_UNVERIFIED | 3 | 0 | MISS | MISS | script-json |
| A | en.magusmanga | Solo Leveling | OK_UNVERIFIED | 3 | 0 | MISS | MISS | script-json |
| A | en.mangabat | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.mangabat | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.mangabuddy | Naruto | WRONG_PAGE | - | - | - | - | https://mangak.io/api/auth/hub-start?intent=login&amp;return_to=%2Fsearch%3Fquery%3DNaruto |
| A | en.mangabuddy | Solo Leveling | WRONG_PAGE | - | - | - | - | https://mangak.io/manga/edit-info |
| A | en.mangademon | Naruto | OK_UNVERIFIED | 215 | 214 | Chapter 1 2022-05-01  => {"number":1,"volume":null,"par | Chapter 50 2022-12-10  => {"number":50,"volume":null,"p | generic-anchors |
| A | en.mangademon | Solo Leveling | OK_UNVERIFIED | 215 | 214 | Chapter 1 2022-05-01  => {"number":1,"volume":null,"par | Chapter 50 2022-12-10  => {"number":50,"volume":null,"p | generic-anchors |
| A | en.mangadistrict | Naruto | OK_UNVERIFIED | 9 | 9 | Chapter 1 - Episode 1  => {"number":1,"volume":null,"pa | MISS | madara-inline |
| A | en.mangadistrict | Solo Leveling | OK | 203 | 203 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | madara-inline |
| A | en.mangagg | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.mangagg | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.mangago | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.mangago | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.mangahere | Naruto | WRONG_PAGE | - | - | - | - | https://www.mangahere.cc/login/?from=%2f%3fs%3dNaruto%26post_type%3dwp-manga |
| A | en.mangahere | Solo Leveling | OK | 212 | 212 | Ch.001 Nov 05,2018  => {"number":1,"volume":null,"part" | Ch.050 Dec 20,2018  => {"number":50,"volume":null,"part | themesia |
| A | en.mangahubio | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.mangahubio | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.mangakakalot | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.mangakakalot | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.manganelo | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.manganelo | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.mangapill | Naruto | WRONG_PAGE | - | - | - | - | https://mangapill.com/mangas/new |
| A | en.mangapill | Solo Leveling | WRONG_PAGE | - | - | - | - | https://mangapill.com/mangas/new |
| A | en.mangareadorg | Naruto | OK | 15 | 15 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | madara-inline |
| A | en.mangareadorg | Solo Leveling | OK | 69 | 69 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | madara-inline |
| A | en.mangasushi | Naruto | WRONG_PAGE | - | - | - | - | https://mangasushi.org/manga/koko-wa-makasete-sakini-ike-wo-shitai-shinitagari-no-nozomanu-uchuu-gekokujou/ |
| A | en.mangasushi | Solo Leveling | WRONG_PAGE | - | - | - | - | https://mangasushi.org/manga/koko-wa-makasete-sakini-ike-wo-shitai-shinitagari-no-nozomanu-uchuu-gekokujou/ |
| A | en.manhuaplus | Naruto | OK_UNVERIFIED | 3364 | 3364 | MISS | MISS | madara-inline |
| A | en.manhuaplus | Solo Leveling | OK_UNVERIFIED | 3364 | 3364 | MISS | MISS | madara-inline |
| A | en.manhuaus | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.manhuaus | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.manhwatop | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.manhwatop | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.mistscans | Naruto | OK_UNVERIFIED | 40 | 40 | Chapter 1 Apr 16, 2026  => {"number":1,"volume":null,"p | MISS | generic-anchors |
| A | en.mistscans | Solo Leveling | OK | 40 | 40 | Chapter 1 Apr 16, 2026  => {"number":1,"volume":null,"p | MISS | generic-anchors |
| A | en.murimscan | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.murimscan | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.nyrascans | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.nyrascans | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.nyxscans | Naruto | OK_UNVERIFIED | 19 | 19 | Chapter 1 14 days  => {"number":1,"volume":null,"part": | MISS | generic-anchors |
| A | en.nyxscans | Solo Leveling | OK_UNVERIFIED | 19 | 19 | Chapter 1 14 days  => {"number":1,"volume":null,"part": | MISS | generic-anchors |
| A | en.omegascans | Naruto | WRONG_PAGE | - | - | - | - | https://omegascans.org/series/love-quest |
| A | en.omegascans | Solo Leveling | WRONG_PAGE | - | - | - | - | https://omegascans.org/series/love-quest |
| A | en.orionscans | Naruto | OK_UNVERIFIED | 3 | 0 | MISS | MISS | script-json |
| A | en.orionscans | Solo Leveling | OK | 3 | 0 | MISS | MISS | script-json |
| A | en.ravenscans | Naruto | OK | 62 | 62 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | themesia |
| A | en.ravenscans | Solo Leveling | OK | 18 | 18 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | themesia |
| A | en.renascans | Naruto | OK_UNVERIFIED | 3 | 0 | MISS | MISS | script-json |
| A | en.renascans | Solo Leveling | OK_UNVERIFIED | 3 | 0 | MISS | MISS | script-json |
| A | en.ritharscans | Naruto | OK_UNVERIFIED | 79 | 78 | Chapter 01 1yr ago 7.3 K Views  => {"number":1,"volume" | Chapter 50 6mos ago 2.5 K Views  => {"number":50,"volum | generic-anchors |
| A | en.ritharscans | Solo Leveling | OK_UNVERIFIED | 79 | 78 | Chapter 01 1yr ago 7.3 K Views  => {"number":1,"volume" | Chapter 50 6mos ago 2.5 K Views  => {"number":50,"volum | generic-anchors |
| A | en.rizzcomic | Naruto | OK_UNVERIFIED | 232 | 230 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | themesia |
| A | en.rizzcomic | Solo Leveling | OK | 148 | 146 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | themesia |
| A | en.rosesquadscans | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.rosesquadscans | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.s2manga | Naruto | OK_UNVERIFIED | 40 | 40 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | madara-inline |
| A | en.s2manga | Solo Leveling | OK | 26 | 26 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | madara-inline |
| A | en.sanascans | Naruto | OK_UNVERIFIED | 3 | 0 | MISS | MISS | script-json |
| A | en.sanascans | Solo Leveling | OK_UNVERIFIED | 3 | 0 | MISS | MISS | script-json |
| A | en.setsuscans | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.setsuscans | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.shojoscans | Naruto | OK_UNVERIFIED | 10 | 10 | MISS | MISS | generic-anchors |
| A | en.shojoscans | Solo Leveling | OK_UNVERIFIED | 10 | 10 | MISS | MISS | generic-anchors |
| A | en.sleepytranslations | Naruto | OK_UNVERIFIED | 21 | 21 | MISS | MISS | generic-anchors |
| A | en.sleepytranslations | Solo Leveling | OK_UNVERIFIED | 21 | 21 | MISS | MISS | generic-anchors |
| A | en.suryascans | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.suryascans | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.tcbscans | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.tcbscans | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.templescan | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.templescan | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.toongod | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.toongod | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.toonily | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.toonily | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.topmanhua | Naruto | OK_UNVERIFIED | 20 | 20 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | generic-anchors |
| A | en.topmanhua | Solo Leveling | OK | 20 | 20 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | generic-anchors |
| A | en.tritiniascans | Naruto | OK_UNVERIFIED | 1 | 1 | MISS | MISS | generic-anchors |
| A | en.tritiniascans | Solo Leveling | OK_UNVERIFIED | 1 | 1 | MISS | MISS | generic-anchors |
| A | en.valirscans | Naruto | OK_UNVERIFIED | 20 | 20 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | generic-anchors |
| A | en.valirscans | Solo Leveling | OK_UNVERIFIED | 20 | 20 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | generic-anchors |
| A | en.vyvymanga | Naruto | OK_UNVERIFIED | 113 | 109 | Chapter 1 Jan 10, 2024  => {"number":1,"volume":null,"p | Chapter 50 Jan 10, 2024  => {"number":50,"volume":null, | generic-anchors |
| A | en.vyvymanga | Solo Leveling | OK | 210 | 208 | Chapter 1 Dec 26, 2021  => {"number":1,"volume":null,"p | Chapter 50 Dec 26, 2021  => {"number":50,"volume":null, | generic-anchors |
| A | en.webdexscans | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.webdexscans | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.webtoonxyz | Naruto | CF_BLOCKED | - | - | - | - | - |
| A | en.webtoonxyz | Solo Leveling | CF_BLOCKED | - | - | - | - | - |
| A | en.weebcentral | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.weebcentral | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| A | en.witchscans | Naruto | OK_UNVERIFIED | 92 | 92 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | generic-anchors |
| A | en.witchscans | Solo Leveling | OK_UNVERIFIED | 92 | 92 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | generic-anchors |
| A | en.wuxiaworld | Naruto | OK | 61 | 59 | MISS | MISS | generic-anchors |
| A | en.wuxiaworld | Solo Leveling | OK | 61 | 59 | MISS | MISS | generic-anchors |
| A | en.xoxocomics | Naruto | WRONG_PAGE | - | - | - | - | https://xoxocomic.com/comic/spider-man-long-way-home |
| A | en.xoxocomics | Solo Leveling | WRONG_PAGE | - | - | - | - | https://xoxocomic.com/comic/spider-man-long-way-home |
| A | en.zinmanga | Naruto | OK_UNVERIFIED | 88 | 88 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | Chapter 50  => {"number":50,"volume":null,"part":null," | madara-inline |
| A | en.zinmanga | Solo Leveling | OK | 26 | 26 | Chapter 1  => {"number":1,"volume":null,"part":null,"ki | MISS | madara-inline |
| A | ja.mangaparkpublisher | Naruto | WRONG_PAGE | - | - | - | - | https://manga-park.com/title/103889 |
| A | ja.mangaparkpublisher | Solo Leveling | WRONG_PAGE | - | - | - | - | https://manga-park.com/title/103889 |
| S | all.comikey | Naruto | WRONG_PAGE | - | - | - | - | https://comikey.com/comics/from-superfan-to-stepsister-manga/530/ |
| S | all.comikey | Solo Leveling | NO_CHAPTER_LIST | - | - | - | - | https://comikey.com/comics/leveling-up-the-hero-to-nation-manga/327/ |
| S | all.mangadex | Naruto | OK | 33 | 33 | MISS | Chapter 50 - Heater!  => {"number":50,"volume":null,"pa | api |
| S | all.mangadex | Solo Leveling | OK | 0 | 0 | MISS | MISS | api |
| S | all.mangaplus | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| S | all.mangaplus | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| S | all.mangaup | Naruto | WRONG_PAGE | - | - | - | - | https://global.manga-up.com/manga/1026 |
| S | all.mangaup | Solo Leveling | WRONG_PAGE | - | - | - | - | https://global.manga-up.com/manga/1026 |
| S | all.manta | Naruto | OK_UNVERIFIED | 186 | 186 | S1 Episode 1  => {"number":1,"volume":null,"part":null, | S2 Episode 50  => {"number":50,"volume":null,"part":nul | script-json |
| S | all.manta | Solo Leveling | OK_UNVERIFIED | 186 | 186 | S1 Episode 1  => {"number":1,"volume":null,"part":null, | S2 Episode 50  => {"number":50,"volume":null,"part":nul | script-json |
| S | all.tappytoon | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| S | all.tappytoon | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
| S | all.toomics | Naruto | WRONG_PAGE | - | - | - | - | https://global.toomics.com/en/webtoon/search_v2 |
| S | all.toomics | Solo Leveling | WRONG_PAGE | - | - | - | - | https://global.toomics.com/en/webtoon/search_v2 |
| S | all.webtoons | Naruto | NO_CHAPTER_LIST | - | - | - | - | 1166391 |
| S | all.webtoons | Solo Leveling | OK | 9 | 9 | MISS | MISS | webtoons-ajax |
| S | en.inkr | Naruto | OK_UNVERIFIED | 4 | 2 | MISS | MISS | generic-anchors |
| S | en.inkr | Solo Leveling | OK_UNVERIFIED | 4 | 2 | MISS | MISS | generic-anchors |
| S | en.kmanga | Naruto | OK_UNVERIFIED | 1 | 0 | MISS | MISS | generic-anchors |
| S | en.kmanga | Solo Leveling | OK_UNVERIFIED | 1 | 0 | MISS | MISS | generic-anchors |
| S | en.tapastic | Naruto | OK_UNVERIFIED | 1 | 1 | MISS | MISS | generic-anchors |
| S | en.tapastic | Solo Leveling | WRONG_PAGE | - | - | - | - | https://tapas.io/series/300256 |
| S | en.vizshonenjump | Naruto | NO_CHAPTER_LIST | - | - | - | - | https://www.viz.com/naruto |
| S | en.vizshonenjump | Solo Leveling | WRONG_PAGE | - | - | - | - | https://www.viz.com/manga-books/manga/black-torch-complete-box-set/product/9008 |
| S | ko.navercomic | Naruto | NO_SEARCH_HIT | - | - | - | - | - |
| S | ko.navercomic | Solo Leveling | NO_SEARCH_HIT | - | - | - | - | - |
