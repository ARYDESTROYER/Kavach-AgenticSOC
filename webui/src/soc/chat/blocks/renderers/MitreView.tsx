/**
 * `mitre` block (BLOCKS.md `mitre`). Names and tactics are resolved by the server from
 * the bundled ATT&CK corpus, never by the model.
 *
 * - With counts: the extracted `MitreHeatmap` (tactic columns, viridis magnitude, its own
 *   sr-only table). A technique whose count is `null` is NOT drawn as 0 (G3): it is listed
 *   under "Not counted" instead.
 * - Without counts: chips grouped by tactic.
 *
 * The ATT&CK link is the ONLY external URL in the chat, and it is CONSTRUCTED here from
 * an id that matched `^T\d{4}(\.\d{3})?$` — it is never passed in from data.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';
import { MitreHeatmap, type MitreTacticColumn } from '@/soc/components/MitreHeatmap';

import type { MitreBlock, MitreTechnique } from '../schema';
import { PATTERN_SOURCES } from '../schema';

const TECHNIQUE_RE = new RegExp(PATTERN_SOURCES.technique);
const UNASSIGNED = 'Other';

/** The ATT&CK page for a VALIDATED technique id, else null. */
export function attackUrl(id: string): string | null {
  if (!TECHNIQUE_RE.test(id)) return null;
  const [base, sub] = id.split('.');
  return `https://attack.mitre.org/techniques/${base}/${sub ? `${sub}/` : ''}`;
}

function byTactic(techniques: readonly MitreTechnique[]): Array<[string, MitreTechnique[]]> {
  const groups = new Map<string, MitreTechnique[]>();
  for (const t of techniques) {
    const k = t.tactic ?? UNASSIGNED;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return Array.from(groups.entries());
}

function TechniqueChip({ t }: { t: MitreTechnique }) {
  const url = attackUrl(t.id);
  const body = (
    <>
      <span className="font-mono text-2xs">{t.id}</span>
      {t.name ? <span className="min-w-0 truncate">{t.name}</span> : null}
    </>
  );
  const cls = 'inline-flex max-w-full items-center gap-1.5 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-xs';
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(cls, 'text-foreground hover:bg-muted', focusRing)}
      aria-label={`${t.id}${t.name ? ` ${t.name}` : ''} on MITRE ATT&CK (opens in a new tab)`}
    >
      {body}
    </a>
  ) : (
    <span className={cls}>{body}</span>
  );
}

export function MitreView({ block, title }: { block: MitreBlock; title: string }) {
  const counted = block.techniques.filter((t) => typeof t.count === 'number');
  const uncounted = block.techniques.filter((t) => typeof t.count !== 'number');

  if (!block.techniques.length) return <p className="text-sm text-muted-foreground">No techniques.</p>;

  if (counted.length) {
    const columns: MitreTacticColumn[] = byTactic(counted).map(([tactic, ts]) => ({
      tactic,
      label: tactic,
      cells: ts
        .slice()
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
        .map((t) => ({ technique: t.id, name: t.name, value: t.count as number })),
    }));
    return (
      <div className="min-w-0" data-testid="block-mitre-heatmap">
        <MitreHeatmap columns={columns} ariaLabel={title} />
        {uncounted.length ? (
          <div className="mt-2">
            <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Not counted</p>
            <ul className="flex flex-wrap gap-1.5">
              {uncounted.map((t, i) => (
                <li key={`${t.id}-${i}`} className="min-w-0 max-w-full">
                  <TechniqueChip t={t} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="block-mitre-chips">
      {byTactic(block.techniques).map(([tactic, ts]) => (
        // A plain div: blocks never contribute sections/landmarks to the transcript.
        <div key={tactic} className="min-w-0">
          <h5 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{tactic}</h5>
          <ul className="flex flex-wrap gap-1.5">
            {ts.map((t, i) => (
              <li key={`${t.id}-${i}`} className="min-w-0 max-w-full">
                <TechniqueChip t={t} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default React.memo(MitreView);
