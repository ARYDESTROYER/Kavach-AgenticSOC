/**
 * The runbook's own fields (Round 14, SPEC §4.10.2, §4.10.12): the "Runbook details" item
 * at the top of the outline. Title, summary, use when, prerequisites, priority, owner,
 * review cadence, coverage techniques, retrieval queries and references. A new runbook
 * also picks its id here (derived from the title until it is edited).
 *
 * References render only through the one https-only link helper; a draft may hold any text
 * there, so a value that is not an https link shows as plain text (#9).
 */
import * as React from 'react';
import { Lock } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { RunbookDefinition } from '@/lib/types-runbooks';
import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';
import { TagInput } from '@/soc/components/TagInput';
import { Input } from '@/ui/input';
import { Textarea } from '@/ui/textarea';

import { RunbookExternalLink, safeHttpsUrl } from '../shared/links';
import { RESERVED_RUNBOOK_IDS, RUNBOOK_ID_PATTERN, RUNBOOK_LIMITS } from '../shared/labels';
import type { PlacedIssue } from './draft';
import { fieldDomId } from './fieldIds';

const TECHNIQUE_RE = /^T\d{4}(?:\.\d{3})?$/;

export interface DetailsFormProps {
  defn: RunbookDefinition;
  readOnly: boolean;
  /** A runbook that does not exist yet: its id can still change. */
  isNew: boolean;
  /** Header issues (already filtered to the ones to show). */
  issues: PlacedIssue[];
  onChange: (next: RunbookDefinition) => void;
  onTouch: (field: string) => void;
  /** The id was edited by hand, so the title no longer drives it. */
  onIdEdited?: () => void;
  className?: string;
}

function messages(issues: readonly PlacedIssue[], field: string): string[] {
  return issues
    .filter((i) => i.stepId === null && (i.field === field || i.field.startsWith(`${field}.`) || i.field.startsWith(`${field}[`)))
    .map((i) => i.message);
}

function Errors({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <>
      {list.map((m, i) => (
        <span key={i} className="block">
          {m}
        </span>
      ))}
    </>
  );
}

function Counter({ value, max }: { value: string | null | undefined; max: number }) {
  const length = (value ?? '').length;
  return (
    <span className={cn('text-xs tabular-nums', length > max ? 'text-critical-text' : 'text-muted-foreground')}>
      {length.toLocaleString()} of {max.toLocaleString()}
    </span>
  );
}

/** A client-side check of a new id, so a clash shows before the server is asked. */
export function runbookIdProblem(id: string): string | null {
  if (!id) return 'Give the runbook an id.';
  if (!RUNBOOK_ID_PATTERN.test(id)) {
    return 'Use lower case letters, digits, hyphens and underscores, starting with a letter or digit (at most 64).';
  }
  if (RESERVED_RUNBOOK_IDS.includes(id)) return `The id ${id} is reserved. Choose another.`;
  return null;
}

export function DetailsForm({ defn, readOnly, isNew, issues, onChange, onTouch, onIdEdited, className }: DetailsFormProps) {
  const set = (patch: Partial<RunbookDefinition>) => onChange({ ...defn, ...patch });
  const err = (field: string) => {
    const list = messages(issues, field);
    return list.length ? <Errors list={list} /> : undefined;
  };
  const id = (field: string) => fieldDomId(null, field);
  const idProblem = isNew ? runbookIdProblem(defn.id) : null;
  const tagErrors = (field: string) => messages(issues, field);

  if (readOnly) return <DetailsReadOnly defn={defn} className={className} />;

  return (
    <section
      aria-labelledby={id('heading')}
      className={cn('surface-panel min-w-0 space-y-5 p-4 xl:p-5 3xl:p-6', className)}
      data-details-form=""
    >
      <h2 id={id('heading')} className="text-md font-semibold text-foreground">
        Runbook details
      </h2>
      <div className="grid gap-4">
        <Field
          label="Title"
          required
          error={err('title')}
          labelAction={<Counter value={defn.title} max={RUNBOOK_LIMITS.title} />}
        >
          <Input
            id={id('title')}
            value={defn.title}
            onChange={(e) => set({ title: e.target.value })}
            onBlur={() => onTouch('title')}
            className="h-9"
          />
        </Field>
        {isNew ? (
          <Field
            label="Id"
            required
            description="Used in links and in the Markdown file. It cannot change once saved."
            error={err('id') ?? (idProblem && defn.title ? idProblem : undefined)}
          >
            <Input
              id={id('id')}
              value={defn.id}
              onChange={(e) => {
                onIdEdited?.();
                set({ id: e.target.value.toLowerCase().slice(0, 64) });
              }}
              onBlur={() => onTouch('id')}
              className="h-9 font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        ) : null}
        <Field
          label="Summary"
          required
          description="One line, shown in the library and the Start runbook picker."
          error={err('summary')}
          labelAction={<Counter value={defn.summary} max={RUNBOOK_LIMITS.summary} />}
        >
          <Textarea
            id={id('summary')}
            rows={2}
            value={defn.summary}
            onChange={(e) => set({ summary: e.target.value })}
            onBlur={() => onTouch('summary')}
          />
        </Field>
        <Field
          label="Use when"
          description="When an analyst should reach for this runbook. The investigator reads it."
          error={err('use_when')}
          labelAction={<Counter value={defn.use_when} max={RUNBOOK_LIMITS.useWhen} />}
        >
          <Textarea
            id={id('use_when')}
            rows={2}
            value={defn.use_when}
            onChange={(e) => set({ use_when: e.target.value })}
            onBlur={() => onTouch('use_when')}
          />
        </Field>
        <Field
          label="Prerequisites"
          description="What must be in place first, such as access or a ticket queue. For people only."
          error={err('prerequisites')}
        >
          <Textarea
            id={id('prerequisites')}
            rows={2}
            value={defn.prerequisites}
            onChange={(e) => set({ prerequisites: e.target.value })}
            onBlur={() => onTouch('prerequisites')}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2" data-rb-field={id('priority')}>
          <NumberField
            label="Priority"
            description="0 to 100. Breaks a tie between runbooks that match equally."
            value={defn.priority}
            min={0}
            max={100}
            onChange={(n) => set({ priority: n })}
            error={err('priority')}
          />
          <div data-rb-field={id('review_every_days')}>
            <NumberField
              label="Review every"
              unit="days"
              description={`${RUNBOOK_LIMITS.reviewMin} to ${RUNBOOK_LIMITS.reviewMax.toLocaleString()} days. The library shows when a review is due.`}
              value={defn.review_every_days}
              min={RUNBOOK_LIMITS.reviewMin}
              max={RUNBOOK_LIMITS.reviewMax}
              onChange={(n) => set({ review_every_days: n })}
              error={err('review_every_days')}
            />
          </div>
        </div>
        <Field label="Owner" description="The person who keeps this runbook current. Shown, never enforced." error={err('owner')}>
          <Input
            id={id('owner')}
            value={defn.owner ?? ''}
            onChange={(e) => set({ owner: e.target.value || null })}
            onBlur={() => onTouch('owner')}
            className="h-9"
            autoComplete="off"
          />
        </Field>
        <div data-rb-field={id('mitre')} className="space-y-1">
          <TagInput
            label="Covers techniques"
            description="ATT&CK techniques this runbook covers, for the coverage view. Matching uses Applies when."
            value={defn.mitre}
            onChange={(mitre) => set({ mitre })}
            max={RUNBOOK_LIMITS.mitre}
            validate={(t) => (TECHNIQUE_RE.test(t.trim().toUpperCase()) ? null : 'Use a technique id such as T1110 or T1110.003.')}
            placeholder="T1110"
          />
          {tagErrors('mitre').length ? (
            <p role="alert" className="text-xs font-medium text-critical-text">
              <Errors list={tagErrors('mitre')} />
            </p>
          ) : null}
        </div>
        <div data-rb-field={id('retrieval_queries')} className="space-y-1">
          <TagInput
            label="Search phrases"
            description="Up to five phrases that find this runbook in the knowledge search."
            value={defn.retrieval_queries}
            onChange={(retrieval_queries) => set({ retrieval_queries })}
            max={RUNBOOK_LIMITS.retrievalQueries}
            maxLength={200}
            delimiters={[]}
          />
          {tagErrors('retrieval_queries').length ? (
            <p role="alert" className="text-xs font-medium text-critical-text">
              <Errors list={tagErrors('retrieval_queries')} />
            </p>
          ) : null}
        </div>
        <div data-rb-field={id('references')} className="space-y-1">
          <TagInput
            label="References"
            description="Up to ten https links, such as a vendor advisory or an internal wiki page."
            value={defn.references}
            onChange={(references) => set({ references })}
            max={RUNBOOK_LIMITS.references}
            maxLength={500}
            delimiters={[' ']}
            validate={(t) => (safeHttpsUrl(t.trim()) ? null : 'Use an https link, such as https://attack.mitre.org/techniques/T1110/.')}
            placeholder="https://"
          />
          {tagErrors('references').length ? (
            <p role="alert" className="text-xs font-medium text-critical-text">
              <Errors list={tagErrors('references')} />
            </p>
          ) : null}
          {defn.references.length ? (
            <ul className="space-y-0.5 text-sm" aria-label="Reference links">
              {defn.references.map((ref, i) => (
                <li key={i} className="min-w-0 [overflow-wrap:anywhere]">
                  <RunbookExternalLink href={ref}>{ref}</RunbookExternalLink>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm text-foreground [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

export function DetailsReadOnly({ defn, className }: { defn: RunbookDefinition; className?: string }) {
  return (
    <section
      aria-label="Runbook details"
      className={cn('surface-panel min-w-0 space-y-4 p-4 xl:p-5 3xl:p-6', className)}
      data-details-read-only=""
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-semibold text-foreground">Runbook details</h2>
        <span className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground">
          <Lock className="size-3" aria-hidden />
          Read only
        </span>
      </div>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Row label="Id">
          <span className="font-mono text-xs">{defn.id}</span>
        </Row>
        {defn.summary ? <Row label="Summary">{defn.summary}</Row> : null}
        {defn.use_when ? <Row label="Use when">{defn.use_when}</Row> : null}
        {defn.prerequisites ? (
          <Row label="Prerequisites">
            <span className="whitespace-pre-wrap">{defn.prerequisites}</span>
          </Row>
        ) : null}
        <Row label="Priority">{defn.priority.toLocaleString()}</Row>
        <Row label="Review every">{`${defn.review_every_days.toLocaleString()} days`}</Row>
        {defn.owner ? <Row label="Owner">{defn.owner}</Row> : null}
        {defn.mitre.length ? <Row label="Covers techniques">{defn.mitre.join(', ')}</Row> : null}
        {defn.retrieval_queries.length ? <Row label="Search phrases">{defn.retrieval_queries.join('; ')}</Row> : null}
        {defn.references.length ? (
          <Row label="References">
            <ul className="space-y-0.5">
              {defn.references.map((ref, i) => (
                <li key={i}>
                  <RunbookExternalLink href={ref}>{ref}</RunbookExternalLink>
                </li>
              ))}
            </ul>
          </Row>
        ) : null}
      </dl>
    </section>
  );
}
