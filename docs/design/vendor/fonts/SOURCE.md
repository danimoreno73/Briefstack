# Bundled fonts

Fonts served by briefstack's own server from `src/ui/static/fonts/`
(BRIEF-ui §5, `docs/decisions.md` "U1b: bundled fonts" and "U2"). Nothing is
loaded from the internet.

- **Source:** the Fontsource variable packages on npm,
  `@fontsource-variable/<name>@5.3.0`, published 2026-07-19, taken with
  `npm pack` on 2026-10-21. Only the Latin subset's variable woff2 and the
  package's `LICENSE` were copied; the files are unchanged.
- **License:** SIL Open Font License 1.1 for both families. Each folder here
  holds the package's `LICENSE` file.
- U1b bundled seven families for three variants; U2 kept the chosen
  variant's two and deleted the others.

| Family | Package | File | Axes in the file | Upstream | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| Bricolage Grotesque | `@fontsource-variable/bricolage-grotesque@5.3.0` | `bricolage-grotesque-latin-opsz-normal.woff2` | wght 200–800, opsz | https://github.com/ateliertriay/bricolage | `a79fdb52d4a5c76552452f69202add96e287401fff03d3e8c0e38b4dcb5a99cd` |
| JetBrains Mono | `@fontsource-variable/jetbrains-mono@5.3.0` | `jetbrains-mono-latin-wght-normal.woff2` | wght 100–800 | https://github.com/JetBrains/JetBrainsMono | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |
