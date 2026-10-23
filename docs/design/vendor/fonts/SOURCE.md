# Bundled fonts

Fonts served by briefstack's own server from `src/ui/static/fonts/` and
declared in `src/ui/static/fonts.css` (BRIEF-ui §5; `docs/decisions.md`,
"U5"). They are the three families of the design in `docs/diseno/`.
Nothing is loaded from the internet.

- **Source:** the Fontsource packages on npm, version 5.3.0 (published
  2026-07-19), taken with `npm pack` on 2026-10-22. Only the Latin subset's
  woff2 files and each package's `LICENSE` were copied; the files are
  unchanged. Inter and Roboto Slab are variable files; IBM Plex Mono has one
  file per weight bs.css uses (400, 500).
- **License:** SIL Open Font License 1.1 for Inter and IBM Plex Mono.
  **Roboto Slab is Apache License 2.0, not OFL** (upstream it sits under
  `apache/robotoslab` in google/fonts). BRIEF-ui §5 asks for OFL fonts; the
  user approved this exception on 2026-10-22. Each folder here holds the
  package's `LICENSE` file.
- **History:** U1b bundled seven families for three type variants; U2 kept
  Bricolage Grotesque and JetBrains Mono for direction A; U5 replaced them
  with these three and, once no screen used direction A, deleted them and
  their licenses.

| Family | Package | File | Axes or weight | Upstream | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Inter | `@fontsource-variable/inter@5.3.0` | `inter-latin-wght-normal.woff2` | wght 100–900 | https://github.com/rsms/inter | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| Roboto Slab (Apache 2.0) | `@fontsource-variable/roboto-slab@5.3.0` | `roboto-slab-latin-wght-normal.woff2` | wght 100–900 | https://github.com/googlefonts/robotoslab | `50cf7d32c18e1001749b51f1565ef745bc0687b0297b2b13465ed577cc20a8ff` |
| IBM Plex Mono | `@fontsource/ibm-plex-mono@5.3.0` | `ibm-plex-mono-latin-400-normal.woff2` | 400 | https://github.com/IBM/plex | `08949f728dc52d528e69b1667d15c89a5686a4ee9a296ff90983985f99c380f7` |
| IBM Plex Mono | `@fontsource/ibm-plex-mono@5.3.0` | `ibm-plex-mono-latin-500-normal.woff2` | 500 | https://github.com/IBM/plex | `01d285447409c8a588692162439a038b8cbd7871309ee20267b0d2d91c6e8e22` |
