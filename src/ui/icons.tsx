import type { ComponentChildren } from 'preact';

/**
 * The line icons of the design (docs/diseno). Decorative: each one is hidden
 * from assistive technology, so the text or `aria-label` beside it names the
 * action.
 */

function Svg({ children, width = 1.6, cls }: { children: ComponentChildren; width?: number; cls?: string }) {
  return (
    <svg
      class={cls}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      stroke-width={width}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconProjects = () => (
  <Svg>
    <path d="M2.5 5.5h5l1.5 1.5h8.5v8.5h-15z" />
  </Svg>
);

export const IconNew = () => (
  <Svg>
    <path d="M10 4v12M4 10h12" />
  </Svg>
);

export const IconCreations = () => (
  <Svg>
    <path d="M10 3l7 3.5-7 3.5-7-3.5z" />
    <path d="M3 10l7 3.5 7-3.5M3 13.5L10 17l7-3.5" />
  </Svg>
);

export const IconLibrary = () => (
  <Svg>
    <path d="M10 5.5C8 4 5 4 3 4.5v11c2-.5 5-.5 7 1 2-1.5 5-1.5 7-1v-11c-2-.5-5-.5-7 1zM10 5.5v11" />
  </Svg>
);

export const IconSkills = () => (
  <Svg>
    <path d="M10 2.8l6.2 3.6v7.2L10 17.2l-6.2-3.6V6.4zM3.8 6.4L10 10l6.2-3.6M10 10v7.2" />
  </Svg>
);

export const IconImprove = () => (
  <Svg>
    <path d="M8 3l1.2 3.3L12.5 7.5 9.2 8.7 8 12 6.8 8.7 3.5 7.5l3.3-1.2zM14.5 11l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
  </Svg>
);

export const IconChat = () => (
  <Svg>
    <path d="M3.5 4h13v9.5H8L4.5 16v-2.5h-1z" />
  </Svg>
);

export const IconUsage = () => (
  <Svg>
    <path d="M3.5 14a6.5 6.5 0 1 1 13 0" />
    <path d="M10 14l3-4" />
  </Svg>
);

export const IconSettings = () => (
  <Svg>
    <circle cx="10" cy="10" r="2.5" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </Svg>
);

export const IconMoon = () => (
  <Svg>
    <path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" />
  </Svg>
);

/** Up and down: a button that opens a list of choices. */
export const IconSelector = () => (
  <Svg>
    <path d="M7 8l3-3 3 3M7 12l3 3 3-3" />
  </Svg>
);

export const IconGlobe = () => (
  <Svg>
    <circle cx="10" cy="10" r="7" />
    <path d="M3 10h14M10 3c2 2 2.8 4.5 2.8 7s-.8 5-2.8 7c-2-2-2.8-4.5-2.8-7S8 5 10 3z" />
  </Svg>
);

export const IconMenu = () => (
  <Svg width={1.75}>
    <path d="M3 6h14M3 10h14M3 14h14" />
  </Svg>
);

export const IconClose = () => (
  <Svg width={1.75}>
    <path d="M5 5l10 10M15 5L5 15" />
  </Svg>
);

/** A question in a speech bubble: what the flow asks. */
export const IconQuestion = () => (
  <Svg width={1.75}>
    <path d="M3.5 4h13v9.5H8L4.5 16v-2.5h-1z" />
    <path d="M8.3 7.3a1.8 1.8 0 1 1 2.2 1.8c-.4.1-.5.4-.5.8M10 11.2v.01" />
  </Svg>
);

/** A document with lines: the spec. */
export const IconSpec = () => (
  <Svg width={1.75}>
    <path d="M5 2.5h7l3 3v12H5z" />
    <path d="M12 2.5v3h3M7.5 9.5h5M7.5 12.5h5" />
  </Svg>
);

/** A terminal prompt: a command to allow. */
export const IconTerminal = () => (
  <Svg width={1.75}>
    <path d="M2.5 4h15v12h-15z" />
    <path d="M5.5 8l2.5 2-2.5 2M10 12.5h4" />
  </Svg>
);

/** A folder with a key: access to a folder. */
export const IconFolder = () => (
  <Svg width={1.75}>
    <path d="M2.5 5.5h5l1.5 1.5h8.5v8.5h-15z" />
  </Svg>
);

/** A reply arrow: the session waits for a free-text answer. */
export const IconReply = () => (
  <Svg width={1.75}>
    <path d="M8 5L3.5 9.5 8 14" />
    <path d="M3.5 9.5H12a4.5 4.5 0 0 1 4.5 4.5v1" />
  </Svg>
);

export const IconCheck = ({ cls }: { cls?: string }) => (
  <svg class={cls} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);

export const IconCross = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export const IconCopy = () => (
  <Svg>
    <path d="M7 7h9.5v9.5H7z" />
    <path d="M13 7V3.5H3.5V13H7" />
  </Svg>
);

/** A circle with an i: information or a warning. */
export const IconInfo = () => (
  <Svg>
    <circle cx="10" cy="10" r="7.5" />
    <path d="M10 9v4.5M10 6.5v.01" />
  </Svg>
);

/** A triangle with an exclamation mark: an error or danger. */
export const IconAlert = () => (
  <Svg>
    <path d="M10 3l7.5 13.5h-15z" />
    <path d="M10 8.5v3.5M10 14.2v.01" />
  </Svg>
);
