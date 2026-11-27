/**
 * Cases (case number format) settings section (Round-5 Sett-A decomposition; Round 14
 * grouped panels).
 *
 * A template editor, the placeholder tokens and a LIVE PREVIEW (debounced POST
 * /api/settings/case-id/preview).
 * `Case.case_id` stays the immutable internal id; this only governs the optional
 * `case_number` display id. The preview error text is from the backend validator
 * (controlled) but still rendered as plain text.
 */
import * as React from 'react';

import { api } from '@/lib/api';

import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { LoadingGlyph } from '@/design-system';

import { NumPref, SettingRow, SettingsGroup, SettingsSection, TextPref, type SecProps } from './primitives';

const RESET_PERIOD_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'none', label: 'Never (one sequence)' },
  { value: 'calendar_year', label: 'Each calendar year' },
  { value: 'fiscal_year', label: 'Each fiscal year (April start)' },
  { value: 'fiscal_quarter', label: 'Each fiscal quarter' },
];

const CASE_ID_PLACEHOLDERS: Array<{ token: string; desc: string }> = [
  { token: '{prefix}', desc: 'The configured prefix' },
  { token: '{seq}', desc: 'The next sequence number' },
  { token: '{seq:06d}', desc: 'Zero-padded sequence (width 6)' },
  { token: '{year}', desc: '4-digit year' },
  { token: '{yy}', desc: '2-digit year' },
  { token: '{mm}', desc: '2-digit month' },
  { token: '{dd}', desc: '2-digit day' },
  { token: '{source}', desc: 'Originating source (slug)' },
  { token: '{verdict}', desc: 'LLM verdict (lower-case)' },
];

export function CaseIdSection({ prefs, update }: SecProps) {
  const cfg = prefs.case_id_format || {
    enabled: false,
    template: 'CASE-{seq:06d}',
    prefix: 'CASE',
    reset_period: 'none' as const,
    seq_start: 1,
  };
  const set = (patch: Partial<typeof cfg>) =>
    update({ case_id_format: { ...cfg, ...patch } });

  const [preview, setPreview] = React.useState<{
    samples: string[];
    valid: boolean;
    error?: string;
  } | null>(null);
  const [previewing, setPreviewing] = React.useState(false);

  // Debounced live preview whenever the template / prefix / seq_start change.
  React.useEffect(() => {
    let cancelled = false;
    setPreviewing(true);
    const t = setTimeout(() => {
      void api
        .caseIdPreview({
          template: cfg.template || '',
          prefix: cfg.prefix || 'CASE',
          seq_start: typeof cfg.seq_start === 'number' ? cfg.seq_start : 1,
        })
        .then((res) => {
          if (!cancelled) setPreview(res);
        })
        .catch(() => {
          if (!cancelled) setPreview({ samples: [], valid: false, error: 'The preview could not be loaded.' });
        })
        .finally(() => {
          if (!cancelled) setPreviewing(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cfg.template, cfg.prefix, cfg.seq_start]);

  return (
    <SettingsSection title="Cases">
      <SettingsGroup title="Case number format" caption="Applies to new cases.">
        <SettingRow
          variant="switch"
          label="Use a custom case number format"
          help="When off, the Console shows the internal case id. When on, new cases get a number in this format."
          checked={Boolean(cfg.enabled)}
          onCheckedChange={(v) => set({ enabled: v })}
        />
        <SettingRow variant="field" controlWidth="16rem" mono>
          <TextPref
            label="Template"
            value={cfg.template}
            placeholder="CASE-{seq:06d}"
            help="Use the placeholders below. An unknown placeholder is refused."
            onChange={(v) => set({ template: v })}
          />
        </SettingRow>
        <SettingRow variant="field" controlWidth="16rem" mono>
          <TextPref label="Prefix" value={cfg.prefix} placeholder="CASE" onChange={(v) => set({ prefix: v })} />
        </SettingRow>
        <SettingRow
          variant="select"
          label="Reset the sequence"
          help="Start a fresh sequence at each boundary."
          value={cfg.reset_period || 'none'}
          options={RESET_PERIOD_OPTIONS}
          onValueChange={(v) => set({ reset_period: v as typeof cfg.reset_period })}
        />
        <SettingRow variant="field" controlWidth="8rem">
          <NumPref label="Sequence start" value={cfg.seq_start} min={0} onChange={(v) => set({ seq_start: v })} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Placeholders" caption="Add a supported token to the end of the template.">
        <SettingRow variant="block">
          <div className="flex flex-wrap gap-1.5">
            {CASE_ID_PLACEHOLDERS.map((p) => (
              <Button
                key={p.token}
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Add ${p.token}: ${p.desc}`}
                title={p.desc}
                className="h-7 font-mono text-xs font-normal text-muted-foreground hover:text-foreground"
                onClick={() => set({ template: `${cfg.template || ''}${p.token}` })}
              >
                {p.token}
              </Button>
            ))}
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Preview"
        action={
          previewing ? (
            <span role="status" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <LoadingGlyph size="sm" className="size-4" />
              Updating
            </span>
          ) : null
        }
      >
        <SettingRow variant="block">
          {preview && !preview.valid ? (
            // The error text is from the backend validator: controlled, but rendered plain.
            <p role="alert" className="text-sm font-medium text-critical-text">
              {preview.error || 'This template is not valid.'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {(preview?.samples || []).map((s, i) => (
                <Badge key={`${s}-${i}`} variant="outline" className="font-mono">
                  {s}
                </Badge>
              ))}
              {!preview?.samples?.length && !previewing ? (
                <span className="text-sm text-muted-foreground">No preview.</span>
              ) : null}
            </div>
          )}
        </SettingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
