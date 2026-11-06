/**
 * Intelligence: the host for the agent's knowledge and procedure surfaces, each with its own
 * operator job.
 *
 *   - Knowledge corpus: indexed RAG material (import, inspect, search, delete).
 *   - Runbooks: the team's response procedures (Round 14, SPEC §4.10.1), a page of its own
 *     with its library and editor.
 *   - Operator memory: approved durable facts given to investigations and chat.
 *   - Agent personas: the read-only specialist roster the router chooses from.
 *
 * The active view comes from the `tab` route opt (forced by the `knowledge`, `runbooks`,
 * `memory` and `personas` routes and by `navigate('intelligence', { tab })`). Knowledge and
 * memory render inside the host's one page header; Runbooks and Personas draw their own.
 * The retired `playbooks` and `catalog` ids open Runbooks.
 */
import { useNavigateOptional, type Navigate } from '@/soc/router';
import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import Knowledge from './Knowledge';
import Runbooks from './Runbooks';
import Memory from './Memory';
import Personas from './Personas';

export interface IntelligenceProps {
  onNavigate?: Navigate;
  /** Active view from the route opts. */
  tab?: string;
}

type View = 'knowledge' | 'runbooks' | 'memory' | 'personas';

const HEADERS: Record<'knowledge' | 'memory', { title: string; help: string }> = {
  knowledge: {
    title: 'Knowledge corpus',
    help: 'Indexed material the agent can retrieve. Import, inspect, search and manage each source.',
  },
  memory: {
    title: 'Operator memory',
    help: 'Approved durable operator facts given to automated investigations and Workspace chat.',
  },
};

export function intelligenceView(tab: string | undefined): View {
  if (tab === 'runbooks' || tab === 'playbooks' || tab === 'catalog') return 'runbooks';
  if (tab === 'memory') return 'memory';
  if (tab === 'personas') return 'personas';
  return 'knowledge';
}

export default function Intelligence({ onNavigate, tab }: IntelligenceProps = {}) {
  // Resolve navigate once (an explicit prop wins for tests); the hook is called unconditionally.
  const contextNavigate = useNavigateOptional();
  const navigate = onNavigate ?? contextNavigate;
  const view = intelligenceView(tab);
  if (view === 'runbooks') return <Runbooks />;
  if (view === 'personas') return <Personas />;
  const header = HEADERS[view];
  return (
    <PageContainer variant="wide">
      <PageHeader title={header.title} help={header.help} />
      {view === 'memory' ? <Memory embedded onNavigate={navigate} /> : <Knowledge embedded onNavigate={navigate} />}
    </PageContainer>
  );
}
