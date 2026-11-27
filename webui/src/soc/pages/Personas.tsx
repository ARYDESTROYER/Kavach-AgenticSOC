/**
 * Agent personas (Round 14, split out of the retired combined catalog): the read-only
 * specialist roster the router chooses from, one specialist per cluster. Each row opens to
 * the persona's focus tools and routing terms. Nothing here is editable; the roster is set
 * on the backend.
 *
 * Persona names, specialisations, tools and keywords are backend data rendered as plain text
 * (#9).
 */
import * as React from 'react';
import { Bug, ChevronDown, Crosshair, Globe, Key, Search, Tag, Users, Wrench, type LucideIcon } from 'lucide-react';

import { LoadingState } from '@/design-system';
import { Panel } from '@/design-system/panel';
import { api } from '@/lib/api';
import type { AgentPersona } from '@/lib/types';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { Badge } from '@/ui/badge';

export const PAGE_TITLE = 'Agent personas';
export const PAGE_HELP =
  'Read-only specialist profiles. The router picks one specialist for each cluster, and the investigator takes on its focus and tool emphasis.';

const PERSONA_ICON: Readonly<Record<string, LucideIcon>> = {
  identity_access: Key,
  web_application: Globe,
  network_recon: Crosshair,
  malware: Bug,
  threat_intel: Search,
  generalist: Users,
};

const VALUE_CAP = 12;

function ValueList({
  label,
  values,
  icon: Icon,
  empty,
}: {
  label: string;
  values?: Array<string | number>;
  icon: LucideIcon;
  empty: string;
}) {
  const items = (values ?? []).map((v) => String(v)).filter(Boolean);
  const shown = items.slice(0, VALUE_CAP);
  const more = items.length - shown.length;
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-foreground">{label}</p>
      {items.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={label}>
          {shown.map((v, i) => (
            <li key={`${v}-${i}`}>
              <Badge variant="outline" className="max-w-full gap-1">
                <Icon className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{v}</span>
              </Badge>
            </li>
          ))}
          {more > 0 ? <li className="text-xs text-muted-foreground">{`and ${more.toLocaleString()} more`}</li> : null}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

function PersonaRow({ persona }: { persona: AgentPersona }) {
  const Icon = PERSONA_ICON[persona.id] ?? Users;
  const tools = persona.focus_tools?.length ?? 0;
  const terms = persona.keywords?.length ?? 0;
  return (
    <details className="group border-b border-border/70 last:border-b-0" data-persona={persona.id}>
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3.5 outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring xl:px-5 [&::-webkit-details-marker]:hidden">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-card text-primary">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-semibold text-foreground">{persona.label || persona.id}</span>
            <span className="font-mono text-xs text-muted-foreground">{persona.id}</span>
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {persona.specialization || 'General-purpose specialist.'}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {`${tools.toLocaleString()} focus ${tools === 1 ? 'tool' : 'tools'} · ${terms.toLocaleString()} routing ${terms === 1 ? 'term' : 'terms'}`}
          </span>
        </span>
        <ChevronDown
          className="mt-2 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </summary>
      <div className="grid gap-4 border-t border-border/70 px-4 pb-4 pt-3 sm:grid-cols-2 sm:pl-16 xl:px-5 xl:sm:pl-16">
        <ValueList
          label="Focus tools"
          values={persona.focus_tools}
          icon={Wrench}
          empty="No tool focus; it uses the default tools."
        />
        <ValueList
          label="Routing terms"
          values={persona.keywords}
          icon={Tag}
          empty="No terms; it is chosen when no other specialist fits."
        />
      </div>
    </details>
  );
}

export default function Personas() {
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = React.useState<unknown>(null);
  const [enabled, setEnabled] = React.useState(true);
  const [personas, setPersonas] = React.useState<AgentPersona[]>([]);

  const load = React.useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const res = await api.getPersonas();
      setEnabled(res.enabled);
      setPersonas(res.personas ?? []);
      setState('ready');
    } catch (err) {
      setError(err);
      setState('error');
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  return (
    <PageContainer variant="wide" data-testid="personas-page">
      <PageHeader title={PAGE_TITLE} help={PAGE_HELP} />
      {state === 'loading' ? (
        <LoadingState layout="panel" shape="panel" label="Loading agent personas" />
      ) : state === 'error' ? (
        <LoadError error={error} title="Could not load the personas" onRetry={() => void load()} />
      ) : !enabled ? (
        <EmptyState
          state="unavailable"
          icon={Users}
          title="Specialist personas are off"
          description="The investigator runs as a single generalist. Turn on the multi-agent roster on the backend to specialise it per cluster."
        />
      ) : !personas.length ? (
        <EmptyState state="no-data" icon={Users} title="No personas registered" description="No specialist personas are configured." />
      ) : (
        <Panel title="Specialist roster" count={personas.length} padding="none" data-testid="persona-roster">
          <div className="border-t border-border/70">
            {personas.map((p) => (
              <PersonaRow key={p.id} persona={p} />
            ))}
          </div>
        </Panel>
      )}
    </PageContainer>
  );
}
