/**
 * SuppressionRuleBuilder: the operator field==value suppression-rule editor (G6 R6,
 * DESIGN_STANDARD §8, RESEARCH_RULES_UX §7). Writes `Preferences.suppression_rules`
 * (a `SuppressionRuleConfig[]`) via deep-merge PUT /api/settings.
 *
 * SEMANTICS (#4 non-destructive, honestly framed): a live suppression rule drops a
 * matching event BEFORE it becomes a candidate: this is the ONE rule family that can
 * hide events, so the copy is explicit and every rule carries provenance
 * (`created_by="operator"`) + an off-switch (`enabled`) + optional expiry. It is a
 * CONFIG WRITER only: it never calls `decide()`, never sets a case status, never bills
 * an LLM (#3/#6). Agent-DRAFTED suppression rules still flow through the Approvals /
 * Proposals queue; this builder authors operator rules directly and the settings write
 * path audits the change (#2).
 *
 * Every operator-authored `field`/`value`/`reason` renders as plain text (#9).
 *
 * CONTROLLED: `rules` + `onChange`; the host owns dirty/save (StickySaveBar) and any
 * ConfirmDialog on delete of a live rule.
 *
 * Round 14 (SPEC §4.9.6): each rule is a hairline-divided row on its host's panel, like
 * the declarations in `AnalystPolicyBuilder` beside it (no bordered box per rule).
 * `intro={false}` drops the standing warning for a host whose caption already says it
 * (the Settings group), so the explanation is said once and never as a permanent box.
 */
import { Ban, Bot, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { SuppressionRuleConfig } from '@/lib/types';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Field } from '@/soc/components/Field';
import { IconButton } from '@/soc/components/IconButton';
import { EmptyState } from '@/soc/components/EmptyState';

export interface SuppressionRuleBuilderProps {
  rules: SuppressionRuleConfig[];
  onChange: (next: SuppressionRuleConfig[]) => void;
  /** Called instead of a direct remove for a LIVE rule (host shows a ConfirmDialog). */
  onRequestRemove?: (index: number, rule: SuppressionRuleConfig) => void;
  disabled?: boolean;
  /**
   * Show the standing warning that suppression drops events before triage (default
   * true). A host whose own caption already says it passes `false`.
   */
  intro?: boolean;
}

/** A new, operator-authored suppression rule (provenance stamped). */
function newRule(): SuppressionRuleConfig {
  return { field: '', value: '', reason: '', enabled: true, created_by: 'operator', confidence: 1 };
}

function SuppressionRow({
  rule,
  onChange,
  onRemove,
  disabled,
}: {
  rule: SuppressionRuleConfig;
  onChange: (next: SuppressionRuleConfig) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const isAgent = (rule.created_by ?? '') === 'agent';
  const enabled = rule.enabled ?? true;
  const field = rule.field.trim();
  return (
    <li className="space-y-3 py-4 first:pt-0 last:pb-0" data-suppression-rule="">
      <div className="flex items-center justify-between gap-2">
        {/* The glyph stays beside the text at every width; only the badges wrap. */}
        <div className="flex min-w-0 items-start gap-2">
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 text-sm font-medium text-foreground">Drop matching events</span>
            {isAgent ? (
              <Badge variant="secondary" className="gap-1">
                <Bot className="h-3 w-3" aria-hidden />
                Drafted by the agent
              </Badge>
            ) : null}
            {!enabled ? <Badge variant="outline">Off</Badge> : null}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden>Enabled</span>
            <Switch
              checked={enabled}
              disabled={disabled}
              aria-label={field ? `Suppression rule for ${field} enabled` : 'Suppression rule enabled'}
              onCheckedChange={(v) => onChange({ ...rule, enabled: v })}
            />
          </span>
          <IconButton
            label="Remove suppression rule"
            size="md"
            variant="ghost"
            disabled={disabled}
            onClick={onRemove}
            className="text-muted-foreground hover:text-critical-text"
          >
            <Trash2 />
          </IconButton>
        </div>
      </div>

      {/* Visible labels, as on the declarations beside these rows: a placeholder is not a
          label (WCAG 3.3.2), and each field's name is its label (2.5.3). "equals" sits on
          the inputs' line, under the labels. */}
      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
        <Field label="Field">
          <Input
            value={rule.field}
            disabled={disabled}
            placeholder="rule.name, source.ip or user.name"
            onChange={(e) => onChange({ ...rule, field: e.target.value })}
            className="font-mono text-sm"
          />
        </Field>
        <span
          className="flex text-xs font-medium text-muted-foreground sm:h-9 sm:items-center sm:justify-center"
          aria-hidden
        >
          equals
        </span>
        <Field label="Value">
          <Input
            value={rule.value}
            disabled={disabled}
            placeholder="Exact value to match"
            onChange={(e) => onChange({ ...rule, value: e.target.value })}
            className="font-mono text-sm"
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Reason">
          <Input
            value={rule.reason ?? ''}
            disabled={disabled}
            placeholder="For example, a known scanner"
            onChange={(e) => onChange({ ...rule, reason: e.target.value })}
          />
        </Field>
        <Field label="Expires (optional)">
          <Input
            type="date"
            value={(rule.expires_at ?? '').slice(0, 10)}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...rule,
                expires_at: e.target.value ? `${e.target.value}T00:00:00Z` : null,
              })
            }
          />
        </Field>
      </div>

      {rule.rationale ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Rationale: </span>
          {rule.rationale}
        </p>
      ) : null}
      {(rule.created_by ?? '') ? (
        <p className="text-xs text-muted-foreground">
          {/* The stored author as it is (a username keeps its case), as the declarations
              beside these rows say "Declared by operator". */}
          Created by {rule.created_by}
        </p>
      ) : null}
    </li>
  );
}

export function SuppressionRuleBuilder({
  rules,
  onChange,
  onRequestRemove,
  disabled,
  intro = true,
}: SuppressionRuleBuilderProps) {
  const remove = (i: number) => {
    const rule = rules[i];
    // A LIVE (enabled) rule can silently hide events: route through the host's
    // ConfirmDialog when one is provided; otherwise remove directly.
    if ((rule?.enabled ?? true) && onRequestRemove) {
      onRequestRemove(i, rule);
      return;
    }
    onChange(rules.filter((_, idx) => idx !== i));
  };

  return (
    <div className="space-y-4">
      {intro ? (
        <Alert variant="warning">
          <TriangleAlert className="h-4 w-4" aria-hidden />
          <AlertTitle>Suppression drops events before triage</AlertTitle>
          <AlertDescription>
            A matching event is dropped and never becomes a candidate. Suppression can
            silently hide true positives if the match is too broad, so keep rules narrow,
            set an expiry where you can, and prefer turning a rule off over deleting it.
            The decision engine is untouched: this only controls what reaches it.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <p className="text-sm tabular-nums text-muted-foreground">
          {rules.length.toLocaleString()} suppression rule{rules.length === 1 ? '' : 's'}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...rules, newRule()])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
          Add rule
        </Button>
      </div>

      {rules.length ? (
        <ul className="divide-y divide-border/70" aria-label="Suppression rules">
          {rules.map((rule, i) => (
            <SuppressionRow
              key={i}
              rule={rule}
              disabled={disabled}
              onChange={(nx) => onChange(rules.map((r, idx) => (idx === i ? nx : r)))}
              onRemove={() => remove(i)}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          compact
          icon={Ban}
          title="No suppression rules"
          description="Add a rule to drop a known-benign event pattern before it becomes a case."
        />
      )}
    </div>
  );
}

SuppressionRuleBuilder.displayName = 'SuppressionRuleBuilder';
