/**
 * EmptyState — the new-chat start surface (SPEC §10.5).
 *
 * INTERFACE STUB (orchestrator). WP-I2b owns and replaces the body; keep the props.
 */
import type { ChatContextInfo, ChatStarter } from '@/lib/types';

export interface EmptyStateProps {
  context: ChatContextInfo | null;
  /** Send the starter's prompt (the host calls engine.send(prompt, {origin: 'starter'})). */
  onStarter: (starter: ChatStarter) => void;
  /** 'case' renders the compact Case Manager variant (no starter grid). */
  variant?: 'workspace' | 'case';
}

export function EmptyState({ context, onStarter }: EmptyStateProps) {
  const starters = context?.starters ?? [];
  return (
    <div>
      <p>Ask about your data, build a quick report, or learn how this console works. Read-only.</p>
      <ul>
        {starters.map((s) => (
          <li key={s.id}>
            <button type="button" onClick={() => onStarter(s)}>
              {s.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
