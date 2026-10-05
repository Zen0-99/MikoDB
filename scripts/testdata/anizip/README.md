# ani.zip fixture corpus (Wave 0)

Real documents captured from `GET https://api.ani.zip/v1/episodes?anilist_id={id}`
(UA `MikoDB-Build/1.0`) for the build-side `anime_episodes` pipeline. Filenames are
`{mappings.anidb_id}.json` — the same convention as the live fetch cache in
`data/anizip/`.

| File | Source | Coverage exercised |
|---|---|---|
| `23.json` | `anilist_id=1` — Cowboy Bebop | Main + `S#` special keys; divergent aligned numbering (ep `"1"` → `episodeNumber:14`, `absoluteEpisodeNumber:4`); dual airdate fields |
| `9541.json` | `anilist_id=16498` — Attack on Titan | 25 mains + 15 specials; multi-thousand-episode-doc shape, non-ordered `episodes` map keys |
| `99999023.json` | **SYNTHETIC** — copy of `23.json` with hand-added `C1`/`C2`/`T1` keys | `C#`→`nc` and `T#`→`trailer` prefix typing. ani.zip `C#`/`T#` emission is unverified upstream, so coverage needs a synthetic key check. Sentinel `anidb_id` `99999023` (no anime row claims it); anilist/mal/thetvdb mappings nulled so it cannot alias the real Bebop. `_fixture_note` field marks the file as synthetic. |

Fixture mode: `node scripts/build-db.js --anizip-dir scripts/testdata/anizip`
reads docs from this directory instead of fetching from api.ani.zip.
