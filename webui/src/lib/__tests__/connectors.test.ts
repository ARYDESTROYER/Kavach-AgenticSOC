/**
 * lib/connectors — secret-routing + slug regression tests (Round-6 sources batch).
 *
 * Covers:
 *   - splitFormValue / saveSource route the KNOWN ES keys to the GLOBAL secret store
 *     ONLY for the primary source, and every other secret VALUE (a non-primary ES key,
 *     a push receiver's sasl_password/…) to the PER-SOURCE endpoint — so a second
 *     ES-family source can never clobber the primary's credentials, and push-receiver
 *     secrets are no longer silently dropped.
 *   - slugify never emits a trailing hyphen after truncation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const updateSecrets = vi.fn();
const upsertSource = vi.fn();
const setSourceSecrets = vi.fn();

vi.mock('../api', () => ({
  api: {
    updateSecrets: (b: unknown) => updateSecrets(b),
    upsertSource: (b: unknown) => upsertSource(b),
    setSourceSecrets: (id: string, s: unknown) => setSourceSecrets(id, s),
  },
}));

import { splitFormValue, saveSource, slugify } from '../connectors';
import type { ConnectorManifest } from '../types';

const esManifest = {
  source_type: 'elasticsearch',
  display_name: 'Elasticsearch',
} as unknown as ConnectorManifest;
const kafkaManifest = {
  source_type: 'kafka',
  display_name: 'Kafka',
} as unknown as ConnectorManifest;

beforeEach(() => {
  updateSecrets.mockReset().mockResolvedValue({ ok: true });
  upsertSource.mockReset().mockResolvedValue({ ok: true, sources: [] });
  setSourceSecrets.mockReset().mockResolvedValue({ ok: true, configured_secrets: [] });
});

describe('splitFormValue secret routing', () => {
  it('routes KNOWN ES keys to the GLOBAL body for the PRIMARY source', () => {
    const { globalSecrets, sourceSecrets, config } = splitFormValue(
      esManifest,
      {
        config: { es_url: 'https://es:9200', es_ca_cert: 'CERT' },
        secrets: { es_api_key: 'KEY' },
      },
      { isPrimary: true },
    );
    expect(globalSecrets).toMatchObject({
      es_api_key: 'KEY',
      es_url: 'https://es:9200',
      es_ca_cert: 'CERT',
    });
    expect(sourceSecrets).toEqual({});
    expect(config).toMatchObject({ es_url: 'https://es:9200', es_ca_cert: 'CERT' });
  });

  it('keeps a NON-primary ES source es_api_key per-source (never global) — finding 1', () => {
    const { globalSecrets, sourceSecrets, config } = splitFormValue(
      esManifest,
      {
        config: { es_url: 'https://staging:9200', es_ca_cert: 'CERT2' },
        secrets: { es_api_key: 'KEY2' },
      },
      { isPrimary: false },
    );
    expect(globalSecrets).toBeNull(); // no global write → the primary's key is safe
    expect(sourceSecrets).toEqual({ es_api_key: 'KEY2' });
    // es_url/es_ca_cert still land in the source's OWN config (the per-source ES client reads them).
    expect(config).toMatchObject({ es_url: 'https://staging:9200', es_ca_cert: 'CERT2' });
  });

  it('routes a push-receiver secret (sasl_password) per-source — finding 0', () => {
    const { globalSecrets, sourceSecrets } = splitFormValue(
      kafkaManifest,
      { config: { brokers: 'b:9092' }, secrets: { sasl_password: 'PW' } },
      { isPrimary: false },
    );
    expect(globalSecrets).toBeNull();
    expect(sourceSecrets).toEqual({ sasl_password: 'PW' });
  });

  it('drops blank secret values from both tiers', () => {
    const { globalSecrets, sourceSecrets } = splitFormValue(
      kafkaManifest,
      { config: {}, secrets: { sasl_password: '' } },
      { isPrimary: false },
    );
    expect(globalSecrets).toBeNull();
    expect(sourceSecrets).toEqual({});
  });
});

describe('saveSource orchestration', () => {
  it('primary ES: writes global secrets, upserts, NO per-source secret call', async () => {
    await saveSource(
      esManifest,
      { config: { es_url: 'https://es:9200' }, secrets: { es_api_key: 'KEY' } },
      { id: 'es-prod', displayName: 'Prod', enabled: true, isPrimary: true },
    );
    expect(updateSecrets).toHaveBeenCalledTimes(1);
    expect(upsertSource).toHaveBeenCalledTimes(1);
    expect(setSourceSecrets).not.toHaveBeenCalled();
  });

  it('non-primary ES: NO global write; upserts then sets the per-source key AFTER', async () => {
    await saveSource(
      esManifest,
      { config: { es_url: 'https://staging:9200' }, secrets: { es_api_key: 'KEY2' } },
      { id: 'es-staging', displayName: 'Staging', enabled: true, isPrimary: false },
    );
    expect(updateSecrets).not.toHaveBeenCalled();
    expect(upsertSource).toHaveBeenCalledTimes(1);
    expect(setSourceSecrets).toHaveBeenCalledWith('es-staging', { es_api_key: 'KEY2' });
    // Per-source secrets must go AFTER the upsert (the endpoint 404s if the source is absent).
    expect(upsertSource.mock.invocationCallOrder[0]).toBeLessThan(
      setSourceSecrets.mock.invocationCallOrder[0],
    );
  });

  it('push receiver: sends the non-known secret VALUE per-source (no longer dropped)', async () => {
    await saveSource(
      kafkaManifest,
      { config: { brokers: 'b:9092' }, secrets: { sasl_password: 'PW' } },
      { id: 'kafka-1', displayName: 'Kafka', enabled: true, isPrimary: false },
    );
    expect(updateSecrets).not.toHaveBeenCalled();
    expect(setSourceSecrets).toHaveBeenCalledWith('kafka-1', { sasl_password: 'PW' });
  });

  it('OMITS severity_scale_max unless the caller passes it (carry-forward contract)', async () => {
    // A toggle / bulk / make-primary path must never send the key: the backend reads
    // `model_fields_set` and an omitted key preserves the stored declaration, while an
    // explicit null CLEARS it.
    await saveSource(
      esManifest,
      { config: {}, secrets: {} },
      { id: 'es-1', displayName: 'ES', enabled: false, isPrimary: false },
    );
    expect('severity_scale_max' in upsertSource.mock.calls[0][0]).toBe(false);

    // The editor DECLARES a ceiling...
    await saveSource(
      esManifest,
      { config: {}, secrets: {} },
      { id: 'es-1', displayName: 'ES', enabled: true, isPrimary: false, severityScaleMax: 10 },
    );
    expect(upsertSource.mock.calls[1][0].severity_scale_max).toBe(10);

    // ...and CLEARS it with an explicit null, which must still be sent as a present key.
    await saveSource(
      esManifest,
      { config: {}, secrets: {} },
      { id: 'es-1', displayName: 'ES', enabled: true, isPrimary: false, severityScaleMax: null },
    );
    expect('severity_scale_max' in upsertSource.mock.calls[2][0]).toBe(true);
    expect(upsertSource.mock.calls[2][0].severity_scale_max).toBeNull();
  });

  it('no secrets typed: upserts only (no secret calls of either tier)', async () => {
    await saveSource(
      esManifest,
      { config: { index_patterns: [] }, secrets: {} },
      { id: 'es-1', displayName: 'ES', enabled: true, isPrimary: true },
    );
    expect(updateSecrets).not.toHaveBeenCalled();
    expect(setSourceSecrets).not.toHaveBeenCalled();
    expect(upsertSource).toHaveBeenCalledTimes(1);
  });
});

describe('slugify', () => {
  it('never emits a trailing hyphen after truncation — finding 19', () => {
    // 47 alnum chars + a space that becomes the 48th hyphen; the cut must not keep it.
    const slug = slugify('a'.repeat(47) + ' overflow');
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.startsWith('-')).toBe(false);
    expect(slug).toBe('a'.repeat(47));
  });

  it('falls back to "source" for empty / symbol-only input', () => {
    expect(slugify('   ')).toBe('source');
    expect(slugify('***')).toBe('source');
  });
});
