/**
 * The Demo identity the console knows, for the chat's module caches (PR #132 review).
 *
 * `useChatStarters` and `useChatContext` cache server answers across mounts, and case
 * chat keeps a transcript per case id. In Demo Mode those come from the throwaway demo
 * stores, and every enable and every reset builds a new run (`DemoStatus.run_id`) that
 * re-seeds the same case ids, so "Demo on" is not enough to key them: a cache keyed only
 * by the principal kept the last run's suggestions (case numbers, counts) after Exit
 * Demo, Reset or a re-enable. Every one of them puts this identity in its key and drops
 * what it holds when it changes, so entering, leaving or resetting Demo always reads
 * afresh.
 *
 * Only a CONFIRMED status read counts (PR #132 verify, defect 1). `DemoProvider` shows
 * its OFF stand-in before the first read lands and after any failed read (a network
 * blip, a 502/503, a 429), marked `confirmed: false`; that is no answer, not "Demo
 * left". Taken as `off`, one failed 20 s poll swung a Demo session from its run to off
 * and back, which wiped every case transcript, stopped following a running case turn
 * and re-read the starters. So what the hooks get is a switch token: it stays the same
 * until a confirmed read names another identity than the previous confirmed read did.
 *
 * - A failed read (the stand-in) changes nothing: the last confirmed identity holds.
 * - The first confirmed read is not a switch. What was read or sent before it came from
 *   the server's actual state, so it stays (a case turn sent, or re-attached after a
 *   reload, before the first status read lands is kept).
 * - Every later confirmed change (Demo entered, left or reset) is a new token, even back
 *   to an identity seen before (off, Demo, off again).
 *
 * The confirmed identity is module state (render phase, idempotent), so a chat view that
 * mounts while the status reads are failing still has the last confirmed one. The chat
 * views note it, and so does the shell's activity observer (`ActivityEffects`, mounted
 * after first paint on every page), which makes the runs no chat view started
 * (`trackRun`): a switch before the first chat view rendered is still a switch, so a case
 * answer followed under the earlier run never shows under the new run's case (PR #132
 * verify 2). That state lives in `chat-activity/activity.ts` (re-exported here), the lazy
 * module the observer, the turn runner and the chat views already share. It reads the
 * shared `DemoProvider` (`@/soc/demo`, already on the entry path, so this adds nothing
 * to the entry chunk). Outside a provider (a standalone render, most tests) the inert OFF
 * value is the answer: `off`. The Case Detail Chat tab's shell reaches the chat modules
 * only through `React.lazy`, so its starters prefetch scopes reads by the confirmed Demo
 * identity itself (`pages/casedetail/case-starters-prefetch.ts`).
 */
import { useDemo } from '@/soc/demo';
import { noteChatDemoStatus, type ChatDemoIdentity } from '../chat-activity/activity';

// The switch token itself lives in the activity module, which the shell's observer
// (`ActivityEffects`) already imports: imported from here, it would split this module
// into a chunk of its own and add it to the entry's preload map (PR #132 verify 2).
export {
  chatDemoIdentity,
  currentChatDemoIdentity,
  noteChatDemoStatus,
  resetChatDemoIdentityForTests,
  type ChatDemoIdentity,
  type ChatDemoStatusView,
} from '../chat-activity/activity';

/** The current switch token (see the module docs). */
export function useChatDemoIdentity(): ChatDemoIdentity {
  return noteChatDemoStatus(useDemo());
}
