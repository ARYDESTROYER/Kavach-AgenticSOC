# Agentic SOC Console design-system catalog

This directory is the machine-readable boundary around the Console design system;
it does **not** replace the established implementation layers:

- `src/styles/theme.css` owns semantic CSS tokens and theme resolution.
- `src/ui/*` owns low-level shadcn/Radix primitives.
- `src/soc/components/*` owns composed operator-domain components.
- `src/design-system/*` exposes reusable cross-cutting feedback and asset contracts
  plus a serialisable catalog for tools.

## Stable exports

| Stable id / export | Purpose |
|---|---|
| `feedback.loading-state` / `LoadingState` | One centered, named loading state for page, panel, empty-table, and inline boundaries. |
| `feedback.loading-glyph` / `LoadingGlyph` | One familiar Fluent/Material-style indeterminate progress ring; it becomes a static partial ring under reduced motion. |
| `feedback.loading-bar` / `LoadingBar` | Slim non-blocking progress while existing content stays mounted. |
| `asset.source-mark` / `SourceMark` | Original, theme-adaptive vector identities keyed by source type. |
| `surface.card` / `Card` | Border-first contained surface; resting elevation is opt-in. |
| `navigation.tabs` / `Tabs` | Compact squared peer-panel navigation with Radix semantics. |
| `control.segmented` / `SegmentedControl` | Compact radiogroup value selector. |
| `layout.control-bar` / `ControlBar` | Operational heading/action row. |
| `layout.filter-bar` / `FilterBar` | Flat hairline filter and refresh band. |
| `data.table` / `DataTable` | Bounded record table with sort, selection, and paging. |
| `feedback.empty-state` / `EmptyState` | Compact shaped no-data or inline-failure state. |
| `settings.section` / `SettingsCard` | Divider-led settings section without nested cards. |
| `surface.material-bar` / `MaterialBar`, `useScrollEdge`, `useScrollEdgeRef` | The one translucent material for sticky chrome, with the scroll-edge fade shown only while content is scrolled beneath; solid under reduced transparency or increased contrast. |
| `DESIGN_SYSTEM_CATALOG` | JSON-safe inventory of tokens, components, source assets, and accessibility contracts. |

Source geometry lives under `assets/` as plain data. The marks are original Console
artwork, not downloaded vendor logos, and inherit `currentColor` so the caller controls
contrast with existing tokens.

The catalog also inventories stable primitives implemented in `src/ui/` and
`src/soc/components/`. Those components remain imported from their owning module;
catalog membership does not move domain composition into this package or create a
second implementation.

## Surface and control contract

- Resting page content is border-first. `Card` has no shadow by default; reserve
  `elevation="sm"` for a genuinely detached surface.
- Tabs and value segments share a 36px outer rail, compact 32px/28px items, an 8px
  (`rounded-md`) rail and concentric 6px (`rounded-sm`) active targets. They do not use
  pill chrome or active shadows. Radii are one concentric scale on `--radius`: 6px
  items and segments, 8px controls and rails, 10px menus and popovers, 14px dialogs
  and sheets (see [`docs/development/ui-standard.md` → Foundations](../../../docs/development/ui-standard.md#foundations)).
  Never an arbitrary `rounded-[3px]`/`rounded-[4px]`.
- `ControlBar` and `FilterBar` are the only routine page-level control bands.
  Their default variants are flat hairline sections rather than cards.
- `DataTable` owns its one bounded hairline surface. Do not put it inside another
  decorative card.
- Empty and error states are compact, shaped, and named. Avoid oversized circular
  illustrations or decorative motion.

### Settings composition

The stable Settings composition is registry-driven and responsive: a grouped,
searchable section rail on desktop becomes a compact searchable Sheet chooser on
narrow layouts. The workspace contributes only a non-heading group/section context
line; the active renderer owns the single visible `h2`. `SettingsCard` supplies flat
divider bands, field/switch/status rows remain unboxed, and one sticky Save/Discard
bar owns preference persistence.

This is a presentation contract, not another settings API. Keep section and anchor
deep links, RBAC filtering, write-only secret handling, and dirty/partial-save
semantics in the existing Settings workflow. The catalog describes these SOC-layer
components without duplicating or re-exporting their implementation here.

## Loading contract

- Use `layout="page"` at a route/bootstrap boundary, `panel` for a contained first
  load, and `table` only when a table has no usable rows yet.
- Keep existing content mounted during a refresh and use the slim shared `LoadingBar`;
  do not replace usable rows with a blocking state.
- A loading state always has a visible label and an accessible status name. Static
  shapes may preserve geometry, but the shared indeterminate ring is the only animation.
- Never create a page-local spinner, bouncing-dot sequence, or text-only “Loading”.

## Future agent/MCP distribution

`DESIGN_SYSTEM_CATALOG` is intentionally serialisable and uses stable ids instead of
React implementation details. A future package can expose it as MCP resources and map
component ids to examples or code generation guidance. **No MCP server, endpoint, or
remote service exists in version 0.1.13**; the catalog is the input contract only. When
such a service is built, it must version this schema independently and keep token,
accessibility, and source-mark ids backward compatible.
