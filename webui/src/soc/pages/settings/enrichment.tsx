/**
 * Enrichment settings section (Round-5 Sett-A decomposition; Round-6 clobber fix; Round 14
 * grouped panels).
 *
 * The self-contained provider catalog editor manages the WHOLE `enrichment` config
 * lifecycle via IMMEDIATE saves to PUT /api/enrichment/config (master enable/fusion +
 * per-provider toggles) and the write-only secrets route. The Cache TTL below rides the
 * SAME save and shows the lifetime the editor read, so the whole section reads and writes
 * one set of settings: the real ones, or while Demo Mode is on the Demo sandbox's copy
 * (Round 14, wro-01). The page's `prefs` (always the real settings) is only the first
 * paint until the editor's read lands. A lifetime save is reported to the editor, which
 * reads the settings again when the save went to another stack or was refused because
 * Demo Mode moved meanwhile; a refused save puts back the lifetime that was shown.
 *
 * The settings lock (`readOnly`): the field and every switch and key field in the editor
 * are disabled, since the server refuses the save while the lock is on.
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
import {
  EnrichmentProvidersEditor,
  type EnrichmentProvidersEditorHandle,
  type EnrichmentSettingsLoaded,
} from '@/soc/components/EnrichmentProvidersEditor';
import { CACHE_TTL_MAX_SECONDS, enrichmentApi } from '@/soc/components/EnrichmentProviders.api';
import { NumberField } from '@/soc/components/NumberField';
import { useCan } from '@/soc/components/Can';
import { durationReading, withReading } from './duration';

export function EnrichmentSection({ prefs, readOnly = false }: SecProps & { readOnly?: boolean }) {
  const canManage = useCan('enrichment', 'manage');
  const [cacheTtl, setCacheTtl] = React.useState<number>(
    prefs.enrichment?.cache_ttl_seconds ?? 3600,
  );
  // The lifetime last read or saved, put back when a save is refused.
  const shownTtlRef = React.useRef(cacheTtl);
  const editorRef = React.useRef<EnrichmentProvidersEditorHandle>(null);

  // Commit-on-blur (NumberField clamps first), then persist via the immediate enrichment
  // save, never the buffered page save, so it stays independent of the page dirty-map.
  const saveTtl = React.useCallback(async (v: number) => {
    setCacheTtl(v);
    try {
      const saved = await enrichmentApi.setEnrichmentConfig({ cache_ttl_seconds: v });
      shownTtlRef.current = v;
      toast.success('Cache lifetime saved.');
      editorRef.current?.afterSave(saved);
    } catch (e) {
      setCacheTtl(shownTtlRef.current);
      toast.error(e instanceof Error && e.message ? e.message : 'Could not save the cache lifetime.');
      editorRef.current?.afterSave(null, e);
    }
  }, []);

  // The lifetime of the settings the editor reads (the Demo sandbox's copy in Demo Mode).
  const onSettingsLoaded = React.useCallback(({ cacheTtlSeconds }: EnrichmentSettingsLoaded) => {
    if (typeof cacheTtlSeconds === 'number') {
      shownTtlRef.current = cacheTtlSeconds;
      setCacheTtl(cacheTtlSeconds);
    }
  }, []);

  return (
    <SettingsSection title="Enrichment">
      <SettingsGroup
        title="Caching"
        caption={
          readOnly ? 'Read-only while the settings lock is on.' : 'Saved as soon as you leave the field.'
        }
      >
        <SettingRow variant="field" controlWidth="9rem">
          <NumberField
            label="Cache lifetime"
            description={`${withReading(
              'How long an enriched indicator is cached before it is looked up again.',
              durationReading(cacheTtl, 1),
            )} The longest is 30 days.`}
            value={cacheTtl}
            min={0}
            max={CACHE_TTL_MAX_SECONDS}
            step={60}
            unit="s"
            // Seven digits and the unit fit 8rem (Settings preferences start from 8rem).
            size="sm"
            // Saved at once: an emptied field must save nothing, never a lifetime of 0.
            empty="keep"
            disabled={!canManage || readOnly}
            onChange={(v) => void saveTtl(v)}
          />
        </SettingRow>
      </SettingsGroup>
      {/* The full provider catalog (manifests, write-only secrets, try-a-lookup).
          Self-contained: it fetches its own provider manifests and persists the master
          enable and fusion, the per-provider use_* toggles and secrets through its own
          api (immediate enrichment saves and the dedicated secrets route), so it manages
          its own save lifecycle independent of the section dirty-map. `embedded`
          suppresses its own heading since the section provides one; it lays out its own
          groups. */}
      <EnrichmentProvidersEditor
        embedded
        readOnly={readOnly}
        onSettingsLoaded={onSettingsLoaded}
        handleRef={editorRef}
      />
    </SettingsSection>
  );
}
