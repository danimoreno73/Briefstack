import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useApp } from './hooks.js';
import { IconCheck, IconMoon, IconSelector } from './icons.js';
import { THEMES, applyTheme, readStoredTheme, type Theme } from './theme.js';

/**
 * System, light or dark; kept per browser. A menu button in the design's
 * style instead of a native select, whose list the system draws: the button
 * is the canvas's `btn-secondary btn-sm`, the list a small menu of radio
 * items. Keyboard: Enter, Space or the arrows open it on the current choice;
 * the arrows, Home and End move; Enter or Space choose; Escape closes; Tab
 * leaves it.
 */
export function ThemeSwitch() {
  const { t } = useApp();
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const choose = (value: Theme) => {
    setTheme(value);
    applyTheme(value, true);
    close();
  };

  // On opening, the focus goes to the current choice before the next key can arrive.
  useLayoutEffect(() => {
    if (open) items.current[Math.max(0, THEMES.indexOf(theme))]?.focus();
  }, [open]);

  // A press anywhere else closes it, without moving the focus.
  useEffect(() => {
    if (!open) return undefined;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const onMenuKey = (event: KeyboardEvent) => {
    const last = THEMES.length - 1;
    const at = Math.max(0, items.current.findIndex((item) => item === document.activeElement));
    const move: Record<string, number> = { ArrowDown: at === last ? 0 : at + 1, ArrowUp: at === 0 ? last : at - 1, Home: 0, End: last };
    const next = move[event.key];
    if (next !== undefined) {
      // Moved here, not in an effect, so a quick next key acts on the item it means.
      event.preventDefault();
      items.current[next]?.focus();
    } else if (event.key === 'Escape') {
      // Only the menu closes, not the phone's rail around it.
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  return (
    <div
      ref={root}
      class="theme-pick"
      onFocusOut={(event) => {
        // Tab, or a click elsewhere, takes the focus out: the menu closes.
        if (open && !(event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget) === true)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        class="btn btn-secondary btn-sm"
        aria-label={t.themeSwitch(theme)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="theme-menu"
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <IconMoon />
        <span class="theme-pick-name">{t.themeName(theme)}</span>
        <IconSelector />
      </button>
      {open && (
        <div class="menu" id="theme-menu" role="menu" aria-label={t.themeLabel} onKeyDown={onMenuKey}>
          {THEMES.map((value, index) => (
            <button
              key={value}
              ref={(element) => {
                items.current[index] = element;
              }}
              type="button"
              class="menu-item"
              role="menuitemradio"
              aria-checked={value === theme}
              tabIndex={-1}
              onClick={() => choose(value)}
            >
              <IconCheck cls="menu-check" />
              {t.themeName(value)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
