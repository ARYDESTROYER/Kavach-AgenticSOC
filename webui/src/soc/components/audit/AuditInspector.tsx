/**
 * The audit record inspector (Round 14 SPEC §4.5.2, operator choice C1 A).
 *
 * A 560 px sheet from the right. From 1280 px it is non-modal (no overlay; the list stays
 * scrollable and clickable, clicking another row swaps the record) and is a labelled
 * region; below 1280 px it is a modal dialog with a focus trap, and below 640 px it
 * fills the screen. Focus moves to the title only when the person opened the record with
 * Enter or a click (always in the modal form); J and K page the record while focus stays
 * where it was. Esc or Close closes and hands focus back to the row last shown (the
 * page's `onCloseAutoFocus`).
 *
 * Sections, divider-led like the Case Manager facts rail, no nested cards: Who, What
 * changed, Details, Raw record, Record, Related. Fields an older row does not carry are
 * left out, never shown empty. Every value is a plain text node (#9); the prompt excerpt
 * and tool output sit in code blocks labelled as untrusted log data, and stored data is
 * shown verbatim (AU-7).
 */
import * as React from 'react';
import { ArrowDown, ArrowUp, Copy, Link2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { humanizeToken } from '@/lib/format';
import type { NavOpts } from '@/lib/types';
import type { AuditChange, AuditRecord } from '@/lib/types-audit';
import { LoadingState } from '@/design-system';
import { Button } from '@/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/ui/sheet';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { pageHash } from '@/soc/router';
import { useRouteLinkClick } from '@/soc/route-link';

import { categoryLabel } from './events';
import { JsonTree } from './JsonTree';
import {
  ACTOR_KIND_LABEL,
  actorKindKey,
  fieldLabel,
  formatLocalClock,
  formatRowTime,
  parseUserAgent,
  recordCaseText,
  recordSentence,
  storedRecord,
  timeOf,
} from './audit-model';
import { ActorMark, OutcomeMark } from './parts';

/** The title's id: the page focuses it and the non-modal region is named by it. */
export const INSPECTOR_TITLE_ID = 'audit-inspector-title';

export interface AuditInspectorProps {
  open: boolean;
  /** Below 1280 px: a modal dialog with an overlay and a focus trap. */
  modal: boolean;
  /** Below 640 px: the whole screen. */
  phone: boolean;
  /** The record shown; null while a deep-linked record loads or when it is missing. */
  record: AuditRecord | null;
  loading: boolean;
  /** A deep link named a record the current store does not hold. */
  notFound: boolean;
  /** A deep-linked record could not be read (not a missing record): offer Retry. */
  failed: boolean;
  onRetry: () => void;
  /** "record 3 of 50" (null when the record is not in the loaded list). */
  position: { index: number; count: number } | null;
  /**
   * The failure row of this action row's write (SPEC §3.6: the write was not applied, and
   * its failure row follows it in time), or null.
   */
  notAppliedBy: AuditRecord | null;
  /** Show another loaded record (the failure row a "Not applied" note names). */
  onShowRecord: (recordId: string) => void;
  /** A Related link is being followed in this tab (the page drops its in-memory filters). */
  onFollowRelated: () => void;
  /** Focus the title when the sheet opens (a click or Enter, or the modal form). */
  focusTitleOnOpen: boolean;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  /** Return focus to the row last shown (Radix `onCloseAutoFocus`). */
  onCloseAutoFocus: (event: Event) => void;
  /** The full link to this record with the page's filters. */
  shareHref: string;
  /** The audit log opts for the Related links (filters a person can apply in one click). */
  relatedOpts: (kind: RelatedKind) => NavOpts | null;
  canOpenCase: boolean;
  /** The source links to its logs (`sources:read`, the Logs page's grant). */
  canOpenSource: boolean;
  /** Announce a short message in the page's polite live region. */
  announce: (message: string) => void;
}

export type RelatedKind = 'actor-window' | 'target' | 'case' | 'session-sign-in';

/* -------------------------------------------------------------- building blocks -- */

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0 border-t border-border/70 pt-4">
      <h3 id={id} className="mb-2 text-sm font-semibold text-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A label and its value: side by side from 640 px, stacked on a phone. */
function Fact({ label, children, mono = false }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-0.5 py-1 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-foreground [overflow-wrap:anywhere]',
          mono && 'font-mono text-xs',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function TextToggle({
  shown,
  onToggle,
  showLabel,
  hideLabel,
  controls,
}: {
  shown: boolean;
  onToggle: () => void;
  showLabel: string;
  hideLabel: string;
  controls: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={shown}
      aria-controls={controls}
      className="rounded-sm font-sans text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {shown ? hideLabel : showLabel}
    </button>
  );
}

function CopyValue({ value, label, announce }: { value: string; label: string; announce: (m: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        void copyText(value).then((ok) => announce(ok ? 'Copied' : 'Could not copy'));
      }}
      aria-label={`Copy ${label}`}
      className="inline-flex items-center gap-0.5 rounded-sm font-sans text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Copy className="size-3" aria-hidden />
      Copy
    </button>
  );
}

const NAV_ID = /^[\w.:-]{1,128}$/;

/** A plain primary click, the one the router takes over (a modified click opens a new tab). */
const plainClick = (event: React.MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

function RouteLink({
  href,
  children,
  className,
  onFollow,
  ...rest
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
  /** Runs before a plain click navigates in this tab. */
  onFollow?: () => void;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'className' | 'children'>) {
  const onClick = useRouteLinkClick(href, onFollow ? (event) => (plainClick(event) ? onFollow() : undefined) : undefined);
  return (
    <a
      {...rest}
      href={href}
      onClick={onClick}
      className={cn(
        'rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </a>
  );
}

/* ------------------------------------------------------------------- sections -- */

function WhoSection({ record, announce }: { record: AuditRecord; announce: (m: string) => void }) {
  const [showForwarded, setShowForwarded] = React.useState(false);
  const [showUa, setShowUa] = React.useState(false);
  const kind = actorKindKey(record);
  const client = record.client;
  const parsedUa = parseUserAgent(client?.user_agent);
  const remembered =
    record.tool_input && typeof record.tool_input === 'object'
      ? (record.tool_input as Record<string, unknown>).remembered
      : undefined;
  return (
    <Section id="audit-inspector-who" title="Who">
      <dl>
        <Fact label="Actor">
          <ActorMark record={record} className="max-w-full" />
          <span className="text-muted-foreground">
            · {ACTOR_KIND_LABEL[kind]}
            {record.actor_type_derived ? ' (derived)' : ''}
            {record.actor_role ? `, ${humanizeToken(record.actor_role).toLowerCase()} at the time` : ''}
          </span>
        </Fact>
        {client ? (
          <>
            <Fact label="Client IP">
              {client.ip ? <span className="font-mono text-xs">{client.ip}</span> : <span>Not an address</span>}
              <span className="text-muted-foreground">
                {client.ip_source === 'trusted_proxy' ? 'From the trusted proxy' : 'From the connection'}
              </span>
              {client.forwarded_for ? (
                <TextToggle
                  shown={showForwarded}
                  onToggle={() => setShowForwarded((v) => !v)}
                  showLabel="Show forwarded header"
                  hideLabel="Hide forwarded header"
                  controls="audit-inspector-forwarded"
                />
              ) : null}
            </Fact>
            {client.forwarded_for && showForwarded ? (
              <div id="audit-inspector-forwarded" className="pb-1 sm:pl-[9.25rem]">
                <p className="text-xs text-muted-foreground">Supplied by the client; not verified</p>
                <p className="font-mono text-xs text-foreground [overflow-wrap:anywhere]">{client.forwarded_for}</p>
              </div>
            ) : null}
            {client.peer && client.peer !== client.ip ? (
              <Fact label="Connection" mono>
                {client.peer}
              </Fact>
            ) : null}
            {client.user_agent ? (
              <Fact label="User agent">
                <span>{parsedUa ?? 'Not recognised'}</span>
                <TextToggle
                  shown={showUa}
                  onToggle={() => setShowUa((v) => !v)}
                  showLabel="Show raw"
                  hideLabel="Hide raw"
                  controls="audit-inspector-ua"
                />
              </Fact>
            ) : null}
            {client.user_agent && showUa ? (
              <p id="audit-inspector-ua" className="pb-1 font-mono text-xs text-foreground [overflow-wrap:anywhere] sm:pl-[9.25rem]">
                {client.user_agent}
              </p>
            ) : null}
          </>
        ) : null}
        {record.session_ref ? (
          <Fact label="Session">
            <span className="font-mono text-xs">{record.session_ref.slice(0, 8)}</span>
            {typeof remembered === 'boolean' ? (
              <span className="text-muted-foreground">{remembered ? 'remembered' : 'not remembered'}</span>
            ) : null}
            <CopyValue value={record.session_ref} label="session reference" announce={announce} />
          </Fact>
        ) : null}
      </dl>
    </Section>
  );
}

function ChangeValue({ value, before }: { value: string | null; before: boolean }) {
  if (value === null) return <span className="text-muted-foreground">Not set</span>;
  return before ? (
    <span className="text-muted-foreground line-through decoration-1 [overflow-wrap:anywhere]">{value}</span>
  ) : (
    <span className="font-semibold text-foreground [overflow-wrap:anywhere]">{value}</span>
  );
}

function ChangesSection({ changes }: { changes: readonly AuditChange[] }) {
  return (
    <Section id="audit-inspector-changes" title="What changed">
      <div className="overflow-hidden rounded-md border border-border/70">
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">Each field this event changed, with its value before and after</caption>
          <thead>
            <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
              <th scope="col" className="w-[40%] px-3 py-1.5 font-medium">
                Field
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                Before
              </th>
              <th scope="col" className="px-3 py-1.5 font-medium">
                After
              </th>
            </tr>
          </thead>
          <tbody>
            {changes.map((c, i) => (
              <tr key={`${c.field}-${i}`} className="border-b border-border/70 align-top last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="block text-foreground">{fieldLabel(c.field)}</span>
                  <span className="block font-mono text-2xs text-muted-foreground [overflow-wrap:anywhere]">{c.field}</span>
                </th>
                {c.secret ? (
                  <td colSpan={2} className="px-3 py-2 text-muted-foreground">
                    Changed (secret values are never recorded)
                  </td>
                ) : (
                  <>
                    <td className="px-3 py-2">
                      <ChangeValue value={c.before} before />
                    </td>
                    <td className="px-3 py-2">
                      <ChangeValue value={c.after} before={false} />
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function hasDetails(record: AuditRecord): boolean {
  return Boolean(
    record.result_summary ||
      record.tool_output_summary ||
      record.query_text ||
      record.model ||
      record.tool_name ||
      (record.tool_input !== null && record.tool_input !== undefined) ||
      record.prompt_excerpt,
  );
}

function DetailsSection({ record, announce }: { record: AuditRecord; announce: (m: string) => void }) {
  const toolInput = record.tool_input;
  return (
    <Section id="audit-inspector-details" title="Details">
      <dl>
        {record.result_summary ? (
          <Fact label="Stored summary">
            <span className="whitespace-pre-wrap">{record.result_summary}</span>
          </Fact>
        ) : null}
        {record.model ? (
          <Fact label="Model" mono>
            {record.model}
          </Fact>
        ) : null}
        {record.tool_name ? (
          <Fact label="Tool" mono>
            {record.tool_name}
          </Fact>
        ) : null}
      </dl>
      {record.query_text ? (
        <CodeBlock
          caption="Query, as it ran"
          value={record.query_text}
          wrap
          className="mt-2 [&_pre]:[overflow-wrap:anywhere]"
          maxHeightClassName="max-h-40"
        />
      ) : null}
      {record.tool_output_summary ? (
        <CodeBlock
          caption="Tool output · contains untrusted log data"
          value={record.tool_output_summary}
          wrap
          className="mt-2 [&_pre]:[overflow-wrap:anywhere]"
          maxHeightClassName="max-h-40"
        />
      ) : null}
      {toolInput !== null && toolInput !== undefined ? (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">Tool input</p>
            <button
              type="button"
              onClick={() => {
                void copyText(JSON.stringify(toolInput, null, 2)).then((ok) => announce(ok ? 'Copied' : 'Could not copy'));
              }}
              className="inline-flex items-center gap-1 rounded-sm text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Copy className="size-3" aria-hidden />
              Copy JSON
            </button>
          </div>
          <JsonTree value={toolInput} label="Tool input" />
        </div>
      ) : null}
      {record.prompt_excerpt ? (
        <CodeBlock
          caption="Prompt excerpt · contains untrusted log data"
          value={record.prompt_excerpt}
          wrap
          className="mt-3 [&_pre]:[overflow-wrap:anywhere]"
          maxHeightClassName="max-h-40"
        />
      ) : null}
    </Section>
  );
}

const TRUNCATED_LABEL: Readonly<Record<string, string>> = {
  result_summary: 'stored summary',
  tool_output_summary: 'tool output',
  query_text: 'query',
  prompt_excerpt: 'prompt excerpt',
};

function RawSection({ record }: { record: AuditRecord }) {
  const truncated = record.truncated_fields ?? [];
  // What the store holds, without the read-time projections (AU-7).
  const stored = React.useMemo(() => JSON.stringify(storedRecord(record), null, 2), [record]);
  return (
    <Section id="audit-inspector-raw" title="Raw record">
      <CodeBlock
        caption="Stored JSON, read-only"
        value={stored}
        wrap
        className="[&_pre]:[overflow-wrap:anywhere]"
        maxHeightClassName="max-h-72"
      />
      {truncated.length ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Stored truncated at 1,000 characters: {truncated.map((f) => TRUNCATED_LABEL[f] ?? f).join(', ')}.
        </p>
      ) : null}
    </Section>
  );
}

function RecordSection({
  record,
  canOpenCase,
  canOpenSource,
  announce,
}: {
  record: AuditRecord;
  canOpenCase: boolean;
  canOpenSource: boolean;
  announce: (m: string) => void;
}) {
  const caseText = recordCaseText(record);
  return (
    <Section id="audit-inspector-record" title="Record">
      <dl>
        <Fact label="Event">
          <span className="font-mono text-xs">{record.action_type}</span>
          {record.action ? <span className="font-mono text-xs text-muted-foreground">· {record.action}</span> : null}
          <span className="text-muted-foreground">· {categoryLabel(record.category)}</span>
        </Fact>
        {record.surface ? (
          <Fact label="Surface" mono>
            {record.surface}
          </Fact>
        ) : null}
        {record.target ? (
          <Fact label="Target">
            <span>
              {humanizeToken(record.target.type)}: {record.target.label}
            </span>
            {record.target.id !== record.target.label ? (
              <span className="font-mono text-xs text-muted-foreground">{record.target.id}</span>
            ) : null}
            {typeof record.target.revision === 'number' ? (
              <span className="text-muted-foreground">revision {record.target.revision.toLocaleString()}</span>
            ) : null}
          </Fact>
        ) : null}
        {record.case_id ? (
          <Fact label="Case">
            {canOpenCase ? (
              <RouteLink href={pageHash('case_manager', { caseId: record.case_id })} className="font-mono text-xs">
                {caseText ?? record.case_id}
              </RouteLink>
            ) : (
              <span className="font-mono text-xs">{caseText ?? record.case_id}</span>
            )}
          </Fact>
        ) : null}
        {record.source_id ? (
          <Fact label="Source" mono>
            {canOpenSource && NAV_ID.test(record.source_id) ? (
              <RouteLink
                href={pageHash('logs', { sourceId: record.source_id })}
                className="font-mono text-xs"
                title="Open this source's logs"
              >
                {record.source_id}
              </RouteLink>
            ) : (
              record.source_id
            )}
          </Fact>
        ) : null}
        <Fact label="Record id">
          <span className="min-w-0 truncate font-mono text-xs" title={record.record_id}>
            {record.record_id}
          </span>
          <CopyValue value={record.record_id} label="record id" announce={announce} />
        </Fact>
        {record.event_id ? (
          <Fact label="Event id" mono>
            {record.event_id}
          </Fact>
        ) : null}
        {record.request_id ? (
          <Fact label="Request id" mono>
            {record.request_id}
          </Fact>
        ) : null}
        {record.run_id ? (
          <Fact label="Run id" mono>
            {record.run_id}
          </Fact>
        ) : null}
        {record.app_version ? (
          <Fact label="App version" mono>
            {record.app_version}
          </Fact>
        ) : null}
        {record.build_sha ? (
          <Fact label="Build" mono>
            {record.build_sha}
          </Fact>
        ) : null}
        {record.demo ? <Fact label="Store">Demo (this row lives only while Demo Mode is on)</Fact> : null}
      </dl>
    </Section>
  );
}

const RELATED_LABEL = (record: AuditRecord): ReadonlyArray<{ kind: RelatedKind; label: string }> => [
  { kind: 'actor-window', label: `Same actor within 15 minutes` },
  ...(record.target?.id ? [{ kind: 'target' as const, label: 'All events for this target' }] : []),
  ...(record.case_id ? [{ kind: 'case' as const, label: 'All events for this case' }] : []),
  ...(record.session_ref ? [{ kind: 'session-sign-in' as const, label: `Sign-ins by ${record.actor} in the 30 days before this event` }] : []),
];

function RelatedSection({
  record,
  relatedOpts,
  canOpenCase,
  onFollowRelated,
}: {
  record: AuditRecord;
  relatedOpts: AuditInspectorProps['relatedOpts'];
  canOpenCase: boolean;
  onFollowRelated: () => void;
}) {
  const links = RELATED_LABEL(record).flatMap((item) => {
    const opts = relatedOpts(item.kind);
    return opts ? [{ ...item, href: pageHash('audit', opts) }] : [];
  });
  if (!links.length && !(record.case_id && canOpenCase)) return null;
  return (
    <Section id="audit-inspector-related" title="Related">
      <ul className="flex flex-col gap-1.5 text-sm">
        {links.map((link) => (
          <li key={link.kind}>
            <RouteLink href={link.href} onFollow={onFollowRelated}>
              {link.label}
            </RouteLink>
          </li>
        ))}
        {record.case_id && canOpenCase ? (
          <li>
            <RouteLink href={pageHash('case_manager', { caseId: record.case_id })}>Open case trace</RouteLink>
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

/* --------------------------------------------------------------------- the sheet -- */

export function AuditInspector({
  open,
  modal,
  phone,
  record,
  loading,
  notFound,
  failed,
  onRetry,
  position,
  notAppliedBy,
  onShowRecord,
  onFollowRelated,
  focusTitleOnOpen,
  canPrev,
  canNext,
  onPrev,
  onNext,
  onClose,
  onCloseAutoFocus,
  shareHref,
  relatedOpts,
  canOpenCase,
  canOpenSource,
  announce,
}: AuditInspectorProps) {
  const ms = record ? timeOf(record.ts) : null;
  const copyLink = () => {
    void copyText(shareHref).then((ok) => announce(ok ? 'Copied' : 'Could not copy the link'));
  };
  return (
    <Sheet open={open} modal={modal} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side="right"
        size="lg"
        // Non-modal: a labelled region beside the live list. Modal: Radix's own dialog
        // role (an explicit `role={undefined}` would erase it).
        {...(modal ? { 'aria-modal': true } : { role: 'region' })}
        aria-labelledby={INSPECTOR_TITLE_ID}
        data-audit-inspector={modal ? 'modal' : 'region'}
        className={cn(
          'gap-0 overflow-y-auto p-0',
          phone ? 'max-w-full' : 'max-w-full sm:max-w-[35rem]',
          // A 36 px close button (44 px on a phone, where the sheet is the whole screen).
          '[&>button[aria-label=Close]]:right-3 [&>button[aria-label=Close]]:top-3 [&>button[aria-label=Close]]:size-9',
          'max-sm:[&>button[aria-label=Close]]:right-2 max-sm:[&>button[aria-label=Close]]:top-2 max-sm:[&>button[aria-label=Close]]:size-11',
        )}
        onOpenAutoFocus={(event) => {
          // Focus goes to the title only for a click, Enter or the modal form; J and K
          // keep it on the row (SPEC §4.5.2). Never the first button (no ring at rest).
          event.preventDefault();
          if (modal || focusTitleOnOpen) {
            window.requestAnimationFrame(() => document.getElementById(INSPECTOR_TITLE_ID)?.focus());
          }
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={(event) => {
          // Non-modal: Radix hears Esc on the whole document, before the field does. Esc
          // in a text field beside the sheet (the search box resetting its draft) belongs
          // to that field; a second Esc from the list closes the sheet.
          const target = event.target as HTMLElement | null;
          if (
            !modal &&
            target?.closest?.('input, textarea, select, [contenteditable="true"]') &&
            !target.closest('[data-audit-inspector]')
          ) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          // Non-modal: the list stays live beside the sheet; a click on another row
          // swaps the record instead of closing it.
          if (!modal) event.preventDefault();
        }}
      >
        <div className="flex min-h-0 flex-col gap-4 p-5 pt-4">
          <div className="flex flex-col gap-2 pr-12">
            <div className="flex items-start justify-between gap-3">
              <SheetTitle
                id={INSPECTOR_TITLE_ID}
                tabIndex={-1}
                className="min-w-0 break-words text-lg font-semibold text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {record ? record.event_label : notFound ? 'Record not found' : failed ? 'Record not loaded' : 'Audit record'}
              </SheetTitle>
              {record ? (
                <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={copyLink}>
                  <Link2 className="size-3.5" aria-hidden />
                  Copy link
                </Button>
              ) : null}
            </div>
            <SheetDescription className="line-clamp-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">
              {record
                ? recordSentence(record)
                : notFound
                  ? 'This record is not in the current store.'
                  : failed
                    ? 'The record could not be loaded.'
                    : 'Loading the record.'}
            </SheetDescription>
            {record ? (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
                <OutcomeMark record={record} className="font-medium" showDerived />
                <span aria-hidden>·</span>
                <time dateTime={record.ts} className="tabular-nums text-foreground">
                  {formatRowTime(record.ts, 'utc')} UTC
                </time>
                {ms !== null ? <span className="tabular-nums">{formatLocalClock(ms)} local</span> : null}
                {record.demo ? <span className="rounded-sm border border-border px-1 text-2xs">Demo</span> : null}
              </p>
            ) : null}
            {record && notAppliedBy ? (
              <p className="text-sm font-medium text-warning-text" data-testid="audit-not-applied">
                Not applied (
                <button
                  type="button"
                  onClick={() => onShowRecord(notAppliedBy.record_id)}
                  className="rounded-sm font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  see the next record
                </button>
                )
              </p>
            ) : null}
            {record ? (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {/* The key is a visible hint, not part of the name: `aria-keyshortcuts` says it. */}
                <Button variant="outline" size="sm" className="gap-1.5" onClick={onPrev} disabled={!canPrev} aria-keyshortcuts="K">
                  <ArrowUp className="size-3.5" aria-hidden />
                  Previous
                  <kbd aria-hidden className="rounded-sm border border-border px-1 font-mono text-2xs text-muted-foreground">
                    K
                  </kbd>
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={onNext} disabled={!canNext} aria-keyshortcuts="J">
                  <ArrowDown className="size-3.5" aria-hidden />
                  Next
                  <kbd aria-hidden className="rounded-sm border border-border px-1 font-mono text-2xs text-muted-foreground">
                    J
                  </kbd>
                </Button>
                {position ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    Record {position.index.toLocaleString()} of {position.count.toLocaleString()} loaded
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          {loading && !record ? <LoadingState label="Loading the record" layout="panel" /> : null}
          {notFound && !record ? (
            <div className="flex flex-col items-start gap-3">
              <Button variant="outline" size="sm" onClick={onClose}>
                Back to the audit log
              </Button>
            </div>
          ) : null}
          {failed && !record && !notFound ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Back to the audit log
              </Button>
            </div>
          ) : null}

          {record ? (
            <div className="flex min-w-0 flex-col gap-4">
              <WhoSection record={record} announce={announce} />
              {record.changes?.length ? <ChangesSection changes={record.changes} /> : null}
              {hasDetails(record) ? <DetailsSection record={record} announce={announce} /> : null}
              <RawSection record={record} />
              <RecordSection record={record} canOpenCase={canOpenCase} canOpenSource={canOpenSource} announce={announce} />
              <RelatedSection record={record} relatedOpts={relatedOpts} canOpenCase={canOpenCase} onFollowRelated={onFollowRelated} />
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
