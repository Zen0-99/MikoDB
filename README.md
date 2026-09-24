# MikoDB

One-repo anime bundle for [Miko](https://github.com/Zen0-99/Miko): curated anime
extensions + a canonical anime identity mapping database.

## What you get by adding this repo

- **Curated anime extensions** — the viable subset of `yuzono/anime-repo`
  (dead/blocked sources excluded), with per-source binding metadata.
- **`miko-anime-map.db`** — identity bridge: imdb / mal / anilist / kitsu /
  anidb / tvdb / tmdb / trakt IDs, season+part attribution, episode ranges,
  and dub status. Updated weekly by GitHub Actions.

## Add to Miko

Settings → Extension repos → add:
```
https://raw.githubusercontent.com/Zen0-99/MikoDB/main
```

Miko fetches `index.min.json` (vanilla Aniyomi format) for extensions and the
`miko.json` sidecar for the DB pointer + binding metadata.

## Layout

| Path | Purpose |
|---|---|
| `index.min.json` | Vanilla extension index (any Aniyomi-compatible app can use it) |
| `miko.json` | Miko sidecar: `{db:{version,sha256,url}, sources:{pkg:{tier,idType,numbering}}}` |
| `apk/`, `icon/` | Mirrored extension binaries + icons |
| `curation.json` | Curated pkg list + binding metadata (edit this to add/remove sources) |
| `releases/tag/db-latest` | `miko-anime-map.db.gz` — rolling artifact |

## Data sources

[Otaku-Mappings](https://github.com/Goldenfreddy0703/Otaku-Mappings) (base merge),
[Fribb anime-lists](https://github.com/Fribb/anime-lists),
[anime-offline-database](https://github.com/manami-project/anime-offline-database),
[MAL-Dubs](https://github.com/MAL-Dubs/MAL-Dubs) (AGPL data).

## Rebuild

```bash
npm install
npm run build        # index + db
npm run build:index  # index only
npm run build:db     # db only
```
