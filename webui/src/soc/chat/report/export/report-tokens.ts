/**
 * The light-theme token values a report document carries (chat revamp SPEC §9.3,
 * BLOCKS.md §7.3–7.4).
 *
 * A static HTML export has no access to `theme.css`, and the print portal must stay on
 * paper-friendly LIGHT colours even when the operator works in dark mode (browsers drop
 * background colours by default, so dark-mode printing would otherwise give light text
 * on white). Both therefore carry this map: the HTML file declares it on `:root`, and
 * the print root sets it as inline custom properties, so every `hsl(var(--x))` below it
 * — Tailwind utilities and SVG marks included — resolves to the light value.
 *
 * Values are the RESOLVED `:root` entries of `src/styles/theme.css` (aliases followed).
 * `report-tokens.test.ts` re-resolves them with the design gates' own parser and fails
 * when the theme moves, so this map can never drift silently.
 */
export const REPORT_LIGHT_TOKENS: Readonly<Record<string, string>> = {
  'background': '240 20% 99%',
  'foreground': '222 47% 11%',
  'card': '240 20% 99%',
  'card-foreground': '222 47% 11%',
  'muted': '240 11% 95%',
  'muted-foreground': '220 12% 40%',
  'border': '226 12% 85%',
  'border-strong': '220 15% 58%',
  'primary': '214 90% 42%',
  'primary-foreground': '0 0% 100%',
  'surface': '240 20% 98%',
  'surface-sunken': '240 11% 95%',
  'ring': '214 90% 48%',
  'critical': '358 75% 45%',
  'critical-text': '358 75% 42%',
  'high': '22 90% 44%',
  'high-text': '22 90% 37%',
  'medium': '40 96% 38%',
  'medium-text': '40 96% 29%',
  'low': '212 90% 45%',
  'low-text': '212 90% 42%',
  'info': '220 12% 46%',
  'info-text': '215 16% 42%',
  'success': '158 74% 34%',
  'success-text': '158 74% 27%',
  'warning': '36 92% 42%',
  'warning-text': '36 96% 31%',
  'danger': '358 75% 45%',
  'danger-text': '358 75% 42%',
  'popover': '240 20% 99%',
  'popover-foreground': '222 47% 11%',
  'secondary': '240 11% 95%',
  'secondary-foreground': '220 12% 40%',
  'accent': '230 11% 89%',
  'accent-foreground': '222 47% 11%',
  'canvas': '240 20% 98%',
  'hover': '240 10% 92%',
  'input': '220 15% 58%',
  'chart-1': '211 100% 36%',
  'chart-2': '32 100% 37%',
  'chart-3': '163 100% 26%',
  'chart-4': '326 40% 50%',
  'chart-5': '202 75% 40%',
  'chart-6': '24 100% 38%',
  'chart-7': '45 92% 32%',
  'chart-8': '0 0% 42%',
  'critical-foreground': '0 0% 100%',
  'high-foreground': '0 0% 100%',
  'medium-foreground': '222 47% 11%',
  'low-foreground': '0 0% 100%',
  'info-foreground': '0 0% 100%',
  'success-foreground': '0 0% 100%',
  'warning-foreground': '222 47% 11%',
  'danger-foreground': '0 0% 100%',
  'shadow-color': '222 30% 12%',
};

/** `--name: value;` declarations for a CSS rule body. */
export function tokenDeclarations(): string {
  return Object.entries(REPORT_LIGHT_TOKENS)
    .map(([name, value]) => `--${name}:${value};`)
    .join('');
}

/** The same map as a React inline style (custom properties). */
export function tokenStyle(): Record<string, string> {
  return Object.fromEntries(Object.entries(REPORT_LIGHT_TOKENS).map(([name, value]) => [`--${name}`, value]));
}
