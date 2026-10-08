/**
 * A controllable `ChatEngine` stand-in for composer tests: real React state for the
 * draft, scopes, model, source, time range and live mode (so the composer re-renders
 * exactly as it does under the real engine), with spies on every action. A fetch stub
 * answers `/api/sources`, `/api/models` and `/api/prefs/user` like the server.
 */
import * as React from 'react';
import { vi } from 'vitest';
import type {
  ChatContextInfo,
  ChatPrompt,
  ChatScope,
  ChatStreamMode,
  ChatTimeRange,
  SourceInstance,
} from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import type { ChatEngine } from '../../useChatEngine';
import { Composer, type ComposerHandle, type ComposerProps } from '../Composer';

export interface EngineSpies {
  send: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  setSourceId: ReturnType<typeof vi.fn>;
  setTimeRange: ReturnType<typeof vi.fn>;
  setStreamMode: ReturnType<typeof vi.fn>;
}

export function makeSpies(): EngineSpies {
  return {
    send: vi.fn(),
    stop: vi.fn(),
    setModel: vi.fn(),
    setSourceId: vi.fn(),
    setTimeRange: vi.fn(),
    setStreamMode: vi.fn(),
  };
}

export interface HarnessProps extends Omit<ComposerProps, 'engine' | 'context'> {
  spies: EngineSpies;
  context?: ChatContextInfo | null;
  busy?: boolean;
  canStop?: boolean;
  draft?: string;
  lastUserPrompt?: string | null;
  model?: string | null;
  scopes?: ChatScope[];
  streamMode?: ChatStreamMode;
  handleRef?: React.Ref<ComposerHandle>;
  /** Whether `send` reports success (the engine refuses while blocked). */
  sendResult?: boolean;
  /**
   * A HOST-controlled draft (the Workspace's per-thread drafts): when set, the engine's
   * draft is this value and edits are reported through `onDraftChange` only.
   */
  controlledDraft?: string;
  onDraftChange?: (value: string) => void;
}

export function Harness(props: HarnessProps) {
  const {
    spies,
    context = null,
    busy = false,
    canStop = true,
    handleRef,
    sendResult = true,
    controlledDraft,
    onDraftChange,
    ...rest
  } = props;
  const [localDraft, setLocalDraft] = React.useState(props.draft ?? '');
  const draft = controlledDraft ?? localDraft;
  const setDraft = (value: string) => {
    if (controlledDraft === undefined) setLocalDraft(value);
    onDraftChange?.(value);
  };
  const [scopes, setScopes] = React.useState<ChatScope[]>(props.scopes ?? []);
  const [model, setModel] = React.useState<string | null>(props.model ?? null);
  const [sourceId, setSourceId] = React.useState<string | null>(null);
  const [timeRange, setTimeRange] = React.useState<ChatTimeRange | null>(null);
  const [streamMode, setStreamMode] = React.useState<ChatStreamMode>(props.streamMode ?? 'steps');

  const engine: ChatEngine = {
    items: [],
    running: null,
    busy,
    canStop: busy && canStop,
    conversationId: null,
    persist: true,
    draft,
    setDraft,
    model,
    setModel: (value) => {
      spies.setModel(value);
      setModel(value);
    },
    sourceId,
    setSourceId: (value) => {
      spies.setSourceId(value);
      setSourceId(value);
    },
    scopes,
    setScopes,
    timeRange,
    setTimeRange: (value) => {
      spies.setTimeRange(value);
      setTimeRange(value);
    },
    streamMode,
    effectiveStreamMode: streamMode,
    setStreamMode: (value) => {
      spies.setStreamMode(value);
      setStreamMode(value);
    },
    lastUserPrompt: props.lastUserPrompt ?? null,
    send: (text, options) => {
      spies.send(text, options);
      if (sendResult && text === undefined) setDraft('');
      return sendResult;
    },
    stop: spies.stop,
    retry: () => false,
    askAgain: () => false,
    continueAnswer: () => false,
    reset: () => setDraft(''),
  };

  return (
    <TooltipProvider delayDuration={0}>
      <button type="button">Outside</button>
      <Composer ref={handleRef} engine={engine} context={context} {...rest} />
      <output data-testid="scopes">{scopes.join(',')}</output>
      <output data-testid="source">{sourceId ?? ''}</output>
    </TooltipProvider>
  );
}

export interface ServerState {
  sources: SourceInstance[];
  prompts: ChatPrompt[];
  calls: { url: string; method: string; body: unknown }[];
  sourcesStatus: number;
  /** Status for PUT /api/prefs/user (a failing write). */
  putStatus: number;
  /** `/api/models` body override (e.g. with a `capabilities` map). */
  models?: unknown;
}

/** Stub fetch for the composer's catalogue and prefs requests. */
export function stubServer(initial: Partial<ServerState> = {}): ServerState {
  const state: ServerState = {
    sources: initial.sources ?? [
      { id: 'w', source_type: 'wazuh', display_name: 'Wazuh', can_browse: true },
      { id: 'e', source_type: 'elastic', display_name: 'Elastic prod', can_browse: true },
      { id: 'x', source_type: 'syslog', display_name: 'Disabled', can_browse: true, enabled: false },
    ],
    prompts: initial.prompts ?? [],
    calls: [],
    sourcesStatus: initial.sourcesStatus ?? 200,
    putStatus: initial.putStatus ?? 200,
    models: initial.models,
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ url, method, body });
      if (url === '/api/sources') {
        return state.sourcesStatus === 200
          ? json({ sources: state.sources })
          : json({ detail: 'forbidden' }, state.sourcesStatus);
      }
      if (url === '/api/models') {
        return json(state.models ?? { providers: { anthropic: ['claude-sonnet-test'], openai: ['gpt-x'] }, configured: {} });
      }
      if (url === '/api/prefs/user' && method === 'GET') return json({ chat_prompts: state.prompts });
      if (url === '/api/prefs/user' && method === 'PUT') {
        if (state.putStatus !== 200) return json({ detail: 'Preferences are unavailable right now.' }, state.putStatus);
        const next = (body as { chat_prompts?: ChatPrompt[] })?.chat_prompts;
        if (next) state.prompts = next;
        return json({ chat_prompts: state.prompts });
      }
      return json({ detail: 'Not Found' }, 404);
    }),
  );
  return state;
}

/** A ResizeObserver that reports a fixed width for the composer root. */
export function stubComposerWidth(width: number): void {
  class FixedResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (!(target instanceof HTMLElement) || !target.hasAttribute('data-chat-composer')) return;
      const size = { inlineSize: width, blockSize: 80 } as ResizeObserverSize;
      const entry = {
        target,
        contentRect: { width, height: 80 } as DOMRectReadOnly,
        contentBoxSize: [size],
        borderBoxSize: [size],
        devicePixelContentBoxSize: [size],
      } as unknown as ResizeObserverEntry;
      this.callback([entry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', FixedResizeObserver);
}
