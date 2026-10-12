---
title: Console development
description: Agentic SOC Console architecture, design system, API contracts, accessibility, and development workflow for version 0.1.
---

# Console development

The Agentic SOC Console is a standalone React 18 and TypeScript SPA built by Vite. It uses
Tailwind CSS, shadcn-style wrappers around Radix primitives, and a shared SOC component
layer. It calls the Agentic SOC API through relative `/api/*` paths.

## Set up the Console

Use Node 22 and the committed lockfile:

```bash
cd webui
npm ci
npm run dev
```

The Vite server proxies `/api` to `http://localhost:8088` by default. Override the
development target without changing source:

```bash
BACKEND_URL=http://127.0.0.1:9000 npm run dev
```

`npm run dev` has a `predev` hook that generates the same version-matched Help
Center used by production, so the in-app Documentation destination works in local
development. `npm run build` is likewise the canonical docs-plus-application build:
it runs `docs:bundle`, then `tsc --noEmit && vite build`. Use `build:app` only for a
deliberately application-only iteration that is not a release gate.

The docs wrapper honors an explicit `TLSOC_DOCS_PYTHON`, otherwise reuses a
compatible `backend/.venv` or current interpreter. If neither contains the pinned
MkDocs Material toolchain, it bootstraps the ignored root `.docs-venv` from
`docs/requirements.txt` and reuses it. `npm run docs:check` validates the generated
bundle and installed version metadata without leaving a stale checked-in artifact.

## Source layout

| Path | Responsibility |
|---|---|
| `src/soc/pages/` | Route-level product pages and settings sections |
| `src/soc/components/` | Reusable Agentic SOC domain components, charts, editors, guards, and feedback states |
| `src/soc/registry.tsx` | Single feature registry that derives navigation, routes, and command-palette entries |
| `src/soc/AppShell.tsx`, `nav`, `router`, `theme`, `auth` | Application shell, navigation, routing, theming, and session context |
| `src/ui/` | Low-level shadcn/Radix primitives; wrap and compose these instead of forking |
| `src/lib/api.ts` | HTTP client and error normalization |
| `src/lib/types.ts` | Hand-maintained product/domain contracts mirrored from backend models |
| `src/lib/api-types.gen.ts` | Generated types from the committed OpenAPI snapshot; never hand-edit |
| `src/styles/theme.css` | Light/dark design tokens and semantic color axes |

## Design-system rules

Use existing tokens and components so new work remains consistent in both themes and
under organization branding.

- Layout follows the shared spacing/grid and page-container primitives.
- Severity, status, verdict, and risk colors come from the semantic palette, not
  ad-hoc hex values.
- Low-level interactions use the existing Radix wrappers for focus management,
  keyboard behavior, dialogs, selects, tabs, and tooltips.
- Pages compose `PageHeader`, cards/tiles, data tables, empty states, skeletons,
  error states, and permission guards from the SOC layer.
- Heavy pages, charts, dashboard editing, and motion remain lazy so they do not enter
  the first-load bundle unnecessarily.

Do not reintroduce Elastic UI or Kibana packages. The archived plugin is not a source
of current UI patterns.

The enforceable page, surface, motion, loading, navigation, and theme rules are in
[Console UI standard](ui-standard.md). Read it before changing a routed page or shared
shell component. The older Round-5 research standard remains useful design history;
the development standard is the concise current contract.

## Data and API contracts

All API calls go through `src/lib/api.ts`; non-2xx responses become `ApiError` with
the server `detail`. Display server- and source-derived text as plain text. Do not use
HTML injection to render log records, case evidence, imported knowledge, user names,
or branding strings.

When the backend contract changes:

```bash
cd webui
npm run gen:types
npm run check:types
```

`gen:types` imports the backend offline, writes `openapi.json`, and regenerates
`src/lib/api-types.gen.ts`. It does not replace `src/lib/types.ts`; update that file
when its hand-maintained domain projection changes. Commit both generated files with
the backend change.

## Add a page or feature

1. Add the route-level page under the appropriate `src/soc` domain.
2. Register its route, navigation, command-palette label, permission, and lazy import
   in the single feature registry where applicable.
3. Add typed calls to `src/lib/api.ts`; do not fetch directly inside presentation components.
4. Use shared loading, empty, error, and permission states.
5. Add keyboard/focus behavior and accessible names before visual polish.
6. Test the allowed, denied, loading, empty, error, and populated states.
7. Verify both themes, narrow viewports, reduced motion, and long/untrusted strings.

## Required Console checks

```bash
npm run typecheck
npm run lint
npm run gates
npm run test:strict
npm run build
```

The production build first generates the version-matched Help Center under
`/docs/<major.minor>/`, then runs TypeScript checking before Vite. Use
`npm run build:app` only for a deliberately app-only check. Lint includes React hook
ordering and accessibility rules. Design gates protect architecture, tokens, bundle
boundaries, and other repository-wide UI constraints.

Use `npm test -- <file-or-pattern>` while iterating. `npm run test:strict` is the
release/CI gate: it runs the full suite and also rejects any stderr byte or
Vitest-captured console stdout block.

The first-paint bundle checks in `src/soc/__tests__/bundle-first-paint.test.ts` (entry
size budget, lazy chunks kept off first paint) read the built `dist/`. Without a build,
`test:strict` skips them and runs only their source guards. CI's production-build lane
runs the file again after `npm run build` with `REQUIRE_DIST_BUILD=1`, where a missing
build fails instead of skipping. Run the same check locally after a build:
`REQUIRE_DIST_BUILD=1 npx vitest run src/soc/__tests__/bundle-first-paint.test.ts`.

See [Testing](testing.md) for the full cross-stack gate and
[API reference](../reference/api.md) for the runtime surface.
