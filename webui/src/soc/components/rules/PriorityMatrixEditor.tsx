/**
 * PriorityMatrixEditor: the ITIL Impact × Urgency → Priority grid editor (G6 R6,
 * DESIGN_STANDARD §8). Writes `Preferences.priority_matrix` (a `PriorityMatrix`) via
 * deep-merge PUT.
 *
 * ADVISORY only (#3): a later wave derives `Case.priority_level` from
 * `impact_band × urgency_band` via this matrix; it NEVER changes the verdict or the
 * deterministic decision, never sets a case status, and never bills an LLM. Each grid
 * cell is a labelled Select (a11y); band labels are plain text (#9).
 *
 * CONTROLLED: `matrix` + `onChange`; the host owns dirty/save (StickySaveBar).
 *
 * `intro={false}` (Round 14, SPEC §4.9.6, D26): a host that already explains the matrix
 * (the Settings group caption) drops the standing "Priority is advisory" note, so the
 * explanation is said once and never as a permanent box.
 */
import { Info } from 'lucide-react';
import type { PriorityMatrix } from '@/lib/types';
import { humanizeToken } from '@/lib/format';

import { Switch } from '@/ui/switch';
import { Label } from '@/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';

/** The P-levels a cell may map to. */
const P_LEVELS = ['P1', 'P2', 'P3', 'P4'] as const;

const DEFAULT_LEVELS = ['high', 'medium', 'low'];

export interface PriorityMatrixEditorProps {
  matrix: PriorityMatrix;
  onChange: (next: PriorityMatrix) => void;
  disabled?: boolean;
  /**
   * Show the standing note that priority is advisory (default true). A host whose own
   * caption already says it passes `false`.
   */
  intro?: boolean;
}

export function PriorityMatrixEditor({ matrix, onChange, disabled, intro = true }: PriorityMatrixEditorProps) {
  const enabled = matrix.enabled ?? false;
  const levels = matrix.levels?.length ? matrix.levels : DEFAULT_LEVELS;
  const grid = matrix.matrix ?? {};
  const controlsDisabled = disabled || !enabled;

  const cellKey = (impact: string, urgency: string) => `${impact}/${urgency}`;
  const cellValue = (impact: string, urgency: string) =>
    grid[cellKey(impact, urgency)] ?? matrix.default_priority ?? 'P3';

  const setCell = (impact: string, urgency: string, level: string) => {
    onChange({
      ...matrix,
      matrix: { ...grid, [cellKey(impact, urgency)]: level },
    });
  };

  return (
    <div className="space-y-5">
      {intro ? (
        <Alert>
          <Info className="h-4 w-4" aria-hidden />
          <AlertTitle>Priority is advisory</AlertTitle>
          <AlertDescription>
            The derived priority drives sorting, SLA tiers, and reporting. It never
            changes a case&apos;s verdict or the deterministic decision.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center justify-between gap-4">
        <div className="space-y-0.5">
          <Label htmlFor="priority-enabled" className="text-sm font-medium">
            Enable priority derivation
          </Label>
          {/* Only what the host's caption ("Map every impact and urgency pair to a
              priority…") does not already say. */}
          <p className="text-xs text-muted-foreground">
            Off by default. When off, cases have no priority.
          </p>
        </div>
        <Switch
          id="priority-enabled"
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(v) => onChange({ ...matrix, enabled: v })}
        />
      </div>

      {/* The grid: rows = impact, columns = urgency. */}
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-1 text-sm">
          <caption className="sr-only">
            Impact by urgency priority matrix; each cell selects a priority level.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="px-2 py-1 text-left text-xs font-medium text-muted-foreground">
                <span aria-hidden="true">Impact ↓ / Urgency →</span>
                <span className="sr-only">Impact by urgency</span>
              </th>
              {levels.map((u) => (
                <th
                  key={u}
                  scope="col"
                  className="px-2 py-1 text-center text-xs font-medium text-foreground"
                >
                  {humanizeToken(u)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {levels.map((impact) => (
              <tr key={impact}>
                <th
                  scope="row"
                  className="whitespace-nowrap px-2 py-1 text-left text-xs font-medium text-foreground"
                >
                  {humanizeToken(impact)}
                </th>
                {levels.map((urgency) => {
                  const id = `pm-${impact}-${urgency}`;
                  return (
                    <td key={urgency} className="p-0">
                      <Select
                        value={cellValue(impact, urgency)}
                        disabled={controlsDisabled}
                        onValueChange={(v) => setCell(impact, urgency, v)}
                      >
                        <SelectTrigger
                          id={id}
                          aria-label={`Priority for ${humanizeToken(impact)} impact, ${humanizeToken(urgency)} urgency`}
                          className="h-8 min-w-[4.5rem] tabular-nums"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {P_LEVELS.map((p) => (
                            <SelectItem key={p} value={p}>
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Default fallback for an unmapped pair. */}
      <div className="max-w-xs">
        <Label htmlFor="priority-default" className="text-sm">
          Default priority
        </Label>
        <p className="mb-1.5 text-xs text-muted-foreground">
          Used for any impact/urgency pair not set above.
        </p>
        <Select
          value={matrix.default_priority ?? 'P3'}
          disabled={controlsDisabled}
          onValueChange={(v) => onChange({ ...matrix, default_priority: v })}
        >
          <SelectTrigger id="priority-default" className="tabular-nums">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {P_LEVELS.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

PriorityMatrixEditor.displayName = 'PriorityMatrixEditor';
