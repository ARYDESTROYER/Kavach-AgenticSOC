/**
 * AssetCriticalityEditor — the internal-asset criticality editor (G6 R6,
 * DESIGN_STANDARD §8). Two config writers, both saved via deep-merge PUT /api/settings:
 *
 *   - `asset_networks: AssetNetwork[]`  — CIDR ranges; every IP inside inherits a
 *     0..100 criticality (max wins) in the deterministic risk score's
 *     asset-criticality component.
 *   - `asset_criticality: Record<string, number>` — an exact entity-value → 0..100
 *     map (higher precedence where an exact match exists).
 *
 * This is a CONFIG WRITER only: it edits `Preferences` blocks the deterministic risk
 * model already reads; it NEVER touches `decide()`, never sets a case status, and never
 * bills an LLM (#3/#6). Every operator-authored `cidr` / entity value renders as plain
 * text (#9); higher criticality only raises risk, it never auto-closes anything.
 *
 * The component is CONTROLLED (`networks`/`exact` + `onChange`) so the host owns the
 * dirty/save lifecycle (StickySaveBar). All controls are `Field`/label-wrapped (a11y).
 */
import * as React from 'react';
import { Plus, Server, Trash2 } from 'lucide-react';
import type { AssetNetwork, AssetCriticalityMap } from '@/lib/types';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Field } from '@/soc/components/Field';
import { NumberField } from '@/soc/components/NumberField';
import { IconButton } from '@/soc/components/IconButton';
import { EmptyState } from '@/soc/components/EmptyState';

/**
 * A permissive IPv4/IPv6 CIDR sniff: enough to reject an obviously-malformed entry in
 * the UI (the backend Pydantic model is authoritative). Returns an error string or null.
 */
export function validateCidr(raw: string): string | null {
  const s = raw.trim();
  if (!s) return 'Enter a CIDR range.';
  const slash = s.indexOf('/');
  if (slash < 0) return 'Include a prefix length, for example 10.0.0.0/8.';
  const addr = s.slice(0, slash);
  const prefix = s.slice(slash + 1);
  const prefixNum = Number(prefix);
  if (!/^\d+$/.test(prefix) || Number.isNaN(prefixNum)) return 'Prefix length must be a number.';
  const isV6 = addr.includes(':');
  if (isV6) {
    if (prefixNum < 0 || prefixNum > 128) return 'IPv6 prefix must be 0 to 128.';
    if (!/^[0-9a-fA-F:]+$/.test(addr)) return 'Not a valid IPv6 address.';
    return null;
  }
  const octets = addr.split('.');
  if (octets.length !== 4) return 'Not a valid IPv4 address.';
  for (const o of octets) {
    if (!/^\d+$/.test(o) || Number(o) > 255) return 'Each IPv4 octet must be 0 to 255.';
  }
  if (prefixNum < 0 || prefixNum > 32) return 'IPv4 prefix must be 0 to 32.';
  return null;
}

export interface AssetCriticalityEditorProps {
  /** CIDR networks (controlled). */
  networks: AssetNetwork[];
  onNetworksChange: (next: AssetNetwork[]) => void;
  /** Exact entity-value → criticality map (controlled). */
  exact: AssetCriticalityMap;
  onExactChange: (next: AssetCriticalityMap) => void;
  disabled?: boolean;
}

/** One editable exact-value pair (may hold a transient empty entity mid-edit). */
interface ExactPair {
  entity: string;
  score: number;
}

/** Map → ordered editable pair list (preserves the map's own key order). */
function toPairs(map: AssetCriticalityMap | undefined): ExactPair[] {
  return Object.entries(map ?? {}).map(([entity, v]) => ({ entity, score: Number(v) || 0 }));
}

/** Fold a pair list → the wire map, DROPPING empty-entity (in-progress) rows. */
function foldPairs(pairs: ExactPair[]): AssetCriticalityMap {
  const next: AssetCriticalityMap = {};
  for (const p of pairs) {
    const k = p.entity.trim();
    if (k) next[k] = p.score;
  }
  return next;
}

/** Shallow key+value equality for two criticality maps. */
function sameMap(a: AssetCriticalityMap, b: AssetCriticalityMap): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => b[k] === a[k]);
}

/** One editable CIDR row: cidr text + a 0..100 criticality NumberField + remove. */
function NetworkRow({
  net,
  onChange,
  onRemove,
  disabled,
}: {
  net: AssetNetwork;
  onChange: (next: AssetNetwork) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const err = net.cidr ? validateCidr(net.cidr) : null;
  return (
    <div className="flex items-start gap-2">
      <div className="flex-1">
        <Field label="CIDR" hideLabel error={err ?? undefined}>
          <Input
            value={net.cidr}
            disabled={disabled}
            placeholder="10.0.0.0/8"
            aria-label="Network CIDR"
            onChange={(e) => onChange({ ...net, cidr: e.target.value })}
            className="font-mono text-sm"
          />
        </Field>
      </div>
      <div className="w-40 shrink-0">
        <NumberField
          label="Criticality"
          value={net.criticality ?? 0}
          min={0}
          max={100}
          disabled={disabled}
          onChange={(v) => onChange({ ...net, criticality: v })}
        />
      </div>
      <IconButton
        label="Remove network"
        size="md"
        variant="ghost"
        disabled={disabled}
        onClick={onRemove}
        className="mt-1 text-muted-foreground hover:text-critical-text"
      >
        <Trash2 />
      </IconButton>
    </div>
  );
}

/** One exact-value row: entity value + a 0..100 criticality + remove. */
function ExactRow({
  entity,
  score,
  onValueChange,
  onScoreChange,
  onRemove,
  disabled,
}: {
  entity: string;
  score: number;
  onValueChange: (next: string) => void;
  onScoreChange: (next: number) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex-1">
        <Field label="Entity value" hideLabel>
          <Input
            value={entity}
            disabled={disabled}
            placeholder="host: db-prod-01 / user: svc_backup / 10.0.0.5"
            aria-label="Asset entity value"
            onChange={(e) => onValueChange(e.target.value)}
            className="font-mono text-sm"
          />
        </Field>
      </div>
      <div className="w-40 shrink-0">
        <NumberField
          label="Criticality"
          value={score}
          min={0}
          max={100}
          disabled={disabled}
          onChange={onScoreChange}
        />
      </div>
      <IconButton
        label="Remove asset"
        size="md"
        variant="ghost"
        disabled={disabled}
        onClick={onRemove}
        className="mt-1 text-muted-foreground hover:text-critical-text"
      >
        <Trash2 />
      </IconButton>
    </div>
  );
}

export function AssetCriticalityEditor({
  networks,
  onNetworksChange,
  exact,
  onExactChange,
  disabled,
}: AssetCriticalityEditorProps) {
  // The exact map is edited as an ordered pair list held in LOCAL state (not derived
  // purely from the `exact` prop), so an in-progress empty row survives long enough to
  // type into; otherwise "Add asset" is a no-op and clearing an entity to retype it
  // instantly deletes the row (#34). We fold non-empty rows back to the wire map on every
  // edit, and only resync from the prop on an EXTERNAL change (load/reset).
  const [pairs, setPairs] = React.useState<ExactPair[]>(() => toPairs(exact));

  React.useEffect(() => {
    const incoming = exact ?? {};
    setPairs((cur) => (sameMap(incoming, foldPairs(cur)) ? cur : toPairs(incoming)));
  }, [exact]);

  /** Update local rows AND emit the folded wire map (drops empty rows). */
  const commitPairs = (next: ExactPair[]) => {
    setPairs(next);
    onExactChange(foldPairs(next));
  };

  return (
    <div className="space-y-6">
      {/* CIDR networks */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-0.5">
            <h4 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              <Server className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              Asset networks (CIDR)
            </h4>
            <p className="text-xs text-muted-foreground">
              Every IP inside a range inherits its criticality (0 to 100), and the highest
              matching range wins. It raises the deterministic risk score only and never
              closes or escalates a case.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => onNetworksChange([...networks, { cidr: '', criticality: 50 }])}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            Add network
          </Button>
        </div>
        {networks.length ? (
          <div className="space-y-2">
            {networks.map((net, i) => (
              <NetworkRow
                key={i}
                net={net}
                disabled={disabled}
                onChange={(nx) => onNetworksChange(networks.map((n, idx) => (idx === i ? nx : n)))}
                onRemove={() => onNetworksChange(networks.filter((_, idx) => idx !== i))}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            icon={Server}
            title="No asset networks"
            description="Add a CIDR range to mark a subnet (for example, your crown-jewel servers) as high-criticality."
          />
        )}
      </section>

      {/* Exact-value map */}
      <section className="space-y-3 border-t border-border pt-5">
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-0.5">
            <h4 className="text-sm font-medium text-foreground">Exact assets</h4>
            <p className="text-xs text-muted-foreground">
              Give an exact entity value (a host, user or IP) its own criticality. It takes
              precedence over the CIDR-derived value where an exact match exists.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            // Push a real, renderable empty row (local state); do NOT fold it away, or the
            // button appears to do nothing (#34). It joins the wire map once an entity is typed.
            onClick={() => setPairs((cur) => [...cur, { entity: '', score: 50 }])}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            Add asset
          </Button>
        </div>
        {pairs.length ? (
          <div className="space-y-2">
            {pairs.map((p, i) => (
              <ExactRow
                key={i}
                entity={p.entity}
                score={p.score}
                disabled={disabled}
                onValueChange={(v) =>
                  commitPairs(pairs.map((x, idx) => (idx === i ? { ...x, entity: v } : x)))
                }
                onScoreChange={(v) =>
                  commitPairs(pairs.map((x, idx) => (idx === i ? { ...x, score: v } : x)))
                }
                onRemove={() => commitPairs(pairs.filter((_, idx) => idx !== i))}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            compact
            icon={Server}
            title="No exact assets"
            description="Pin a specific host/user/IP to a criticality that overrides the CIDR default."
          />
        )}
      </section>
    </div>
  );
}

AssetCriticalityEditor.displayName = 'AssetCriticalityEditor';
