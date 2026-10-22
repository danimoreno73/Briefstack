# briefstack · diseño para implementar

Guía para implementar la interfaz en Preact con CSS puro. Fuente visual: el lienzo de diseño "briefstack" (dirección de la propuesta, con correcciones de accesibilidad y las pantallas que faltaban).

## Qué hay en esta carpeta

| Archivo | Qué es |
|---|---|
| `bs.css` | Tokens (custom properties) y todos los componentes. Es CSS real: cópialo a `src/styles/` tal cual. |
| `pantallas/*.dc.html` | Marcado de referencia de cada pantalla. Ver «Cómo leer las pantallas». |
| `LEEME.md` | Esta guía. |

## Cómo leer las pantallas

Los `.dc.html` son el formato del lienzo. El marcado dentro de `<x-dc>` es HTML válido con las clases de `bs.css`: es lo que hay que portar a componentes Preact. Ignora:

- `<script src="./support.js">`, `<x-dc>`, `<helmet>` y el `<script type="text/x-dc">` del final: son del lienzo.
- `{{algo}}`: datos de ejemplo. Pásalos a props o estado.
- `<sc-if>` y `<sc-for>`: condicionales y bucles. En Preact son `{cond && …}` y `.map()`.
- `<dc-import name="X" prop="…">`: la pantalla X con esas props. Los archivos `m-*.dc.html` (390 px) y `v-*.dc.html` (variantes) solo reutilizan otra pantalla, no tienen marcado propio.

## Fuentes (OFL, incluidas en la app)

Descarga los `.woff2` y ponlos en `public/fonts/`. No cargues nada de internet.

- Roboto Slab: 500 y 700 (títulos)
- Inter: 400, 500 y 600 (texto y acciones)
- IBM Plex Mono: 400 y 500 (rutas, ids, agentes, modelos, cifras)

```css
@font-face { font-family: "Roboto Slab"; src: url("/fonts/RobotoSlab-Bold.woff2") format("woff2"); font-weight: 700; font-display: swap; }
/* … una regla por familia y peso … */
```

## Temas

- La raíz es `<html class="bs" data-theme="dark">`. Oscuro por defecto.
- `data-theme="light"` cambia todos los tokens. «Como el sistema» = leer `prefers-color-scheme` y poner el atributo.
- En claro, el panel de decisión se invierte: tinta con texto crema. Ya está resuelto en los tokens `--dec*`; no hay que tocar nada en los componentes.
- Cualquier bloque puede forzar su tema con `data-theme` (se usa en el lienzo para comparar).

## Las cuatro reglas de jerarquía

1. Crema (`.dec`, `.chip-dec`, `.badge-dec`) solo para lo que espera una respuesta del usuario: preguntas, spec, permisos, carpetas, respuesta libre, confirmaciones del chat y «Tu decisión» de una mejora. Si no espera nada, no es crema.
2. Verde (acento) = en marcha, válido, primario.
3. Ámbar = aviso informativo. Nunca para estados de agentes.
4. Coral = error, peligro, seguridad. El aviso de seguridad usa `.note-danger.note-sec` y va antes de la decisión.

Los estados nunca dependen solo del color: siempre llevan palabra, punto, anillo, ✓ o ✕.

## Componentes → clases

| Componente | Clases |
|---|---|
| Estructura | `.app` > `.rail` + `.main` > `.topbar` (solo móvil) + `.page-head` + `.page` |
| Botones | `.btn` + `.btn-primary` / `-secondary` / `-ghost` / `-danger` / `-danger-quiet`, `.btn-sm`, `.btn-icon`, `.btn-block` |
| Campos | `.field` > `.label` + `.input` / `.textarea` (+ `.input-mono`) + `.help` / `.msg.msg-ok` / `.msg.msg-err`; error: `.field-error` |
| Opciones de pregunta | `.dec-card` (fieldset) > `.opts` > `label.opt` con `input.sr-only[type=radio]` y `svg.tick` |
| Opciones en tarjeta | `.choice` > `label` con radio `.sr-only` (política de permisos) · `.tiers` > `label.tier` (perfiles de uso) |
| Segmentado | `.seg` > `button[aria-pressed]` · número: `.steps-pick` |
| Chips | `.chip` + `-ok` / `-dec` / `-warn` / `-danger` / `-outline` / `-mono`; contador: `.badge` |
| Estados | `.state` + `.st-run` / `.st-wait` / `.st-done` / `.st-fail` / `.st-cancel`; `.dot.pulse`, `.ring` |
| Tarjeta | `.card`, `.card-flush` > `.card-head`, `.card-dash` |
| Decisión | `section.dec` > `.dec-head` > `.dec-title` (`.dec-icon` + h2 + `.meta`); compacta: `.dec.dec-sm` |
| Avisos | `.note` + `-warn` / `-danger` / `-ok`; seguridad: `.note-danger.note-sec` |
| Tabla | `.table-card` > `table.table`, `.td-name`, `.td-mono`, `.td-num` |
| Diálogo | `.scrim` > `.dialog[role=dialog]` |
| Diff | `.diff` > `.diff-file` + `.diff-lines` > `.dl` (+ `.dl-add` / `.dl-del` / `.dl-hunk`) |
| Progreso | `.progress` > `.segs` > `.seg-step` (+ `.done` / `.now`) · 9 pasos |
| Uso | `.use-row` > `.use-head` + `.meter` (`.m-now`, `.m-start`, `.m-mark`) |
| Agentes | `.nodes` > `button.node` (+ `.node-child`, `[aria-expanded]`) · `.tl` > `button.tl-row` > `.tl-track` > `.bar-*` + `.bar-now` · `.detail` > `.kv` + `.log` · alternativa: `ol.textview` |
| Chat | `.chat` > `.chat-list` + `.chat-main` > `.thread` > `.bubble-user` / `.bubble-bot` (+ `.cite`), `.thinking`, `.composer` · cajón: `.drawer-host` > `.drawer-scrim` + `aside.drawer` |
| Biblioteca | `.lib` > `.lib-tree` (`.tree-item`) + `.lib-main` > `.editor` (`.md-editor` + `.md-preview`) + `.commits` |
| Vacío y carga | `.empty`, `.loader` |

## Pantallas

| Pantalla | Archivo | Variantes |
|---|---|---|
| Sistema de diseño | `Main.dc.html` | — |
| Componentes | `Componentes.dc.html` | — |
| Proyectos | `Proyectos.dc.html` | claro: `v-Proyectos-claro` |
| Detalle de proyecto | `Proyecto-detalle.dc.html` (prop `destino`) | claude-app: `v-Detalle-app` |
| Proyecto nuevo | `Proyecto-nuevo.dc.html` (prop `estado`) | límite: `v-Nuevo-limite` |
| Creación · pregunta | `Creacion-pregunta.dc.html` | claro: `Pregunta-claro` · 390: `m-Pregunta` |
| Creación · spec | `Creacion-aprobar-spec.dc.html` | 390: `m-Spec` |
| Creación · permiso y carpeta | `Creacion-permisos.dc.html` | 390: `m-Permisos` |
| Creación · trabajando | `Creacion-en-marcha.dc.html` (prop `view`) | 390: `m-Marcha` |
| Creación · resultado | `Creacion-entrega.dc.html` | 390: `m-Entrega` |
| Creaciones | `Creaciones.dc.html` | — |
| Biblioteca | `Biblioteca.dc.html` | — |
| Mejoras | `Mejoras.dc.html` | — |
| Propuesta de mejora | `Mejora-propuesta.dc.html` | 390: `m-Propuesta` |
| Chat | `Chat.dc.html` (prop `modo`) | anterior: `v-Chat-anterior` · 390: `m-Chat` · cajón: `Chat-cajon` |
| Uso | `Uso.dc.html` | — |
| Ajustes | `Ajustes.dc.html` | — |
| Estados globales | `Estados.dc.html` | — |

La respuesta libre (estado e) está en `Componentes.dc.html`.

## Comportamiento que no se ve en una imagen

- **Pantalla de creación:** la cabecera (`.page-head.sticky`) queda fija, con el estado y «Cancelar creación». Cancelar abre el diálogo de confirmación y el foco entra en «Seguir creando».
- **Te espera:** cuando aparece, el foco no salta solo. Anúncialo con una región `aria-live="polite"` («Te esperan 3 preguntas») y añade un enlace «Ir a lo que te espera» al principio de la página.
- **Árbol de agentes:** cada `.node` y cada `.tl-row` es un `button`. Al pulsarlo se abre `.detail` y se marca con `aria-expanded` / `aria-pressed`. La vista Texto (`ol.textview`, `aria-live="polite"`) anuncia los cambios de estado, no cada llamada.
- **Chat:** Ctrl J abre el cajón desde cualquier pantalla y Esc lo cierra. El foco queda atrapado en el cajón y vuelve al botón que lo abrió. Ctrl Enter envía. Las tarjetas de confirmación se quedan en el hilo como «Confirmada» o «Rechazada».
- **Biblioteca:** al guardar con un secreto se bloquea el guardado, aparece `.note-danger` con `role="alert"` y el editor lleva `aria-invalid`. Revertir pide confirmación en línea, en crema.
- **Ajustes:** el aviso de la carpeta («se creará al guardar») sale solo si no existe. El aviso del límite sale solo por encima de 3.
- **briefstack se reinició:** bloquea la pantalla con `role="alertdialog"`. No hay botón: el token nuevo solo está en la terminal.
- **Reducir movimiento:** ya está en `bs.css` (todo a 0 ms). El punto de «en marcha» queda fijo y el estado sigue escrito.

## Móvil (≤ 720 px)

Ya está en `bs.css`: el rail se oculta y aparece `.topbar`, la cabecera fija baja a 67 px, las columnas se apilan, la lista de conversaciones del chat se oculta (se abre desde la barra superior) y los segmentos de progreso solo muestran el paso actual.

## Accesibilidad comprobada

- Contraste AA en los dos temas. Texto tenue: 5,1:1 en oscuro y 4,6:1 en claro. Bordes de control ≥ 3:1.
- Foco: 2 px de acento separado 2 px; dentro del crema, 2 px de tinta.
- Controles reales (`button`, `a`, `input`, `label`), radios ocultos con `.sr-only` pero enfocables, y `aria-label` en los botones de solo icono.
- Objetivos táctiles: 42 px en escritorio y 44 px o más en móvil.
