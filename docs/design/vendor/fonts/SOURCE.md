# Bundled fonts

Fonts served by briefstack's own server from `src/ui/static/fonts/`
(BRIEF-ui §5, `docs/decisions.md` "U1b: bundled fonts" and "U2"). Nothing is
loaded from the internet.

- **Source:** the Fontsource variable packages on npm,
  `@fontsource-variable/<name>@5.3.0`, published 2026-07-19, taken with
  `npm pack` on 2026-10-21. Only the Latin subset's variable woff2 and the
  package's `LICENSE` were copied; the files are unchanged.
- **License:** SIL Open Font License 1.1 for every family but Roboto Slab
  (below). Each folder here holds the package's `LICENSE` file.
- U1b bundled seven families for three variants; U2 kept the chosen
  variant's two and deleted the others. They stay while screens still use
  direction A (`.legacy`).
- U5 added the three families of the design in `docs/diseno/`, from
  Fontsource 5.3.0 (published 2026-07-19), taken with `npm pack` on
  2026-10-22. Latin subset, files unchanged; declared in
  `src/ui/static/fonts.css`. Inter and Roboto Slab are variable files; IBM
  Plex Mono has one file per weight bs.css uses (400, 500).
- **Roboto Slab is Apache License 2.0, not OFL** (upstream it sits under
  `apache/robotoslab` in google/fonts). BRIEF-ui §5 asks for OFL fonts; the
  user approved this exception on 2026-10-22 (`docs/decisions.md`, "U5").
  Its folder holds the Apache 2.0 `LICENSE` from the package.

| Family | Package | File | Axes in the file | Upstream | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Bricolage Grotesque | `@fontsource-variable/bricolage-grotesque@5.3.0` | `bricolage-grotesque-latin-opsz-normal.woff2` | wght 200–800, opsz | https://github.com/ateliertriay/bricolage | `a79fdb52d4a5c76552452f69202add96e287401fff03d3e8c0e38b4dcb5a99cd` |
| JetBrains Mono | `@fontsource-variable/jetbrains-mono@5.3.0` | `jetbrains-mono-latin-wght-normal.woff2` | wght 100–800 | https://github.com/JetBrains/JetBrainsMono | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |
| Inter (U5) | `@fontsource-variable/inter@5.3.0` | `inter-latin-wght-normal.woff2` | wght 100–900 | https://github.com/rsms/inter | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| Roboto Slab (U5, Apache 2.0) | `@fontsource-variable/roboto-slab@5.3.0` | `roboto-slab-latin-wght-normal.woff2` | wght 100–900 | https://github.com/googlefonts/robotoslab | `50cf7d32c18e1001749b51f1565ef745bc0687b0297b2b13465ed577cc20a8ff` |
| IBM Plex Mono (U5) | `@fontsource/ibm-plex-mono@5.3.0` | `ibm-plex-mono-latin-400-normal.woff2` | 400 | https://github.com/IBM/plex | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| IBM Plex Mono (U5) | `@fontsource/ibm-plex-mono@5.3.0` | `ibm-plex-mono-latin-500-normal.woff2` | 500 | https://github.com/IBM/plex | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |
