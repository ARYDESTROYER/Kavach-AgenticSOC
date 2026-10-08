/**
 * useAutoGrow — grow a textarea with its content up to a maximum, then scroll
 * (SPEC §10.4). Chromium and Safari size the field natively through
 * `field-sizing: content` (the composer sets that class); Firefox and older engines
 * get this JS fallback, which measures `scrollHeight` after every value change.
 *
 * The fallback sets an inline height only when the engine reports a real layout
 * (`scrollHeight > 0`), so jsdom and a hidden tab keep the CSS minimum instead of a
 * collapsed 0 px field.
 */
import * as React from 'react';

/** True when the engine sizes a textarea to its content natively. */
export function supportsFieldSizing(): boolean {
  try {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');
  } catch {
    return false;
  }
}

export function useAutoGrow(
  ref: React.RefObject<HTMLTextAreaElement>,
  value: string,
  options: { maxHeight: number; disabled?: boolean },
): void {
  const { maxHeight, disabled = false } = options;
  const native = React.useMemo(supportsFieldSizing, []);

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el || native || disabled) return;
    // Collapse first so a shrinking draft shrinks the field, then measure.
    el.style.height = 'auto';
    const content = el.scrollHeight;
    if (content <= 0) {
      el.style.removeProperty('height');
      return;
    }
    const next = Math.min(content, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = content > maxHeight ? 'auto' : 'hidden';
  }, [ref, value, maxHeight, native, disabled]);
}
