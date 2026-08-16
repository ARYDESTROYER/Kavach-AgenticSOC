/**
 * AnalystPolicyBuilder — the operator's rule-level "declared benign" editor. Writes
 * `Preferences.analyst_rule_policies` (an `AnalystRulePolicyConfig[]`) via the same
 * deep-merge `PUT /api/settings` path every other settings editor uses.
 *
 * WHY THIS EXISTS. For a detection whose alerts carry no per-case evidence — no request,
 * payload, URI or response code — an investigation can never verify that a given instance
 * is benign, so it routes to a human every time no matter how many prior cases an analyst
 * has confirmed. Confirming more cannot move an evidence-sufficiency judgement. A
 * declaration is the exit: the operator states the fact once, at the rule level.
 *
 * SEMANTICS (deliberately different from suppression, and the copy says so): a matching
 * cluster still becomes a VISIBLE, audited, reopenable case — it is CLOSED, not dropped
 * before it exists. That is the whole difference from `SuppressionRuleBuilder`, and it is
 * why the volume stays countable. It is a CONFIG WRITER only: it never calls `decide()`,
 * never sets a case status from the browser, never bills an LLM (#3/#6).
 *
 * THE HONEST WARNING. A declaration closes matching alerts with no model call and no
 * human, so a genuine attack matching a declared rule closes silently. The card says that
 * in those words, offers the risk ceiling as the bound, and points at the per-case
 * override (reinvestigate) that always remains.
 *
 * Every operator-authored `rule_id` / `reason` renders as plain text (#9).
 *
 * CONTROLLED: `policies` + `onChange`; the host owns dirty/save and the delete confirm.
 */
import { Bot, Gavel, Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { AnalystRulePolicyConfig } from '@/lib/types';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Switch } from '@/ui/switch';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Field } from '@/soc/components/Field';
import { IconButton } from '@/soc/components/IconButton';
import { EmptyState } from '@/soc/components/EmptyState';

export interface AnalystPolicyBuilderProps {
  policies: AnalystRulePolicyConfig[];
  onChange: (next: AnalystRulePolicyConfig[]) => void;
  /** Called instead of a direct remove for a LIVE declaration (host shows a dialog). */
  onRequestRemove?: (index: number, policy: AnalystRulePolicyConfig) => void;
  disabled?: boolean;
}

/** A new, operator-authored declaration. `id` is minted server-side on save. */
function newPolicy(): AnalystRulePolicyConfig {
  return { id: '', rule_id: '', reason: '', enabled: true, source_id: null, created_by: 'operator' };
}

/** True when a declaration is currently closing cases (enabled and not expired). */
export function isLiveDeclaration(policy: AnalystRulePolicyConfig): boolean {
  if (!(policy.enabled ?? true)) return false;
  const expiry = policy.expires_at;
  if (!expiry) return true;
  const ms = Date.parse(expiry);
  return Number.isNaN(ms) ? true : ms > Date.now();
}

function PolicyRow({
  policy,
  onChange,
  onRemove,
  disabled,
}: {
  policy: AnalystRulePolicyConfig;
  onChange: (next: AnalystRulePolicyConfig) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const enabled = policy.enabled ?? true;
  const live = isLiveDeclaration(policy);
  const isAgent = (policy.created_by ?? '') === 'agent';
  return (
    <div className="space-y-3 rounded-md border border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Gavel className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="text-xs font-medium text-muted-foreground">
            Close matching cases without a model call
          </span>
          {isAgent ? (
            <Badge variant="secondary" className="gap-1">
              <Bot className="h-3 w-3" aria-hidden />
              agent-drafted
            </Badge>
          ) : null}
          {!enabled ? <Badge variant="outline">disabled</Badge> : null}
          {/* Enabled but past its expiry: the row looks active and is not. Say so. */}
          {enabled && !live ? <Badge variant="outline">expired</Badge> : null}
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden>Enabled</span>
            <Switch
              checked={enabled}
              disabled={disabled}
              aria-label={`Declaration ${enabled ? 'enabled' : 'disabled'} — toggle`}
              onCheckedChange={(v) => onChange({ ...policy, enabled: v })}
            />
          </span>
          <IconButton
            label="Remove declaration"
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

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Detection rule" description="Every rule on a cluster must be declared before it closes.">
          <Input
            value={policy.rule_id ?? ''}
            disabled={disabled}
            placeholder="web_shell_php"
            aria-label="Detection rule declared benign"
            onChange={(e) => onChange({ ...policy, rule_id: e.target.value })}
            className="font-mono text-sm"
          />
        </Field>
        <Field label="Reason" description="Recorded with the close and in the audit trail.">
          <Input
            value={policy.reason ?? ''}
            disabled={disabled}
            placeholder="Internal PHP CI runner — no request context in these alerts"
            aria-label="Why this detection is benign here"
            onChange={(e) => onChange({ ...policy, reason: e.target.value })}
          />
        </Field>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Source (optional)" description="Blank applies to every source.">
          <Input
            value={policy.source_id ?? ''}
            disabled={disabled}
            placeholder="all sources"
            aria-label="Limit this declaration to one source"
            onChange={(e) => onChange({ ...policy, source_id: e.target.value || null })}
            className="font-mono text-sm"
          />
        </Field>
        <Field
          label="Max risk (optional)"
          description="Above this score the case is investigated instead of closed."
        >
          <Input
            type="number"
            min={0}
            max={100}
            value={policy.max_risk_score == null ? '' : String(policy.max_risk_score)}
            disabled={disabled}
            placeholder="no ceiling"
            aria-label="Risk ceiling above which this declaration does not apply"
            onChange={(e) =>
              onChange({
                ...policy,
                max_risk_score: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </Field>
        <Field label="Expires (optional)" description="Blank never expires.">
          <Input
            type="date"
            value={(policy.expires_at ?? '').slice(0, 10)}
            disabled={disabled}
            aria-label="Expiry date (optional)"
            onChange={(e) =>
              onChange({
                ...policy,
                expires_at: e.target.value ? `${e.target.value}T00:00:00Z` : null,
              })
            }
          />
        </Field>
      </div>

      {policy.created_by ? (
        <p className="text-2xs text-muted-foreground">
          Declared by {policy.created_by}
          {policy.created_at ? ` on ${policy.created_at.slice(0, 10)}` : ''}
        </p>
      ) : null}
    </div>
  );
}

export function AnalystPolicyBuilder({
  policies,
  onChange,
  onRequestRemove,
  disabled,
}: AnalystPolicyBuilderProps) {
  const remove = (i: number) => {
    const policy = policies[i];
    if (policy && isLiveDeclaration(policy) && onRequestRemove) {
      onRequestRemove(i, policy);
      return;
    }
    onChange(policies.filter((_, idx) => idx !== i));
  };

  const liveCount = policies.filter(isLiveDeclaration).length;

  return (
    <div className="space-y-4">
      <Alert variant="warning">
        <TriangleAlert className="h-4 w-4" aria-hidden />
        <AlertTitle>A declaration closes matching alerts with no model call and no human</AlertTitle>
        <AlertDescription>
          A genuine attack matching a declared rule closes silently. Use this only where
          the alerts genuinely cannot carry the evidence an investigation needs — enrich
          the source first if they can. Set a risk ceiling so an unusually high-scoring
          instance is still investigated, scope the declaration to one source where you
          can, and prefer disabling over deleting. Cases stay visible and reopenable, and
          reinvestigating one always overrides the declaration for that case.
        </AlertDescription>
      </Alert>

      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {policies.length} declaration{policies.length === 1 ? '' : 's'}
          {policies.length ? ` · ${liveCount} live` : ''}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => onChange([...policies, newPolicy()])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
          Declare a rule benign
        </Button>
      </div>

      {policies.length ? (
        <div className="space-y-3">
          {policies.map((policy, i) => (
            <PolicyRow
              key={policy.id || i}
              policy={policy}
              disabled={disabled}
              onChange={(nx) => onChange(policies.map((p, idx) => (idx === i ? nx : p)))}
              onRemove={() => remove(i)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          compact
          icon={Gavel}
          title="No declarations"
          description="Declare a detection benign only when its alerts cannot carry the evidence an investigation needs — confirming more of its cases will not change the outcome."
        />
      )}
    </div>
  );
}

AnalystPolicyBuilder.displayName = 'AnalystPolicyBuilder';
