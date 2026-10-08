/**
 * useComposerCatalog — the source list for the Scope chip and the model list for
 * Options → Model, read through the existing eager endpoints (`GET /api/sources`,
 * `GET /api/models`; no new `api` methods, SPEC §10.10).
 *
 * Sources are read once the caller is known to hold `sources:read` (the chip names
 * the selected source). A caller without it never sends the request: the backend
 * writes an ACCESS_DENIED audit row for every 403, and a restricted role's chat
 * visits must not fill the audit trail with noise (SPEC §5.1). Models are read
 * lazily, the first time the Options menu needs them, and only chat-capable ones are
 * offered. Both are best-effort: a 403 or an outage leaves the chip on "All sources"
 * and the Model menu on the default, with an honest state the UI can explain.
 * Operator-configured names are display-sanitised when rendered (#9).
 */
import * as React from 'react';
import { ApiError, api } from '@/lib/api';
import type { ChatContextInfo, ModelsResponse, SourceInstance } from '@/lib/types';
import { displayText } from '../stream-events';
import { isQueryableSource } from './format';

export type CatalogState = 'idle' | 'loading' | 'ready' | 'denied' | 'error';

export interface ModelOption {
  value: string;
  provider: string;
}

export interface ComposerCatalog {
  sources: SourceInstance[];
  sourcesState: CatalogState;
  models: ModelOption[];
  modelsState: CatalogState;
  loadModels: () => void;
}

const MODEL_ID_MAX = 200;

/** `/api/models` also returns `capabilities: {model id: ["chat", "embedding", …]}`. */
type ModelsWithCapabilities = ModelsResponse & { capabilities?: unknown };

/**
 * The chat capability per model id, or null when the server sent no map (an older
 * backend: every listed model is offered, as before).
 */
function chatCapable(response: ModelsWithCapabilities | null | undefined): ((model: string) => boolean) | null {
  const map = response?.capabilities;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const table = map as Record<string, unknown>;
  return (model) => {
    const caps = Object.prototype.hasOwnProperty.call(table, model) ? table[model] : undefined;
    return Array.isArray(caps) && caps.includes('chat');
  };
}

/**
 * Flatten `/models` providers into unique, bounded options (plain text), keeping only
 * models the server declares `chat` for: an embedding-only model (or one with no
 * declared capability) would fail the next turn with 422 `chat_model_unavailable`.
 */
export function modelOptions(response: ModelsWithCapabilities | null | undefined): ModelOption[] {
  const out: ModelOption[] = [];
  const providers = response && typeof response.providers === 'object' ? response.providers : {};
  const canChat = chatCapable(response);
  for (const [provider, list] of Object.entries(providers ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const model of list) {
      if (typeof model !== 'string' || !model || model.length > MODEL_ID_MAX) continue;
      if (canChat && !canChat(model)) continue;
      if (out.some((option) => option.value === model)) continue;
      out.push({ value: model, provider: displayText(provider, 40) });
    }
  }
  return out;
}

const stateFor = (error: unknown): CatalogState =>
  error instanceof ApiError && (error.status === 401 || error.status === 403) ? 'denied' : 'error';

/**
 * Whether the caller may read sources, from the `/chat/context` catalogue: the log and
 * source-health tools need exactly `sources:read`, so "none of them allowed" means the
 * grant is missing. Null while the context loads (wait rather than guess); true when
 * the catalogue lists no such tool at all (an older server: try, as before).
 */
export function sourcesReadable(context: ChatContextInfo | null | undefined): boolean | null {
  if (!context) return null;
  const gated = context.tools.filter((tool) => tool.requires.includes('sources:read'));
  if (!gated.length) return true;
  return gated.some((tool) => tool.allowed);
}

export interface ComposerCatalogOptions {
  /** false: this composer has no source chip (the case variant); nothing is read. */
  loadSources?: boolean;
  /**
   * {@link sourcesReadable}: true reads the sources, false reports 'denied' without a
   * request, null waits (the context is still loading).
   */
  canReadSources?: boolean | null;
}

export function useComposerCatalog(options: ComposerCatalogOptions = {}): ComposerCatalog {
  const { loadSources = true, canReadSources = true } = options;
  const [sources, setSources] = React.useState<SourceInstance[]>([]);
  const [sourcesState, setSourcesState] = React.useState<CatalogState>('idle');
  const [models, setModels] = React.useState<ModelOption[]>([]);
  const [modelsState, setModelsState] = React.useState<CatalogState>('idle');
  const alive = React.useRef(true);

  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const sourcesRequested = React.useRef(false);
  React.useEffect(() => {
    if (!loadSources || sourcesRequested.current) return;
    if (canReadSources === false) {
      // Known not to hold sources:read: say so without asking (no 403, no audit row).
      setSourcesState('denied');
      return;
    }
    if (canReadSources !== true) return;
    sourcesRequested.current = true;
    setSourcesState('loading');
    api
      .listSources()
      .then((response) => {
        if (!alive.current) return;
        const list = Array.isArray(response?.sources) ? response.sources : [];
        setSources(list.filter((s) => s && typeof s.id === 'string' && isQueryableSource(s)));
        setSourcesState('ready');
      })
      .catch((error: unknown) => {
        if (alive.current) setSourcesState(stateFor(error));
      });
  }, [loadSources, canReadSources]);

  const requested = React.useRef(false);
  const loadModels = React.useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setModelsState('loading');
    api
      .getModels()
      .then((response) => {
        if (!alive.current) return;
        setModels(modelOptions(response));
        setModelsState('ready');
      })
      .catch((error: unknown) => {
        // Allow a later retry after a transient failure.
        requested.current = false;
        if (alive.current) setModelsState(stateFor(error));
      });
  }, []);

  return { sources, sourcesState, models, modelsState, loadModels };
}
