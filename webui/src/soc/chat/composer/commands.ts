/**
 * The composer's `/` commands and `@` scopes (SPEC §10.4) as pure data + parsers.
 *
 * Commands are filtered by the caller's tool catalogue from `/chat/context`: a command
 * is offered only when every tool it needs is allowed (fail closed: an unknown tool or
 * a missing catalogue hides it). Commands without an argument send a fixed question
 * with `origin: "command"`. Commands that take an argument never send by themselves:
 * they fill the composer with the question and select the placeholder, so the value
 * the analyst types is their own text and is sent with `origin: "user"` — the only
 * origin the indicator taint rule accepts (SPEC §4.8). `/report <template>` inserts the
 * template's section request the same way.
 */
import type { ChatContextInfo, ChatPrompt, ChatScope, ChatToolInfo, ReportTemplateName } from '@/lib/types';
import { CHAT_SCOPES } from '../stream-events';
import { isKindGated } from './access-copy';
import { SCOPE_DESCRIPTIONS, SCOPE_LABELS } from './format';

/* -------------------------------------------------------------------------- */
/* Tool access.                                                                */
/* -------------------------------------------------------------------------- */

/** The copy for a tool (or scope) the deployment switched off (SPEC A30). */
export const TURNED_OFF_COPY = 'Turned off on this deployment';

/** The deployment switched this tool off (SPEC A30): no grant would help. */
export function toolTurnedOff(tool: ChatToolInfo): boolean {
  return tool.available === false;
}

/** The caller holds the grants AND the deployment has the tool on. */
export function toolUsable(tool: ChatToolInfo): boolean {
  return tool.allowed && !toolTurnedOff(tool);
}

/** True when every named tool is in the catalogue, allowed and on (fail closed). */
export function toolsAllowed(context: ChatContextInfo | null | undefined, tools: readonly string[]): boolean {
  if (!context) return false;
  return tools.every((name) => context.tools.some((tool) => tool.name === name && toolUsable(tool)));
}

/**
 * The grants the caller lacks for a tool, as "Needs <…>" copy, or null when allowed.
 * A kind-gated tool (no base grant) is unlocked by ANY one of its per-kind grants, so
 * they are joined with "or"; ordinary required grants are all needed ("and").
 */
export function missingGrant(tool: ChatToolInfo): string | null {
  if (tool.allowed) return null;
  const missing = tool.missing?.length ? tool.missing : tool.requires;
  if (!missing.length) return null;
  return missing.join(isKindGated(tool) ? ' or ' : ' and ');
}

export interface ScopeAccess {
  scope: ChatScope;
  label: string;
  description: string;
  /** At least one tool of this scope is allowed and on. */
  allowed: boolean;
  /** A grant that would unlock it, when known. */
  missing: string | null;
  /** Every tool of this scope the caller holds is switched off by the deployment. */
  turnedOff: boolean;
}

/** Per-scope access derived from the catalogue (a scope is usable when any tool is). */
export function scopeAccess(context: ChatContextInfo | null | undefined): ScopeAccess[] {
  return CHAT_SCOPES.map((scope) => {
    const tools = context?.tools.filter((tool) => tool.scope === scope) ?? [];
    const allowed = tools.some(toolUsable);
    let missing: string | null = null;
    if (!allowed) {
      for (const tool of tools) {
        missing = missingGrant(tool);
        if (missing) break;
      }
    }
    // Held but switched off: say so instead of "Not available to you".
    const turnedOff = !allowed && !missing && tools.some((tool) => tool.allowed && toolTurnedOff(tool));
    return { scope, label: SCOPE_LABELS[scope], description: SCOPE_DESCRIPTIONS[scope], allowed, missing, turnedOff };
  });
}

/* -------------------------------------------------------------------------- */
/* Slash commands.                                                             */
/* -------------------------------------------------------------------------- */

export interface SlashArgument {
  /** Shown in the menu and inserted (selected) when the analyst typed no value. */
  placeholder: string;
}

export interface SlashCommand {
  /** The word after `/`. */
  id: string;
  description: string;
  /** Every tool the command's question needs. */
  tools: readonly string[];
  /** Absent: the command sends `template` at once. */
  argument?: SlashArgument;
  /** The question; `{arg}` marks where the argument goes. */
  template: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: 'shift-brief',
    description: 'Shift handoff: open work, key metrics and next steps',
    tools: ['shift_report'],
    template: 'Write a shift brief for the handoff: a summary, open work, key metrics and next steps.',
  },
  {
    id: 'report',
    description: 'Start a report from a template',
    tools: [],
    argument: { placeholder: '<template>' },
    template: '',
  },
  {
    id: 'posture',
    description: 'How the SOC is doing right now',
    tools: ['soc_metrics'],
    template: 'How is our security posture right now? Show the key metrics and how they are trending.',
  },
  {
    id: 'hunt',
    description: 'Hunt an IP, domain, hash or URL',
    tools: ['search_logs'],
    argument: { placeholder: '<indicator>' },
    template: 'Hunt for {arg} across logs, cases and threat intel. What do we know about it?',
  },
  {
    id: 'case',
    description: 'Investigate a case by its id',
    tools: ['get_case'],
    argument: { placeholder: '<case id>' },
    template: 'Investigate case {arg}: what happened, the evidence and why it was decided that way.',
  },
  {
    id: 'cost',
    description: 'AI spend and tokens by role and model',
    tools: ['cost_usage'],
    template: 'What has AI spend been today and this week, by role and model?',
  },
  {
    id: 'sources',
    description: 'Silent or degraded sources and coverage',
    tools: ['source_health'],
    template: 'Which log sources are silent or degraded, and what is our coverage?',
  },
  {
    id: 'help',
    description: 'How this console works',
    tools: ['app_help'],
    argument: { placeholder: '<topic>' },
    template: 'What is {arg} in this console, and how do I use it?',
  },
];

export interface ReportTemplateSpec {
  template: ReportTemplateName;
  /** "a shift report" — the article is part of the copy. */
  noun: string;
  sections: readonly string[];
  tools: readonly string[];
  /** The report's subject, when the template needs one. */
  argument?: SlashArgument;
}

/** `/report <template>`: the section request each template inserts. */
export const REPORT_TEMPLATE_SPECS: readonly ReportTemplateSpec[] = [
  {
    template: 'shift',
    noun: 'a shift report',
    sections: ['Summary', 'Open work', 'Key metrics', 'Next steps'],
    tools: ['shift_report'],
  },
  {
    template: 'posture',
    noun: 'a posture report',
    sections: ['Summary', 'Key metrics', 'Trends', 'Noise reduction', 'Next steps'],
    tools: ['soc_metrics'],
  },
  {
    template: 'investigation',
    noun: 'an investigation report',
    sections: ['Summary', 'Evidence', 'Timeline', 'Decision', 'Next steps'],
    tools: ['get_case'],
    argument: { placeholder: '<case id>' },
  },
  {
    template: 'hunt',
    noun: 'a hunt report',
    sections: ['Hypothesis', 'Findings', 'Affected entities', 'Related cases', 'Next steps'],
    tools: ['search_logs'],
    argument: { placeholder: '<indicator or behaviour>' },
  },
  {
    template: 'ioc',
    noun: 'an IOC report',
    sections: ['Indicator', 'Reputation', 'Sightings', 'Related cases', 'Next steps'],
    tools: ['lookup_indicator'],
    argument: { placeholder: '<indicator>' },
  },
  {
    template: 'custom',
    noun: 'a report',
    sections: ['Summary', 'Findings', 'Next steps'],
    tools: [],
  },
];

/** The report request text, with `{arg}` where the subject goes (when it has one). */
export function reportTemplateText(spec: ReportTemplateSpec): string {
  const subject = spec.argument ? ' on {arg}' : '';
  return `Build ${spec.noun}${subject} with these sections: ${spec.sections.join(', ')}.`;
}

/** What `/` typed so far: the command word and its argument (single line only). */
export interface SlashQuery {
  command: string;
  arg: string;
  /** A space followed the command word (the argument phase). */
  hasSpace: boolean;
}

const SLASH_RE = /^\/([a-z-]*)(?:([ \t]+)([^\n]*))?$/i;

/** Parse a draft that IS a slash command (it starts with `/` and has one line). */
export function parseSlashQuery(draft: string): SlashQuery | null {
  const match = SLASH_RE.exec(draft);
  if (!match) return null;
  return { command: match[1].toLowerCase(), arg: (match[3] ?? '').trim(), hasSpace: Boolean(match[2]) };
}

export type ComposerMenuItem =
  | {
      kind: 'command';
      value: string;
      command: SlashCommand;
      arg: string;
      label: string;
      hint: string;
    }
  | {
      kind: 'report';
      value: string;
      spec: ReportTemplateSpec;
      arg: string;
      label: string;
      hint: string;
    }
  | { kind: 'prompt'; value: string; prompt: ChatPrompt; label: string; hint: string }
  | { kind: 'scope'; value: string; access: ScopeAccess; label: string; hint: string; disabled: boolean };

export interface ComposerMenuGroup {
  heading: string;
  items: ComposerMenuItem[];
}

const MAX_PROMPT_ITEMS = 8;

function commandLabel(command: SlashCommand): string {
  return command.argument ? `/${command.id} ${command.argument.placeholder}` : `/${command.id}`;
}

/** Commands, report templates and saved prompts for the `/` menu (allowed ones only). */
export function slashMenuGroups(
  query: SlashQuery,
  context: ChatContextInfo | null | undefined,
  prompts: readonly ChatPrompt[],
): ComposerMenuGroup[] {
  const groups: ComposerMenuGroup[] = [];
  const allowedTemplates = REPORT_TEMPLATE_SPECS.filter((spec) => toolsAllowed(context, spec.tools));
  const available = SLASH_COMMANDS.filter((command) =>
    command.id === 'report' ? Boolean(context) && allowedTemplates.length > 0 : toolsAllowed(context, command.tools),
  );

  if (query.hasSpace) {
    const command = available.find((c) => c.id === query.command);
    if (!command) return groups;
    if (command.id === 'report') {
      const [word, ...rest] = query.arg.split(/\s+/);
      const needle = (word ?? '').toLowerCase();
      const exact = allowedTemplates.find((spec) => spec.template === needle);
      const specs = exact ? [exact] : allowedTemplates.filter((spec) => spec.template.startsWith(needle));
      const subject = exact ? rest.join(' ').trim() : '';
      const items = specs.map<ComposerMenuItem>((spec) => ({
        kind: 'report',
        value: `report:${spec.template}`,
        spec,
        arg: subject,
        label: `/report ${spec.template}`,
        hint: spec.sections.join(' · '),
      }));
      if (items.length) groups.push({ heading: 'Report templates', items });
      return groups;
    }
    groups.push({
      heading: 'Commands',
      items: [
        {
          kind: 'command',
          value: `cmd:${command.id}`,
          command,
          arg: query.arg,
          label: commandLabel(command),
          hint: command.description,
        },
      ],
    });
    return groups;
  }

  // Prefix matches first; a word found inside a command ("/brief") only when no
  // command starts with what was typed, so "/po" is posture, not also report.
  const byPrefix = available.filter((command) => command.id.startsWith(query.command));
  const matched =
    byPrefix.length || query.command.length < 2
      ? byPrefix
      : available.filter((command) => command.id.includes(query.command));
  const commands = matched
    .map<ComposerMenuItem>((command) => ({
      kind: 'command',
      value: `cmd:${command.id}`,
      command,
      arg: '',
      label: commandLabel(command),
      hint: command.description,
    }));
  if (commands.length) groups.push({ heading: 'Commands', items: commands });

  const needle = query.command.replace(/-/g, ' ').trim();
  const promptItems = prompts
    .map((prompt, index) => ({ prompt, index }))
    .filter(({ prompt }) => !needle || prompt.title.toLowerCase().includes(needle) || prompt.text.toLowerCase().includes(needle))
    .slice(0, MAX_PROMPT_ITEMS)
    .map<ComposerMenuItem>(({ prompt, index }) => ({
      kind: 'prompt',
      value: `prompt:${index}`,
      prompt,
      label: prompt.title,
      hint: prompt.text,
    }));
  if (promptItems.length) groups.push({ heading: 'Saved prompts', items: promptItems });
  return groups;
}

/* -------------------------------------------------------------------------- */
/* @ scopes.                                                                   */
/* -------------------------------------------------------------------------- */

export interface AtQuery {
  /** Index of the `@`. */
  start: number;
  /** The caret (end of the token). */
  end: number;
  query: string;
}

/** An `@word` immediately before the caret, at the start or after whitespace. */
export function parseAtQuery(draft: string, caret: number): AtQuery | null {
  if (caret < 1 || caret > draft.length) return null;
  const before = draft.slice(0, caret);
  const match = /(^|\s)@([a-z]*)$/i.exec(before);
  if (!match) return null;
  const word = match[2];
  return { start: caret - word.length - 1, end: caret, query: word.toLowerCase() };
}

/** Scopes matching the `@` query, minus the ones already chosen; denied ones disabled. */
export function atMenuGroups(
  query: AtQuery,
  context: ChatContextInfo | null | undefined,
  active: readonly ChatScope[],
): ComposerMenuGroup[] {
  const items = scopeAccess(context)
    .filter((access) => !active.includes(access.scope))
    .filter(
      (access) =>
        access.scope.startsWith(query.query) || access.label.toLowerCase().startsWith(query.query),
    )
    .map<ComposerMenuItem>((access) => ({
      kind: 'scope',
      value: `scope:${access.scope}`,
      access,
      label: `@${access.scope}`,
      hint: access.allowed
        ? access.description
        : access.missing
          ? `Needs ${access.missing}`
          : access.turnedOff
            ? TURNED_OFF_COPY
            : 'Not available to you',
      disabled: !access.allowed,
    }));
  return items.length ? [{ heading: 'Limit the next answers to', items }] : [];
}

/** Remove the `@word` token the menu completed, collapsing the space it leaves. */
export function removeAtToken(draft: string, query: AtQuery): { text: string; caret: number } {
  const head = draft.slice(0, query.start);
  let tail = draft.slice(query.end);
  if ((head === '' || /\s$/.test(head)) && tail.startsWith(' ')) tail = tail.slice(1);
  return { text: head + tail, caret: head.length };
}

/* -------------------------------------------------------------------------- */
/* Expansion.                                                                  */
/* -------------------------------------------------------------------------- */

export interface Expansion {
  text: string;
  /** Range to select (the placeholder), else the caret goes to the end. */
  selection: [number, number] | null;
}

/** Fill `{arg}` with the typed value, or with the placeholder and select it. */
export function expandTemplate(template: string, arg: string, placeholder: string | null): Expansion {
  const at = template.indexOf('{arg}');
  if (at < 0) {
    const text = arg ? `${template} ${arg}` : template;
    return { text, selection: null };
  }
  const value = arg || placeholder || '';
  const text = template.slice(0, at) + value + template.slice(at + '{arg}'.length);
  return { text, selection: arg || !placeholder ? null : [at, at + placeholder.length] };
}

/** What choosing a `/` item does: send a fixed question, or fill the composer. */
export type SlashAction =
  | { type: 'send'; text: string }
  | { type: 'insert'; expansion: Expansion };

export function slashAction(item: ComposerMenuItem): SlashAction | null {
  if (item.kind === 'command') {
    const { command, arg } = item;
    // `/report` opens its template list: the menu re-reads the draft "/report ".
    if (command.id === 'report') return { type: 'insert', expansion: { text: '/report ', selection: null } };
    if (!command.argument && !arg) return { type: 'send', text: command.template };
    return { type: 'insert', expansion: expandTemplate(command.template, arg, command.argument?.placeholder ?? null) };
  }
  if (item.kind === 'report') {
    return {
      type: 'insert',
      expansion: expandTemplate(reportTemplateText(item.spec), item.arg, item.spec.argument?.placeholder ?? null),
    };
  }
  if (item.kind === 'prompt') return { type: 'insert', expansion: { text: item.prompt.text, selection: null } };
  return null;
}
