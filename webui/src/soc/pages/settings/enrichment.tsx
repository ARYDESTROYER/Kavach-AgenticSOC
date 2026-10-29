/**
 * Enrichment settings section (Round-5 Sett-A decomposition; Round-6 clobber fix; Round 14
 * grouped panels).
 *
 * The self-contained provider catalog editor manages the WHOLE `enrichment` config
 * lifecycle via IMMEDIATE settings PUTs (master enable/fusion + per-provider toggles +
 * write-only secrets). The Cache TTL below rides the SAME immediate-PUT path.
 *
 * Round-6: the former section-level buffered "Enrichment enabled" SwitchPref + Cache-TTL
 * NumPref were removed. They duplicated the embedded editor's own master switch (two
 * "Enrichment enabled" toggles in one section) AND, because the buffered page-save
 * re-sends the FULL mount-time `enrichment` block, they silently reverted provider
 * toggles the operator had flipped via the embedded editor's immediate PUTs. Owning no
 * page-dirty keys (see settings-sections-meta) means the page save can never clobber
 * this section again.
 */

import * as React from 'react';
import { toast } from 'sonner';

import { SettingRow, SettingsGroup, SettingsSection, type SecProps } from './primitives';
import { EnrichmentProvidersEditor } from '@/soc/components/EnrichmentProvidersEditor';
import { enrichmentApi } from '@/soc/components/EnrichmentProviders.api';
import { NumberField } from '@/soc/components/NumberField';
import { useCan } from '@/soc/components/Can';
import { durationReading, withReading } from './duration';

export function EnrichmentSection({ prefs }: SecProps) {
  const canManage = useCan('enrichment', 'manage');
  const [cacheTtl, setCacheTtl] = React.useState<number>(
    prefs.enrichment?.cache_ttl_seconds ?? 3600,
  );

  // Commit-on-blur (NumberField clamps first), then persist via the immediate settings
  // PUT, never the buffered page save, so it stays independent of the page dirty-map.
  const saveTtl = React.useCallback(async (v: number) => {
    setCacheTtl(v);
    try {
      await enrichmentApi.setEnrichmentConfig({ cache_ttl_seconds: v });
      toast.success('Cache lifetime saved.');
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not save the cache lifetime.');
    }
  }, []);

  return (
    <SettingsSection title="Enrichment">
      <SettingsGroup title="Caching" caption="Saved as soon as you leave the field.">
        <SettingRow variant="field" controlWidth="9rem">
          <NumberField
            label="Cache lifetime"
            description={withReading(
              'How long an enriched indicator is cached before it is looked up again.',
              durationReading(cacheTtl, 1),
            )}
            value={cacheTtl}
            min={0}
            step={60}
            unit="s"
            // Unbounded, so it would plan for 12rem; six digits and the unit fit 8rem.
            size="sm"
            // Saved at once: an emptied field must save nothing, never a lifetime of 0.
            empty="keep"
            disabled={!canManage}
            onChange={(v) => void saveTtl(v)}
          />
        </SettingRow>
      </SettingsGroup>
      {/* The full provider catalog (manifests, write-only secrets, try-a-lookup).
          Self-contained: it fetches its own provider manifests and persists the master
          enable and fusion, the per-provider use_* toggles and secrets through its own
          api (immediate settings PUTs and the dedicated secrets route), so it manages its
          own save lifecycle independent of the section dirty-map. `embedded` suppresses
          its own heading since the section provides one; it lays out its own groups. */}
      <EnrichmentProvidersEditor embedded />
    </SettingsSection>
  );
}
