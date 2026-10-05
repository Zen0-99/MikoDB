# Filler-source fixture corpus (Wave 0)

Offline fixtures exercising the filler merge (`--filler-dir scripts/testdata/filler`)
without touching animefillerlist.com or the AniFiller repo.

## Layout

| Path | Shape | What it exercises |
|---|---|---|
| `afl/index.html` | animefillerlist `/shows` index (`div.Group ul li a`) | AFL index parse; only `cowboy-bebop` has a matching show page — `naruto`/`one-piece` links exist to prove unresolvable slugs are skipped |
| `afl/cowboy-bebop.html` | AFL show page (`tr.filler` / `tr.mixed_canon filler` / `td.Number`) | filler + mixed-flag row extraction → eps {9, 10, 11} |
| `anifiller/cowboy-bebop.json` | AniFiller `data/shows/{slug}.json` | ID-exact join by `mappings.anilist_id`/`mal_id`; diverges from AFL ({9,11} vs {9,10,11}) → `filler_drift` entry; AFL wins the actual flags |
| `anifiller/shingeki-no-kyojin.json` | AniFiller JSON, no AFL coverage | Secondary-source path: flags anidb:9541 eps {16, 22} because AFL has no fixture page for it |

Expected results on the fixture build: Bebop (anidb 23) mains 9/10/11
`filler=1`, AoT (anidb 9541) mains 16/22 `filler=1`, `filler_shows=2`, one
`filler_drift` entry for cowboy-bebop (`afl_only:[10]`).
