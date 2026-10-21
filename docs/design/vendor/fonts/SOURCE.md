# Bundled fonts

Fonts served by briefstack's own server from `src/ui/static/fonts/`
(BRIEF-ui §5, `docs/decisions.md` "U1b: bundled fonts"). Nothing is loaded
from the internet.

- **Source:** the Fontsource variable packages on npm,
  `@fontsource-variable/<name>@5.3.0`, published 2026-07-19, taken with
  `npm pack` on 2026-10-21. Only the Latin subset's variable woff2 and the
  package's `LICENSE` were copied; the files are unchanged.
- **License:** SIL Open Font License 1.1 for every family. Each folder here
  holds the package's `LICENSE` file. For Source Sans 3 and Source Code Pro
  the package's copyright line reads "Google Inc."; the fonts are by Adobe
  (https://github.com/adobe-fonts), under the same OFL 1.1.
- **During U1b** three variants of direction A are bundled; U2 keeps the
  chosen one and deletes the others, here and in `src/ui/static/fonts/`.

| Family | Package | File | Axes in the file | Upstream | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Source Sans 3 | `@fontsource-variable/source-sans-3@5.3.0` | `source-sans-3-latin-wght-normal.woff2` | wght 200–900 | https://github.com/adobe-fonts/source-sans | `7a19a7027e125257d310c6dbd78ae3a30b5ea1e3794d60b12bb28227a003bfda` |
| Source Code Pro | `@fontsource-variable/source-code-pro@5.3.0` | `source-code-pro-latin-wght-normal.woff2` | wght 200–900 | https://github.com/adobe-fonts/source-code-pro | `8b774aaa5137a38ef40f4ac9d36db9a5eee152b2f66589dfdc82ff007fc87135` |
| Bricolage Grotesque | `@fontsource-variable/bricolage-grotesque@5.3.0` | `bricolage-grotesque-latin-opsz-normal.woff2` | wght 200–800, opsz | https://github.com/ateliertriay/bricolage | `a79fdb52d4a5c76552452f69202add96e287401fff03d3e8c0e38b4dcb5a99cd` |
| JetBrains Mono | `@fontsource-variable/jetbrains-mono@5.3.0` | `jetbrains-mono-latin-wght-normal.woff2` | wght 100–800 | https://github.com/JetBrains/JetBrainsMono | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |
| Newsreader | `@fontsource-variable/newsreader@5.3.0` | `newsreader-latin-opsz-normal.woff2` | wght 200–800, opsz | https://github.com/productiontype/Newsreader | `6e4f2958c3a7c4a80acde4e5a679abe7e01bc1e30b92be3c7a8b696ef401d101` |
| Instrument Sans | `@fontsource-variable/instrument-sans@5.3.0` | `instrument-sans-latin-wght-normal.woff2` | wght 400–700 | https://github.com/Instrument/instrument-sans | `2ee17598a98d8a59e4df8152d015bec9ab8e4d5672cc0ab42bef806b568e3971` |
| Inconsolata | `@fontsource-variable/inconsolata@5.3.0` | `inconsolata-latin-wght-normal.woff2` | wght 200–900 | https://github.com/cyrealtype/Inconsolata | `4914e68b98699a8f3d5d552fe60fd7a1c2cb631a0f66f0a148392f161d3155ab` |
