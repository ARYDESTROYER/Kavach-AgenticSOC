---
title: Console design system
description: Canonical tokens, primitives, feedback states, source marks, and machine-readable contracts for the Agentic SOC Console.
---

# Console design system

Agentic SOC keeps visual decisions in a small set of explicit layers. Pages compose
these layers; they do not invent another palette, loader, source icon, control shape,
or motion language.

| Layer | Owns | Location |
|---|---|---|
| Theme | Semantic CSS variables, Light/Dark values, material, motion and reduced-motion / reduced-transparency / increased-contrast rules | `webui/src/styles/theme.css` |
| Primitives | Accessible shadcn-style wrappers over Radix | `webui/src/ui/` |
| Cross-cutting system | Loading feedback, the Console material, the panel and list grammar (Round 14), source identities, stable catalog exports | `webui/src/design-system/` |
| SOC components | Tables, case badges, charts, page anatomy, editors, RBAC guards | `webui/src/soc/components/` |
| Product surfaces | Routed operator workflows | `webui/src/soc/pages/` |

Read the [Console UI standard](ui-standard.md) for the visual and interaction
contract. This page describes where shared implementation belongs.

## Public design-system boundary

Import cross-cutting contracts from `@/design-system`:

```tsx
import { LoadingState, Panel, SourceMark } from '@/design-system';
```

The public barrel currently exposes:

- `LoadingState`, `LoadingGlyph`, `LoadingShape`, and the non-blocking `LoadingBar`;
- the page grammar added in Round 14 (see [Page anatomy](ui-standard.md#page-anatomy)
  and [Tables, filters and lists](ui-standard.md#tables-filters-and-lists)):
  - `Panel`, one module on the tinted borderless panel (14px corner, no border, no
    resting shadow) with its title row: a 14px semibold heading (`level` 2 or 3), an
    optional muted `count` and `caption`, and an `aside` or `actions` on the right;
    `as="section"` makes it a region named by that heading, and `padding="none"` lets a
    table or list bleed to the panel edge while the title keeps the panel inset;
  - `SectionTitle`, the 15px semibold sentence-case title for a module or group that
    sits on the canvas above its panel;
  - `PANEL_PADDING`, `PANEL_PADDING_X` and `PANEL_GAP`, the one value for panel padding
    and the gutter between panels (16px, 20px from 1280px, 24px from 1920px), for a
    page that lays out its own grid of panels (the Cyber Defence Center);
  - `ListRow` and `ListRows`, a list of records that are not a table, divided by
    hairlines and never boxed, each row opened from one control named by its title;
  - `RowActions`, the neutral ghost icon actions at a row's end and its named row menu,
    destructive actions neutral at rest and red only on hover, focus and in their
    confirm dialog;
  - `StatusDot`, a 6px dot and words, coloured only for a state that is not the healthy
    default;
  - `Callout`, with three intents only (`warning`, `error`, and a dismissible `intro`
    remembered per user in `UserPrefs.misc.dismissed_intros`, whose id follows
    `DISMISSED_INTRO_ID_PATTERN`; `DISMISSED_INTROS_KEY` and `DISMISSED_INTROS_MAX` are
    exported beside it);
- the Console material: `MaterialBar`, the `materialBar` / `materialThick` recipes, and
  `useScrollEdge` / `useScrollEdgeRef` (the scroll-edge fade under sticky chrome; the
  shared sticky `PageHeader`, `ControlBar`, `FilterBar` and `TableHeader` already use
  it). Shared primitives import it from `@/design-system/material` rather than the
  barrel, so the catalog never rides into their chunks;
- the per-user transparency override: `applyTransparencyPreference` with
  `TRANSPARENCY_PREF_KEY` and `TRANSPARENCY_STORAGE_KEY`;
- `SourceMark` and the source-mark metadata;
- `DESIGN_SYSTEM_CATALOG`, a JSON-serializable inventory of the stable component,
  token, asset, and accessibility contracts.

The catalog also documents stable page-anatomy components in their owning modules:
`PageHeader` (the title, a help tip, the `controls` slot beside the title, `actions` on
the right, and `back`, a link to the list a page was opened from), `KpiStrip` (the one
KPI strip per page; a tile may be `pressed` as a filter or start a second split with
`breakBefore`), `KpiTile` (`chrome="strip"` on pages, `chrome="framed"` only for chat
answer blocks and `StatCard`) and `KpiTileGrid`, `Card`, `Tabs` (`TabsList
variant="underline"` for page and record sections), `SegmentedControl`, `ControlBar`,
`FilterBar`, `DataTable`, `NumberField`, `Field`, `TimeRangePicker`, `RefreshButton`,
`OwnerMonogram` (the one assignee monogram for the Cases list, the Case Manager queue
and the case header), `EmptyState`, the Settings `SettingsSection`, `SettingsGroup` and
`SettingRow`, and the pre-Round-14 divider-led `SettingsCard`. Import these from the
module named in the catalog; they remain SOC/UI-layer components rather than duplicate
wrappers in `src/design-system/`. `PageContainer` owns the page width and, since Round
14, the rhythm between modules (one panel gutter; `rhythm="none"` for a page that lays
itself out).

Keep page-specific composition in the page or an SOC-domain component. Move a
pattern into `src/design-system/` only when it is genuinely cross-cutting, has a
stable name, works in both themes, has a keyboard/screen-reader contract, and is
covered by focused tests.

## Surface and control grammar

Routine operator surfaces are border-first and quiet:

- `Card` has no resting shadow by default and uses a compact `rounded-md` edge.
  Opt into `elevation="sm"` only when the surface is genuinely detached.
- `Tabs` and `SegmentedControl` use the same rail grammar: a 36px outer control with an
  8px radius, compact 6px inner targets (concentric radii), no pill treatment, and no
  active shadow. Tabs own peer panels; segments select one value and expose radiogroup
  semantics.
- Floating surfaces follow the concentric scale in the [Console UI standard](ui-standard.md#foundations):
  10px menus, popovers and tooltips holding 6px items; 14px dialogs and sheets. Menus
  use `menuSurface` and popovers `overlaySurface` from `lib/ui-recipes.ts`; both are
  solid and scale from their trigger.
- Every page module sits on a `Panel`, one panel gutter from the next; a `Card`,
  `StatCard` or framed `KpiTile` never sits inside a `Panel`, `ChartCard` or `KpiStrip`
  (the console grammar guard test fails on it).
- `ControlBar` and `FilterBar` are the page-level action/filter bands. On a panel the
  `FilterBar` draws no rules (`variant="plain"`, the default); the hairline band is only
  for a page not yet on panels.
- `DataTable` owns a single bounded hairline (or none on `Panel padding="none"` with
  `surface="panel"`) and a compact shared `EmptyState`.
  Do not wrap the table in decorative elevation. A pointer-clickable row is never
  itself exposed as a button when it can contain checkboxes, links, or menus; provide
  the shared named trailing action, or disable it only when a visible cell already
  contains an equivalent named keyboard action.
- A Settings section is a `SettingsSection` whose related settings form
  `SettingsGroup`s: a title above one tinted panel of `SettingRow`s divided by
  hairlines. `SettingsCard` is the pre-Round-14 divider-led section, kept only until
  every section has moved; a new section never uses it.

The Settings workspace composes these primitives with a stable responsive pattern:
one grouped/searchable desktop rail, one compact Sheet chooser on narrow layouts,
one renderer-owned section `h2` with its help tip and actions on the same row, grouped
panels of rows, and one sticky Save/Discard bar. `SettingsSection`, `SettingsGroup`,
`SettingRow`, `SettingsCard`, `SettingsGrid`, `SettingsTOC`, and `StickySaveBar` remain
SOC-layer components; their catalog entries document the contract but do not move them
into `src/design-system/`.
Section ids, anchor deep links, permission filtering, write-only secrets, and dirty
state belong to the Settings workflow and must survive visual changes. Preference and
write-only-secret drafts protect reload/tab close and pause programmatic cross-page
navigation behind the shared accessible confirmation dialog; same-page section jumps
must keep the mounted draft without prompting.

These rules apply in Light, Dark, and System mode because all colour is semantic-token
driven. Resting shadows, gradients, and decorative animation are not theme substitutes.

## Colour and token ownership

The severity, status, verdict, and risk axes in `theme.css` are measured systems, not
independent swatches. Each axis owns a base fill, a foreground for text placed on that
fill, and an AA standalone-text token. Small text on a semantic wash uses the
standalone-text token, and the contrast gate measures it on the actual card plus 10%
fill composition used by alerts, badges, and notices.

Organisation Branding may change the primary/secondary accent, radius, density,
material chrome, and display font through the bounded allow-list. It cannot override
semantic SOC fills or their derived foreground/text companions. Legacy saved payloads
containing those keys remain loadable, but the client and backend ignore the unsafe
keys rather than splitting the measured contrast and colour-blind-safe pairings.

A custom primary accent is applied identically in Light and Dark. The runtime therefore
derives the higher-contrast black or white `--primary-foreground` from the effective
accent instead of inheriting opposite theme defaults. Before branding is reapplied,
every branding-writable inline token is cleared so removing an override restores the
stylesheet default without stale colour, font, density, radius, or material state.
Display-font preferences stay as stable allow-listed keys on the wire and expand to the
self-hosted font stack only at the DOM boundary. Legacy hex values for primary, ring,
and secondary-accent tokens are normalised to the HSL triplets consumed by the CSS
system before they are written.

## Loading feedback

Use one blocking-load grammar:

- `layout="page"` for application boot or lazy-route boundaries;
- `layout="panel"` for the first load of a contained workflow;
- `layout="table"` when a table has no usable rows yet;
- `layout="inline"` only for a compact, named wait inside an existing surface.

Every blocking state has a visible label and an accessible status name. The shared
Fluent/Material-style indeterminate progress ring is the only animation; the optional
background shape is static and preserves the resolved content footprint. Reduced-motion
users receive the same ring as a static partial arc.

When usable content already exists, keep it mounted and use the slim shared
`LoadingBar` for refresh progress. Button-level work may retain a small spinner
inside that button. Do not add a page-local spinner, bouncing-dot sequence, several
simultaneous shimmer regions, blank canvas, or text-only “Loading”.

## Source identity assets

`SourceMark` provides an original, single-colour vector identity for every built-in
connector type and stable marks for reserved native types. Geometry lives as plain
serializable data under `src/design-system/assets/`; the React renderer inherits
`currentColor`, so semantic contrast remains under the existing theme.

These marks are Agentic SOC artwork, not copied or downloaded vendor logos. This
keeps the application self-contained and avoids an external asset, trademark, or
theme-compatibility dependency. Unknown third-party connectors receive the generic
fallback mark and may supply their accessible connector label.

When adding a connector:

1. add or deliberately select its stable source-mark definition;
2. keep the wire-compatible `sourceType` unchanged;
3. use a simple 24×24 single-colour geometry with no embedded text or raw colour;
4. add it to the machine-readable catalog and focused completeness test;
5. verify the picker/editor in Light, Dark, and a narrow viewport.

## Catalog and future agent tooling

`DESIGN_SYSTEM_CATALOG` is a source-level discovery contract with stable ids,
module/export names, variants, token roles, accessibility requirements, and source
asset metadata. It can later back examples, code generators, or an MCP resource
without scraping JSX.

Round 14 added the entries for the page grammar: `surface.panel`,
`typography.section-title`, `layout.page-header`, `metric.kpi-strip`, `data.list-row`,
`control.row-actions`, `feedback.status-dot`, `feedback.callout`, `control.number-field`,
`control.field`, `control.time-range-picker`, `control.refresh-button`, and the Settings
`settings.group` and `settings.row`. `settings.section` now names `SettingsSection`,
and the pre-Round-14 `SettingsCard` has its own `settings.card` entry. Every other
existing id keeps its meaning.

Version **0.1.13 does not ship a design-system MCP server, endpoint, registry
service, or remote package**. The serializable catalog is the deliberately small
input contract for that future work. A future transport must version its schema
independently and preserve existing token, component, accessibility, and asset ids.

## Change checklist

For a shared-system change:

1. update the implementation and its public barrel export;
2. update `DESIGN_SYSTEM_CATALOG` when the discoverable contract changes;
3. add focused render, accessibility, both-theme, and completeness regressions;
4. use the component in at least one real product surface;
5. run focused tests, TypeScript, lint, design gates, the full Console suite, and
   the production docs-plus-app build;
6. inspect the changed surface in Light, Dark, and a narrow viewport.
