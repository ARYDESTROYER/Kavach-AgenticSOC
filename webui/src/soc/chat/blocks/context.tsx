/**
 * Shared plumbing for the answer-block renderers: the render context and the ONLY
 * link primitives a block may produce (G2, G7, G10).
 *
 * - {@link RefLink} turns a validated `InternalRef` into a router navigation (the href
 *   is built by the router's own `pageHash`, never from a block string) or a validated
 *   `DocRef` into a same-origin Help Center link. Nothing else in `chat/blocks/**` emits
 *   an `href`, except the ATT&CK link the MITRE block CONSTRUCTS from a validated id.
 * - {@link CaseLink} is a router link to the exact case plus a lazily-loaded
 *   `CaseHoverCard` preview built from the row's own fields (no fetch). The preview never
 *   costs a keyboard user their focus (see {@link CaseHoverArm}).
 *
 * Every navigation is a READ: blocks cannot trigger a mutation (G10).
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import type { Case } from '@/lib/types';
import { focusRing } from '@/lib/ui-recipes';
import { pageHash, settingsSectionHash, useNavigateOptional } from '@/soc/router';
import { isSafeCaseId } from '@/soc/case-result-route';

import type { BlockRef, CaseStatusKey, InternalRef, SeverityKey, VerdictKey } from './schema';
import { isDocRef, parseDocRef, parseInternalRef } from './schema';

export interface BlocksContextValue {
  /** Navigate to a validated in-app ref (defaults to the router). */
  navigate: (ref: InternalRef) => void;
  /** Transcript density (Case Manager embed). */
  compact: boolean;
  /** Sanitised DOM id prefix for in-message anchors (citations, report TOC). */
  domId: string;
  /** Renders a `markdown` block (WP-I's ChatMarkdown); a safe fallback otherwise. */
  renderMarkdown?: (text: string) => React.ReactNode;
  /** The exact query text a lookup step ran, for "Copy query". */
  queryForStep?: (step: number) => string | null | undefined;
  /**
   * {@link leafAnchorKey} of the ONE citations block that owns the message's
   * `<domId>-cite-n` anchors (`''` = none). Undefined outside AnswerBlocks: then only
   * top-level citations anchor.
   */
  citationOwner?: string;
}

const NOOP = () => undefined;

export const BlocksContext = React.createContext<BlocksContextValue>({
  navigate: NOOP,
  compact: false,
  domId: 'blocks',
});

export function useBlocks(): BlocksContextValue {
  return React.useContext(BlocksContext);
}

/** The default navigation: the shell router (a no-op outside a RouterProvider). */
export function useRouterNavigate(): (ref: InternalRef) => void {
  const navigate = useNavigateOptional();
  return React.useCallback((ref: InternalRef) => navigate(ref.page, ref.opts), [navigate]);
}

const DOM_ID_SAFE = /[^A-Za-z0-9_-]/g;

/** A DOM-safe id fragment from React.useId() output (never from block data, G2). */
export function domSafe(raw: string): string {
  return raw.replace(DOM_ID_SAFE, '') || 'b';
}

/** The anchor id of citation `n` inside a message (BLOCKS.md `#<msgDomId>-cite-n`). */
export function citationAnchorId(domId: string, n: number): string {
  return `${domSafe(domId)}-cite-${Math.trunc(n)}`;
}

/**
 * A block's position key in a message: `"3"` for top-level block 3, `"3.1-0"` for leaf 0
 * of section 1 inside report block 3. Used to pick the single citations anchor owner.
 */
export function leafAnchorKey(blockIndex: number, leafKey?: string): string {
  return leafKey ? `${blockIndex}.${leafKey}` : String(blockIndex);
}

/** The anchor id of report section `index` (0-based) inside a block. */
export function sectionAnchorId(domId: string, blockIndex: number, sectionIndex: number): string {
  return `${domSafe(domId)}-b${blockIndex}-s${sectionIndex}`;
}

/** Re-validate a ref at the point of use (defence in depth; the parser already did). */
function safeInternal(ref: InternalRef): InternalRef | null {
  return parseInternalRef(ref);
}

/**
 * The router's own hash for a ref (so open-in-new-tab lands on the same place): Settings
 * sections use the dedicated `#/settings?s=` form, every other page `pageHash`.
 */
export function refHref(ref: InternalRef): string {
  if (ref.page === 'settings' && ref.opts?.section) return settingsSectionHash(ref.opts.section, ref.opts.anchor);
  return pageHash(ref.page, ref.opts);
}

export interface RefLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  refValue: BlockRef;
  children: React.ReactNode;
}

/**
 * A typed link. An in-app ref renders an anchor whose href is the router's hash for that
 * page (so open-in-new-tab works) and whose click navigates in place; a Help Center ref
 * renders a same-origin anchor. An invalid ref renders its children as plain text.
 * Forwards its ref and extra props so it can be a Radix `asChild` trigger.
 */
export const RefLink = React.forwardRef<HTMLAnchorElement, RefLinkProps>(function RefLink(
  { refValue, children, className, onClick, ...rest },
  forwarded,
) {
  const { navigate } = useBlocks();
  const cls = cn('rounded-sm text-primary underline-offset-2 hover:underline', focusRing, className);
  if (isDocRef(refValue)) {
    const doc = parseDocRef(refValue);
    if (!doc) return <span>{children}</span>;
    return (
      <a ref={forwarded} {...rest} href={doc.doc} className={cls} onClick={onClick}>
        {children}
      </a>
    );
  }
  const ref = safeInternal(refValue);
  if (!ref) return <span>{children}</span>;
  return (
    <a
      ref={forwarded}
      {...rest}
      href={refHref(ref)}
      className={cls}
      onClick={(e) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(ref);
      }}
    >
      {children}
    </a>
  );
});

/* -------------------------------------------------------------------------- */
/* Case links with a lazy hover preview.                                       */
/* -------------------------------------------------------------------------- */
type HoverCardComponent = React.ComponentType<{ case: Case; children: React.ReactNode }>;

/** The loaded preview component, shared by every block once any pointer fetched it. */
let loadedHoverCard: HoverCardComponent | null = null;

function loadHoverCard(): Promise<HoverCardComponent> {
  if (loadedHoverCard) return Promise.resolve(loadedHoverCard);
  return import('@/soc/components/CaseHoverCard').then((m) => {
    loadedHoverCard = m.default as HoverCardComponent;
    return loadedHoverCard;
  });
}

const CaseHoverArmContext = React.createContext<HoverCardComponent | null>(null);

/**
 * Arms the case preview for the links inside it. The hover-card chunk is fetched only
 * when a pointer first enters a case-bearing block; keyboard users get the plain link
 * (the preview is a supplement, never the only route to the facts — the row shows them).
 *
 * Wrapping a link in the preview REMOUNTS it (its parent element changes), which would
 * throw away the focus an operator just placed on it. So the swap is held back while
 * focus is anywhere inside this container and happens the moment focus leaves it. The
 * module is loaded by hand (no React.lazy), so there is no Suspense fallback swap that
 * could land later, mid-focus; once loaded, every later block arms on first render. A
 * failed chunk load simply leaves the plain links.
 */
export function CaseHoverArm({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [card, setCard] = React.useState<HoverCardComponent | null>(() => loadedHoverCard);
  const pending = React.useRef(false);

  const tryArm = React.useCallback(() => {
    if (!loadedHoverCard) return;
    const el = ref.current;
    if (el && typeof document !== 'undefined' && el.contains(document.activeElement)) {
      pending.current = true;
      return;
    }
    pending.current = false;
    const loaded = loadedHoverCard;
    setCard(() => loaded);
  }, []);

  const onPointerEnter = () => {
    if (card) return;
    void loadHoverCard().then(tryArm, () => undefined);
  };
  const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!pending.current) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    tryArm();
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- a passive preload trigger, not a control
    <div ref={ref} className={className} onPointerEnter={card ? undefined : onPointerEnter} onBlur={onBlur}>
      <CaseHoverArmContext.Provider value={card}>{children}</CaseHoverArmContext.Provider>
    </div>
  );
}

/** A preview that fails to render degrades to the plain link (it is only a supplement). */
class PreviewBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export interface CaseLinkFacts {
  case_id: string;
  title?: string;
  severity?: SeverityKey;
  verdict?: VerdictKey;
  status?: CaseStatusKey;
  risk?: number | null;
  created_at?: string;
}

/** A partial Case for the hover preview, built only from fields the block carries. */
function previewCase(facts: CaseLinkFacts): Case {
  return {
    case_id: facts.case_id,
    title: facts.title,
    severity_band: facts.severity,
    verdict: facts.verdict,
    status: facts.status,
    risk_score: typeof facts.risk === 'number' ? facts.risk : undefined,
    created_at: facts.created_at,
  } as unknown as Case;
}

export interface CaseLinkProps {
  facts: CaseLinkFacts;
  children?: React.ReactNode;
  className?: string;
}

/** A router link to the exact case (Case Manager), never a URL from data. */
export function CaseLink({ facts, children, className }: CaseLinkProps) {
  const Card = React.useContext(CaseHoverArmContext);
  if (!isSafeCaseId(facts.case_id)) {
    return <span className={cn('font-mono', className)}>{children ?? facts.case_id}</span>;
  }
  const ref: InternalRef = { page: 'case_manager', opts: { caseId: facts.case_id } };
  const link = (
    <RefLink refValue={ref} className={className}>
      {children ?? facts.case_id}
    </RefLink>
  );
  if (!Card) return link;
  return (
    <PreviewBoundary fallback={link}>
      <Card case={previewCase(facts)}>{link}</Card>
    </PreviewBoundary>
  );
}
