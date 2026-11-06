/**
 * NotificationsEditor: the "Alerting & Notifications" Settings surface (F5 / Wave 4).
 *
 * Edits the `Preferences.notifications` subtree (master enable, channels, triggers,
 * dedup / rate-limit / digest / default recipients) through the parent's `update`
 * callback (saved with the rest of Settings via PUT /api/settings). Channel SECRETS
 * (SMTP password / API key / sensitive webhook URL / bot token / routing key) are
 * NEVER part of the config — they are pushed immediately and write-only via
 * POST /api/notifications/channels/{id}/secret; the UI only ever shows a configured
 * boolean. A per-channel "Send test" calls POST /api/notifications/test.
 *
 * Round 14 (SE3, Y4, SPEC §4.9.6): the section is a `SettingsSection` of grouped panels
 * (Notifications, Channels, Email templates, Triggers, Delivery controls): each group's
 * sentence-case title sits above one tinted panel whose rows are divided by hairlines
 * (switches as `SettingRow`s, channels and the template editor as block rows, never a
 * box inside the panel). The template preview sits below the editor under 1536px, and
 * every number (port, dedup window, rate limit, digest interval) is a `NumberField` with
 * its unit inside. With the master switch off, the groups below it read as inactive.
 *
 * Security: every value here is operator-entered (trusted); no secrets are displayed.
 * Gated by <Can resource="settings" action="manage"> at the call site.
 */
import * as React from 'react';
import {
  Bell,
  Check,
  Cloud,
  Code2,
  Eye,
  FileText,
  Mail,
  MailCheck,
  MessageSquare,
  Plus,
  RotateCcw,
  Send,
  Slack,
  Trash2,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import { useDemoGuard } from '@/soc/demo';
import type {
  EmailPreset,
  NotificationChannel,
  NotificationChannelType,
  NotificationConfig,
  NotificationPreview,
  NotificationProviders,
  NotificationTemplate,
  NotificationTemplates,
  NotificationTemplateTrigger,
  Preferences,
} from '@/lib/types';
import { NOTIFICATION_TEMPLATE_TRIGGERS } from '@/lib/types';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import { Slider } from '@/ui/slider';
import { Badge } from '@/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Separator } from '@/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/ui/dialog';
import { Textarea } from '@/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/ui/tabs';

import { HelpTip } from './HelpTip';
import { SETTINGS_FORM_MAX_WIDTH } from './SettingsGrid';
import { Callout } from '@/design-system/callout';
import { useReturnFocus } from '@/soc/hooks/useReturnFocus';
import { IconButton } from './IconButton';
import { NumberField } from './NumberField';
import { SecretField } from './SecretField';
import {
  SettingRow,
  SettingsGroup,
  SettingsSection,
  SettingsSectionContext,
} from '@/soc/pages/settings/primitives';

/* ---------------------------------------------------------------- helpers --- */

function errMsg(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : fallback;
}

const CHANNEL_META: Record<
  NotificationChannelType,
  {
    label: string;
    icon: LucideIcon;
    secretLabel: string;
    secretHelp: string;
    /** An optional informational note shown as a callout in the channel card. */
    note?: string;
  }
> = {
  email: {
    label: 'Email (SMTP)',
    icon: Mail,
    secretLabel: 'SMTP password',
    secretHelp:
      'Your mailbox password or, for Gmail / Yahoo / iCloud, an APP PASSWORD (not your normal password). For SendGrid / Mailjet / Brevo this is the API key.',
  },
  resend: {
    label: 'Resend',
    icon: MailCheck,
    secretLabel: 'Resend API key',
    secretHelp:
      'A Resend API key (starts with re_). Create one at resend.com → API Keys with "Sending access". Stored write-only as a secret.',
    note:
      'Resend delivers over its HTTPS API (no SMTP). The From address MUST use a domain you have verified in the Resend dashboard (Domains → add + verify DNS) or sends are rejected.',
  },
  ses: {
    label: 'Amazon SES',
    icon: Cloud,
    secretLabel: 'SMTP password / IAM secret',
    secretHelp:
      'Either your SES SMTP password or, if you paste an IAM access-key id below, the matching IAM secret access key (the SMTP password is derived from it). Stored write-only as a secret.',
    note:
      'New SES accounts start in the SANDBOX: you can only send to verified identities and are rate-limited until you request production access in the SES console. Pick the AWS region your SES identities live in below.',
  },
  slack: {
    label: 'Slack',
    icon: Slack,
    secretLabel: 'Incoming Webhook URL',
    secretHelp:
      'A Slack Incoming Webhook URL (https://hooks.slack.com/services/...). Stored write-only as a secret.',
  },
  teams: {
    label: 'Microsoft Teams',
    icon: MessageSquare,
    secretLabel: 'Incoming Webhook URL',
    secretHelp: 'A Teams channel Incoming Webhook URL. Stored write-only as a secret.',
  },
  webhook: {
    label: 'Generic webhook',
    icon: Webhook,
    secretLabel: 'Webhook URL (secret)',
    secretHelp:
      'A JSON POST target. Use this secret field for a sensitive URL; a non-sensitive URL can go in the plain URL field below.',
  },
  pagerduty: {
    label: 'PagerDuty',
    icon: Zap,
    secretLabel: 'Routing (integration) key',
    secretHelp: 'A PagerDuty Events API v2 routing key for the target service.',
  },
  telegram: {
    label: 'Telegram',
    icon: Send,
    secretLabel: 'Bot token',
    secretHelp: 'Your Telegram bot token from @BotFather. The chat_id is set below.',
  },
};

const CHANNEL_TYPES: NotificationChannelType[] = [
  'email',
  'resend',
  'ses',
  'slack',
  'teams',
  'webhook',
  'pagerduty',
  'telegram',
];

/** Channel types whose config surface is e-mail-shaped (from + recipients). */
const EMAIL_LIKE: ReadonlySet<string> = new Set(['email', 'resend', 'ses']);

function channelIcon(type: string): LucideIcon {
  return CHANNEL_META[type as NotificationChannelType]?.icon ?? Bell;
}

function channelLabel(type: string): string {
  return CHANNEL_META[type as NotificationChannelType]?.label ?? type;
}

/** A short, friendly destination string for a channel (no secrets). */
function channelTarget(ch: NotificationChannel): string {
  const cfg = (ch.config || {}) as Record<string, unknown>;
  if (EMAIL_LIKE.has(ch.type)) {
    const r = cfg.recipients;
    const list = Array.isArray(r) ? r : typeof r === 'string' ? [r] : [];
    return list.length ? `${list.length} recipient(s)` : 'no recipients';
  }
  if (ch.type === 'telegram') return cfg.chat_id ? `chat ${String(cfg.chat_id)}` : 'no chat_id';
  if (ch.configured_secrets && ch.configured_secrets.length) return 'secret configured';
  if (cfg.url) return 'URL configured';
  return 'not configured';
}

function newChannelId(type: string, existing: NotificationChannel[]): string {
  const base = `${type}-`;
  let n = 1;
  const ids = new Set(existing.map((c) => c.id));
  while (ids.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

/* --------------------------------------------------------------- sub-bits --- */

function FieldRow({
  label,
  help,
  helpLink,
  children,
}: {
  label: string;
  help?: string;
  helpLink?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  // Associate the visible <Label> with the first native <Input> so clicking the label
  // focuses it and screen readers announce a name (G9 a11y). Selects in a FieldRow
  // already carry an aria-label on their trigger, so we only wire Inputs here.
  const kids = React.Children.toArray(children);
  let wired = false;
  const withId = kids.map((c) => {
    if (!wired && React.isValidElement(c) && c.type === Input && !(c.props as { id?: string }).id) {
      wired = true;
      return React.cloneElement(c as React.ReactElement<{ id?: string }>, { id });
    }
    return c;
  });
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={wired ? id : undefined}>{label}</Label>
        {help ? <HelpTip text={help} link={helpLink} label={`${label} help`} /> : null}
      </div>
      {withId}
    </div>
  );
}

/* ----------------------------------------------------------- channel card --- */

function ChannelEditor({
  channel,
  presets,
  onChange,
  onSecretApplied,
  onRemove,
}: {
  channel: NotificationChannel;
  presets: EmailPreset[];
  onChange: (next: NotificationChannel) => void;
  /**
   * Apply a secret-save/clear result (the configured-key names) by CHANNEL ID against
   * the freshest config in the parent — never by spreading the render-captured `channel`
   * (which would revert any edit made during the network round-trip).
   */
  onSecretApplied: (configuredSecrets: string[]) => void;
  onRemove: () => void;
}) {
  const Icon = channelIcon(channel.type);
  const meta = CHANNEL_META[channel.type as NotificationChannelType];
  const isEmailLike = EMAIL_LIKE.has(channel.type);
  const cfg = (channel.config || {}) as Record<string, unknown>;
  const setCfg = (patch: Record<string, unknown>) =>
    onChange({ ...channel, config: { ...cfg, ...patch } });

  const [secretDraft, setSecretDraft] = React.useState('');
  const [savingSecret, setSavingSecret] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const configured = Boolean(channel.configured_secrets && channel.configured_secrets.length);
  // A "Send test" delivers a REAL notification; block it while demo mode is active.
  const demoGuard = useDemoGuard();

  const recipients: string[] = React.useMemo(() => {
    const r = cfg.recipients;
    if (Array.isArray(r)) return r.map((x) => String(x));
    if (typeof r === 'string') return r.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    return [];
  }, [cfg.recipients]);
  const [recipientDraft, setRecipientDraft] = React.useState('');

  const selectedPreset = presets.find((p) => p.id === (cfg.provider || 'custom'));

  const applyPreset = (providerId: string) => {
    const p = presets.find((x) => x.id === providerId);
    const patch: Record<string, unknown> = { provider: providerId };
    if (p && providerId !== 'custom') {
      patch.host = p.host;
      patch.port = p.port;
      patch.security = p.security;
      if (p.fixed_username) patch.username = p.fixed_username;
    }
    setCfg(patch);
  };

  const saveSecret = async () => {
    const v = secretDraft.trim();
    if (!v) {
      toast.message('Enter a value first.');
      return;
    }
    setSavingSecret(true);
    try {
      const res = await api.notifications.channelSecret(channel.id, v);
      onSecretApplied(res.configured_secrets);
      setSecretDraft('');
      toast.success(`${meta?.secretLabel ?? 'Secret'} saved.`);
    } catch (e) {
      toast.error(errMsg(e, 'Could not save the secret.'));
    } finally {
      setSavingSecret(false);
    }
  };

  const clearSecret = async () => {
    setSavingSecret(true);
    try {
      const res = await api.notifications.channelSecret(channel.id, null);
      onSecretApplied(res.configured_secrets);
      toast.success('Secret cleared.');
    } catch (e) {
      toast.error(errMsg(e, 'Could not clear the secret.'));
    } finally {
      setSavingSecret(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await api.notifications.test(channel.id);
      if (res.ok) toast.success(`Test sent: ${res.detail || 'ok'}`);
      else toast.error(`Test failed: ${res.detail || 'unknown error'}`);
    } catch (e) {
      toast.error(errMsg(e, 'Test send failed.'));
    } finally {
      setTesting(false);
    }
  };

  const addRecipient = () => {
    const v = recipientDraft.trim();
    if (!v || recipients.includes(v)) {
      setRecipientDraft('');
      return;
    }
    setCfg({ recipients: [...recipients, v] });
    setRecipientDraft('');
  };

  return (
    <div
      className="space-y-4"
      data-settings-editor="notification-channel"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent text-primary">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <Input
              value={channel.name || ''}
              placeholder={channelLabel(channel.type)}
              aria-label="Channel name"
              className="h-7 w-48 max-w-full border-transparent bg-transparent px-1 text-sm font-semibold focus-visible:border-input"
              onChange={(e) => onChange({ ...channel, name: e.target.value })}
            />
            <p className="truncate px-1 text-xs text-muted-foreground">
              {channelLabel(channel.type)} · {channelTarget(channel)}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={Boolean(channel.enabled)}
            onCheckedChange={(v) => onChange({ ...channel, enabled: v })}
            aria-label="Channel enabled"
          />
          <Button variant="ghost" size="icon" aria-label="Remove channel" onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Provider note (Resend domain verification / SES sandbox / …) */}
      {meta?.note ? (
        <Alert>
          <Cloud className="h-4 w-4" aria-hidden />
          <AlertDescription>{meta.note}</AlertDescription>
        </Alert>
      ) : null}

      {/* Email-like config (SMTP email · Resend HTTPS API · Amazon SES) */}
      {isEmailLike ? (
        <div className="space-y-3">
          {/* SMTP preset + host/port/security/username — only for SMTP-based email + SES */}
          {channel.type === 'email' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <FieldRow
                  label="Provider preset"
                  help="Pick your email provider to prefill host / port / security. Gmail, Yahoo and iCloud require an app password as the secret below."
                >
                  <Select value={String(cfg.provider || 'custom')} onValueChange={applyPreset}>
                    <SelectTrigger aria-label="Provider preset">
                      <SelectValue placeholder="Select a provider" />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.id === 'custom' ? 'Custom (SMTP)' : p.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldRow>
                <FieldRow
                  label="From address"
                  help="The envelope/From email address sent on the message."
                >
                  <Input
                    type="email"
                    value={String(cfg.from_addr || '')}
                    placeholder="soc-alerts@example.com"
                    onChange={(e) => setCfg({ from_addr: e.target.value })}
                  />
                </FieldRow>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <FieldRow label="SMTP host">
                  <Input
                    value={String(cfg.host || '')}
                    placeholder={selectedPreset?.host || 'smtp.example.com'}
                    disabled={Boolean(cfg.provider && cfg.provider !== 'custom')}
                    onChange={(e) => setCfg({ host: e.target.value })}
                  />
                </FieldRow>
                {/* Nullish (not `||`) so a stored 0 shows 0 (not the 587 default). An
                    emptied field commits the preset's (or 587) default, so the displayed
                    value never diverges from what Save persists. */}
                <NumberField
                  label="Port"
                  value={Number(cfg.port ?? selectedPreset?.port ?? 587)}
                  min={1}
                  max={65535}
                  steppers={false}
                  defaultValue={selectedPreset?.port ?? 587}
                  disabled={Boolean(cfg.provider && cfg.provider !== 'custom')}
                  onChange={(v) => setCfg({ port: v })}
                />
                <FieldRow label="Security">
                  <Select
                    value={String(cfg.security || 'starttls')}
                    onValueChange={(v) => setCfg({ security: v })}
                  >
                    <SelectTrigger aria-label="Security">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="starttls">STARTTLS</SelectItem>
                      <SelectItem value="ssl">SSL/TLS</SelectItem>
                      <SelectItem value="none">None</SelectItem>
                    </SelectContent>
                  </Select>
                </FieldRow>
              </div>

              <FieldRow
                label="Username"
                help={selectedPreset?.username_hint || 'The SMTP login username.'}
              >
                <Input
                  value={String(cfg.username || '')}
                  placeholder={selectedPreset?.fixed_username || 'username'}
                  disabled={Boolean(selectedPreset?.fixed_username)}
                  onChange={(e) => setCfg({ username: e.target.value })}
                />
              </FieldRow>
            </>
          ) : (
            /* Resend + SES: just a From address (no SMTP host/port). */
            <FieldRow
              label="From address"
              help={
                channel.type === 'resend'
                  ? 'The From email. MUST use a domain verified in your Resend dashboard.'
                  : 'The From email. MUST be a verified SES identity (address or domain).'
              }
            >
              <Input
                type="email"
                value={String(cfg.from_addr || '')}
                placeholder="soc-alerts@example.com"
                onChange={(e) => setCfg({ from_addr: e.target.value })}
              />
            </FieldRow>
          )}

          {/* SES region + optional IAM access-key id (SES SMTP-or-IAM creds) */}
          {channel.type === 'ses' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <FieldRow
                label="AWS region"
                help="The SES region your verified identities live in, e.g. us-east-1. The SMTP endpoint is derived from it."
              >
                <Input
                  value={String(cfg.region || '')}
                  placeholder="us-east-1"
                  onChange={(e) => setCfg({ region: e.target.value })}
                />
              </FieldRow>
              <FieldRow
                label="IAM access key id (optional)"
                help="Leave blank if you pasted a ready-made SES SMTP password as the secret. If you paste your IAM access-key id here, the SMTP password is derived from the IAM secret you save below."
              >
                <Input
                  value={String(cfg.access_key_id || '')}
                  placeholder="AKIA…"
                  onChange={(e) => setCfg({ access_key_id: e.target.value })}
                />
              </FieldRow>
            </div>
          ) : null}

          {/* recipients (shared across all email-like channels) */}
          <FieldRow label="Recipients" help="Email addresses that receive alerts from this channel.">
            <Input
              value={recipientDraft}
              placeholder="Type an email and press Enter"
              onChange={(e) => setRecipientDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addRecipient();
                }
              }}
            />
            {recipients.length ? (
              <div className="flex flex-wrap gap-1.5 pt-1.5">
                {recipients.map((r) => (
                  <Badge key={r} variant="outline" className="gap-1 pr-0.5">
                    <span className="truncate">{r}</span>
                    <IconButton
                      label={`Remove ${r}`}
                      tooltip={false}
                      size="sm"
                      variant="ghost"
                      onClick={() => setCfg({ recipients: recipients.filter((x) => x !== r) })}
                    >
                      <X aria-hidden />
                    </IconButton>
                  </Badge>
                ))}
              </div>
            ) : null}
          </FieldRow>
        </div>
      ) : null}

      {/* Telegram chat id */}
      {channel.type === 'telegram' ? (
        <FieldRow label="Chat ID" help="The target Telegram chat/channel id the bot posts to.">
          <Input
            value={String(cfg.chat_id || '')}
            placeholder="123456789"
            onChange={(e) => setCfg({ chat_id: e.target.value })}
          />
        </FieldRow>
      ) : null}

      {/* PagerDuty source name */}
      {channel.type === 'pagerduty' ? (
        <FieldRow label="Source name" help="A label shown as the event source in PagerDuty.">
          <Input
            value={String(cfg.source_name || '')}
            placeholder="Agentic SOC"
            onChange={(e) => setCfg({ source_name: e.target.value })}
          />
        </FieldRow>
      ) : null}

      {/* Generic webhook non-secret URL */}
      {channel.type === 'webhook' ? (
        <FieldRow
          label="Webhook URL (non-secret)"
          help="A non-sensitive JSON POST target. For a sensitive URL, use the secret field below instead."
        >
          <Input
            value={String(cfg.url || '')}
            placeholder="https://example.com/hooks/soc"
            onChange={(e) => setCfg({ url: e.target.value })}
          />
        </FieldRow>
      ) : null}

      {/* Write-only secret — the shared SecretField primitive (uniform reveal toggle +
          boolean status pill + explicit clear). An empty Save is blocked by saveSecret()
          so a stored secret can never be clobbered with a blank value. */}
      <Separator />
      <div className="space-y-2">
        <SecretField
          label={meta?.secretLabel ?? 'Secret'}
          labelAction={
            meta?.secretHelp ? <HelpTip text={meta.secretHelp} label="Secret help" /> : undefined
          }
          description="Write-only: the console only knows whether it is configured, never the value."
          configured={configured}
          value={secretDraft}
          onChange={setSecretDraft}
          disabled={savingSecret}
          placeholder={configured ? '•••••••• (enter a new value to replace)' : 'Enter a value'}
          onClear={configured ? () => void clearSecret() : undefined}
          configuredLabel="Configured"
        />
        <Button size="sm" variant="outline" disabled={savingSecret} onClick={() => void saveSecret()}>
          {savingSecret ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {/* Send test — disabled in demo mode (would deliver a real notification). */}
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          disabled={testing || demoGuard.disabled}
          title={demoGuard.disabled ? demoGuard.reason : undefined}
          aria-disabled={demoGuard.disabled || undefined}
          onClick={() => void sendTest()}
        >
          <Send className="h-4 w-4" aria-hidden />
          {testing ? 'Sending…' : 'Send test'}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ add dialog --- */

function AddChannelDialog({
  open,
  onOpenChange,
  onAdd,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdd: (type: NotificationChannelType) => void;
  /** Hands focus back to the Add channel button (SPEC §3.3). */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>Add a channel</DialogTitle>
          <DialogDescription>Pick where these alerts should be delivered.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 py-2">
          {CHANNEL_TYPES.map((t) => {
            const Icon = CHANNEL_META[t].icon;
            return (
              <button
                key={t}
                type="button"
                onClick={() => {
                  onAdd(t);
                  onOpenChange(false);
                }}
                className="flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-3 text-left text-sm font-medium transition-colors hover:border-primary hover:bg-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className="h-4 w-4 text-primary" aria-hidden />
                {CHANNEL_META[t].label}
              </button>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------- template editor */

/** Human label per template trigger. */
const TRIGGER_LABEL: Record<NotificationTemplateTrigger, string> = {
  'case.new': 'New case',
  'case.escalation': 'Case escalated',
  'case.resolved': 'Case resolved',
  'digest.daily': 'Daily digest',
  test: 'Test message',
};

/**
 * A best-effort default variable reference list shown until the server returns its
 * authoritative whitelist (PREVIEW response `variables`). Display-only — interpolation
 * + escaping is done SERVER-SIDE; the UI never renders these against real case data.
 */
const DEFAULT_TEMPLATE_VARS: readonly string[] = [
  'org_name',
  'case_id',
  'case_url',
  'title',
  'entity',
  'verdict',
  'disposition',
  'status',
  'risk_score',
  'severity_label',
  'rule',
  'source_name',
  'summary',
];

/** Build a NotificationTemplate from the current draft, dropping empty parts. */
function draftToTemplate(draft: { subject: string; html: string; text: string }): NotificationTemplate {
  const t: NotificationTemplate = {};
  if (draft.subject.trim()) t.subject = draft.subject;
  if (draft.html.trim()) t.html = draft.html;
  if (draft.text.trim()) t.text = draft.text;
  return t;
}

function TemplateEditor({
  templates,
  onChange,
}: {
  templates: NotificationTemplates;
  onChange: (next: NotificationTemplates) => void;
}) {
  const [trigger, setTrigger] = React.useState<NotificationTemplateTrigger>('case.new');
  const current = templates[trigger] || {};
  const hasOverride = Boolean(current.subject || current.html || current.text);

  // Local editable draft, re-seeded whenever the selected trigger / stored override
  // changes. Empty parts mean "inherit the built-in default" on save.
  const [draft, setDraft] = React.useState({
    subject: current.subject || '',
    html: current.html || '',
    text: current.text || '',
  });
  React.useEffect(() => {
    setDraft({
      subject: current.subject || '',
      html: current.html || '',
      text: current.text || '',
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger, current.subject, current.html, current.text]);

  const [preview, setPreview] = React.useState<NotificationPreview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);

  const persistDraft = () => {
    const tmpl = draftToTemplate(draft);
    const next: NotificationTemplates = { ...templates };
    if (Object.keys(tmpl).length === 0) delete next[trigger];
    else next[trigger] = tmpl;
    onChange(next);
  };

  const revertToDefault = () => {
    setDraft({ subject: '', html: '', text: '' });
    const next: NotificationTemplates = { ...templates };
    delete next[trigger];
    onChange(next);
    setPreview(null);
  };

  // Live preview: the SERVER renders the (unsaved) draft against a sample case and
  // returns the already-escaped subject/html/text — authoritative for #9.
  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const tmpl = draftToTemplate(draft);
      const res = await api.notifications.preview(
        trigger,
        Object.keys(tmpl).length ? tmpl : undefined,
      );
      setPreview(res);
    } catch (e) {
      setPreviewError(errMsg(e, 'Could not render the preview.'));
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  const vars = preview?.variables?.length ? preview.variables : DEFAULT_TEMPLATE_VARS;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FieldRow
          label="Template"
          help="Override the subject / HTML / plain-text body for one trigger. Leave a field blank to inherit the built-in default. The server renders + escapes every case value (the live preview is authoritative)."
        >
          <Select
            value={trigger}
            onValueChange={(v) => setTrigger(v as NotificationTemplateTrigger)}
          >
            <SelectTrigger aria-label="Template trigger" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {NOTIFICATION_TEMPLATE_TRIGGERS.map((t) => (
                <SelectItem key={t} value={t}>
                  {TRIGGER_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
        <div className="flex items-center gap-2">
          {hasOverride ? (
            <Badge variant="success" className="gap-1">
              <Check className="h-3 w-3" aria-hidden />
              Override
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              Default
            </Badge>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasOverride && !draft.subject && !draft.html && !draft.text}
            onClick={revertToDefault}
          >
            <RotateCcw className="h-4 w-4" aria-hidden />
            Revert to default
          </Button>
        </div>
      </div>

      {/* The preview sits below the editor under 1536px and beside it from there. */}
      <div className="grid gap-4 2xl:grid-cols-2" data-testid="template-editor-grid">
        {/* --- the editable template parts --- */}
        <div className="space-y-3">
          <FieldRow label="Subject" help="The email Subject line. Header-injection chars are stripped server-side.">
            <Input
              value={draft.subject}
              placeholder="[{{org_name}}] {{title}}"
              aria-label="Template subject"
              onChange={(e) => setDraft((d) => ({ ...d, subject: e.target.value }))}
              onBlur={persistDraft}
            />
          </FieldRow>
          <FieldRow
            label="HTML body"
            help="The HTML part. {{var}} is auto-escaped; {{{raw}}} is allowed ONLY for trusted header HTML. Blank inherits the default."
          >
            <Textarea
              value={draft.html}
              rows={8}
              placeholder="<h2>{{title}}</h2> …"
              aria-label="Template HTML body"
              className="font-mono text-xs"
              onChange={(e) => setDraft((d) => ({ ...d, html: e.target.value }))}
              onBlur={persistDraft}
            />
          </FieldRow>
          <FieldRow
            label="Plain-text body"
            help="The text/plain part for clients without HTML. Newlines in untrusted vars are stripped server-side."
          >
            <Textarea
              value={draft.text}
              rows={6}
              placeholder={'{{title}}\nRisk: {{risk_score}}\n{{case_url}}'}
              aria-label="Template plain-text body"
              className="font-mono text-xs"
              onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
              onBlur={persistDraft}
            />
          </FieldRow>

          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="secondary" disabled={previewing} onClick={() => void runPreview()}>
              <Eye className="h-4 w-4" aria-hidden />
              {previewing ? 'Rendering…' : 'Render preview'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Edits save with the rest of Settings.
            </p>
          </div>

          {/* variable reference list */}
          <div className="space-y-1.5 border-t border-border/70 pt-3">
            <p className="text-sm font-medium text-foreground">Available variables</p>
            <div className="flex flex-wrap gap-1.5">
              {vars.map((v) => (
                <code
                  key={v}
                  className="rounded bg-accent px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                >
                  {`{{${v}}}`}
                </code>
              ))}
            </div>
          </div>
        </div>

        {/* --- the SERVER-rendered preview --- */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">Preview</p>
          {previewError ? (
            <Alert variant="destructive">
              <X className="h-4 w-4" aria-hidden />
              <AlertTitle>Preview failed</AlertTitle>
              <AlertDescription>{previewError}</AlertDescription>
            </Alert>
          ) : null}

          {preview ? (
            <div className="space-y-3">
              <div className="border-y border-border/70 py-2">
                <p className="text-xs font-medium text-muted-foreground">Subject</p>
                <p className="break-words text-sm font-medium text-foreground">{preview.subject}</p>
              </div>
              <Tabs defaultValue="html">
                <TabsList>
                  <TabsTrigger value="html">
                    <FileText className="h-3.5 w-3.5" aria-hidden />
                    HTML
                  </TabsTrigger>
                  <TabsTrigger value="text">
                    <Code2 className="h-3.5 w-3.5" aria-hidden />
                    Plain text
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="html">
                  {/* The server already escaped every interpolated case value (#9).
                      Render it in a SANDBOXED iframe with no script/same-origin so even
                      a malformed override cannot run script or touch the console. */}
                  <iframe
                    title="Email HTML preview"
                    sandbox=""
                    srcDoc={preview.html}
                    className="h-80 w-full rounded-md border border-border bg-white"
                  />
                </TabsContent>
                <TabsContent value="text">
                  <pre className="h-80 overflow-auto rounded-md border border-border bg-surface p-3 font-mono text-xs text-foreground">
                    {preview.text}
                  </pre>
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <div className="flex h-80 flex-col items-center justify-center rounded-md border border-border/70 text-center">
              <Eye className="h-5 w-5 text-muted-foreground" aria-hidden />
              <p className="mt-2 max-w-xs text-sm text-muted-foreground">
                Render a preview to see the server-escaped subject, HTML, and plain-text
                parts for the selected trigger.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- editor -- */

export interface NotificationsEditorProps {
  prefs: Preferences;
  update: (patch: Partial<Preferences>) => void;
}

/** The section's help text outside the Settings page (inside it, the registry's help wins). */
const NOTIFICATIONS_HELP =
  'Send alerts about decided cases to email, chat, paging or webhook channels. Notifications never change a case decision.';

export function NotificationsEditor({ prefs, update }: NotificationsEditorProps) {
  const section = React.useContext(SettingsSectionContext);
  const notif: NotificationConfig = prefs.notifications || {};
  const setNotif = (patch: Partial<NotificationConfig>) =>
    update({ notifications: { ...notif, ...patch } });

  const channels = notif.channels || [];
  const triggers = notif.triggers || {};
  const digest = notif.digest || {};
  const templates = notif.templates || {};

  const [providers, setProviders] = React.useState<NotificationProviders | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const addChannelOpener = useReturnFocus();
  const [recipientDraft, setRecipientDraft] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    void api.notifications
      .providers()
      .then((p) => {
        if (!cancelled) setProviders(p);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const presets: EmailPreset[] = providers?.email_presets || [];

  // Freshest notifications config, for async callbacks (secret save/clear) that resolve
  // after the operator may have edited another field. Reading this ref instead of the
  // render-captured `notif` avoids clobbering concurrent edits made during the round-trip.
  const notifRef = React.useRef(notif);
  notifRef.current = notif;

  const setChannel = (idx: number, next: NotificationChannel) => {
    const list = channels.slice();
    list[idx] = next;
    setNotif({ channels: list });
  };

  // Merge a secret-save result into the channel BY ID against the freshest config.
  const applyChannelSecret = (channelId: string, configuredSecrets: string[]) => {
    const cur = notifRef.current;
    const list = (cur.channels || []).map((c) =>
      c.id === channelId ? { ...c, configured_secrets: configuredSecrets } : c,
    );
    update({ notifications: { ...cur, channels: list } });
  };
  const removeChannel = (idx: number) => {
    setNotif({ channels: channels.filter((_, i) => i !== idx) });
  };
  const addChannel = (type: NotificationChannelType) => {
    const id = newChannelId(type, channels);
    let config: Record<string, unknown> = {};
    if (type === 'email') config = { provider: 'custom', security: 'starttls', recipients: [] };
    else if (type === 'resend') config = { recipients: [] };
    else if (type === 'ses') config = { region: '', recipients: [] };
    const ch: NotificationChannel = {
      id,
      type,
      enabled: true,
      name: CHANNEL_META[type].label,
      config,
      configured_secrets: [],
    };
    setNotif({ channels: [...channels, ch] });
  };

  const defaultRecipients = notif.default_recipients || [];
  const addDefaultRecipient = () => {
    const v = recipientDraft.trim();
    if (!v || defaultRecipients.includes(v)) {
      setRecipientDraft('');
      return;
    }
    setNotif({ default_recipients: [...defaultRecipients, v] });
    setRecipientDraft('');
  };

  const minRisk = typeof triggers.min_risk === 'number' ? triggers.min_risk : 0;
  const setTriggers = (patch: Partial<typeof triggers>) =>
    setNotif({ triggers: { ...triggers, ...patch } });

  const triggerRows: Array<{ key: keyof typeof triggers; label: string; help?: string }> = [
    {
      key: 'on_case_created',
      label: 'On case created',
      help: 'Notify when a new case is created. This can be noisy on a busy stack.',
    },
    { key: 'on_escalated', label: 'On escalated' },
    { key: 'on_true_positive', label: 'On true positive' },
    { key: 'on_needs_human', label: 'On needs human' },
    { key: 'on_closed', label: 'On closed or resolved' },
  ];

  return (
    <div data-testid="notifications-settings-surface">
      <SettingsSection
        title={section.title ?? 'Alerting & notifications'}
        help={section.help ?? NOTIFICATIONS_HELP}
      >
        <SettingsGroup title="Notifications" className={SETTINGS_FORM_MAX_WIDTH}>
          <SettingRow
            variant="switch"
            label="Notifications enabled"
            help="The master switch. When it is off, nothing is sent, whatever the channels and triggers below say."
            checked={Boolean(notif.enabled)}
            onCheckedChange={(v) => setNotif({ enabled: v })}
          />
          {/* Off is a live condition, stated in words under the switch. The groups below
              stay at full contrast because they remain editable (WCAG 1.4.3, no dimming). */}
          {!notif.enabled ? (
            <SettingRow variant="block">
              <Callout intent="warning" data-testid="notifications-off-callout">
                Notifications are off. Nothing is sent until you turn them on.
              </Callout>
            </SettingRow>
          ) : null}
        </SettingsGroup>

        {/* The form groups keep the 44rem form measure so a switch stays near its label;
            only the email templates (editor beside its preview) take the full width
            (SPEC §4.9.6). */}
        <div className="space-y-10" data-notifications-active={notif.enabled ? 'true' : 'false'}>
          <SettingsGroup
            className={SETTINGS_FORM_MAX_WIDTH}
            title="Channels"
            caption="Where alerts go: email, chat, paging or a webhook. Secrets save as soon as you set them."
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  addChannelOpener.remember();
                  setAddOpen(true);
                }}
              >
                <Plus aria-hidden />
                Add channel
              </Button>
            }
          >
            {channels.length === 0 ? (
              <SettingRow variant="block">
                <div className="py-3 text-center">
                  <Bell className="mx-auto size-5 text-muted-foreground" aria-hidden />
                  <p className="mt-2 text-sm text-muted-foreground">
                    No channels yet. Add one to start receiving alerts.
                  </p>
                </div>
              </SettingRow>
            ) : (
              channels.map((ch, idx) => (
                <SettingRow variant="block" key={ch.id}>
                  <ChannelEditor
                    channel={ch}
                    presets={presets}
                    onChange={(next) => setChannel(idx, next)}
                    onSecretApplied={(secrets) => applyChannelSecret(ch.id, secrets)}
                    onRemove={() => removeChannel(idx)}
                  />
                </SettingRow>
              ))
            )}
          </SettingsGroup>

          <SettingsGroup
            title="Email templates"
            caption="The subject, HTML and plain-text body the email channels (SMTP, Resend, SES) send. Each trigger uses a built-in default until you change it; the server escapes every case value."
          >
            <SettingRow variant="block">
              <TemplateEditor
                templates={templates}
                onChange={(next) => setNotif({ templates: next })}
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup
            className={SETTINGS_FORM_MAX_WIDTH}
            title="Triggers"
            caption="Which case events send a notification. Cases that need a person are always held for an analyst; this only decides whether you hear about it."
          >
            {triggerRows.map((row) => (
              <SettingRow
                key={row.key}
                variant="switch"
                label={row.label}
                help={row.help}
                checked={Boolean(triggers[row.key])}
                onCheckedChange={(v) => setTriggers({ [row.key]: v } as Partial<typeof triggers>)}
              />
            ))}
            <SettingRow variant="block">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-base font-medium leading-5 text-foreground">Minimum risk to notify</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      Cases below this risk (0 to 100) never send a notification, even when a trigger matches.
                    </p>
                  </div>
                  <span className="shrink-0 text-base font-semibold tabular-nums text-foreground">{minRisk}</span>
                </div>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={[minRisk]}
                  onValueChange={(vals) => setTriggers({ min_risk: vals[0] ?? 0 })}
                  aria-label="Minimum risk to notify"
                />
              </div>
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title="Delivery controls" className={SETTINGS_FORM_MAX_WIDTH}>
            <SettingRow variant="field">
              <NumberField
                label="Dedup window"
                description="Suppress duplicate alerts for the same case and trigger within this window."
                value={notif.dedup_window_seconds ?? 300}
                min={0}
                unit="s"
                defaultValue={300}
                onChange={(v) => setNotif({ dedup_window_seconds: v })}
              />
            </SettingRow>
            <SettingRow variant="field">
              <NumberField
                label="Rate limit per channel"
                description="Cap the notifications a single channel may send each hour. 0 means unlimited."
                value={notif.rate_limit_per_hour ?? 60}
                min={0}
                unit="per hour"
                defaultValue={60}
                onChange={(v) => setNotif({ rate_limit_per_hour: v })}
              />
            </SettingRow>
            <SettingRow
              variant="switch"
              label="Batch into a digest"
              help="Matching events are batched per channel and sent together on the interval below instead of one by one."
              checked={Boolean(digest.enabled)}
              onCheckedChange={(v) => setNotif({ digest: { ...digest, enabled: v } })}
            />
            {digest.enabled ? (
              <SettingRow variant="field">
                <NumberField
                  label="Digest interval"
                  value={digest.interval_minutes ?? 60}
                  min={1}
                  unit="min"
                  defaultValue={60}
                  onChange={(v) => setNotif({ digest: { ...digest, interval_minutes: v } })}
                />
              </SettingRow>
            ) : null}
            <SettingRow variant="block">
              <FieldRow
                label="Default recipients"
                help="Fallback email recipients used by email channels that do not set their own."
              >
                <Input
                  value={recipientDraft}
                  placeholder="Type an email and press Enter"
                  onChange={(e) => setRecipientDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addDefaultRecipient();
                    }
                  }}
                />
                {defaultRecipients.length ? (
                  <div className="flex flex-wrap gap-1.5 pt-1.5">
                    {defaultRecipients.map((r) => (
                      <Badge key={r} variant="outline" className="gap-1 pr-0.5">
                        <span className="truncate">{r}</span>
                        <IconButton
                          label={`Remove ${r}`}
                          tooltip={false}
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setNotif({ default_recipients: defaultRecipients.filter((x) => x !== r) })
                          }
                        >
                          <X aria-hidden />
                        </IconButton>
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </FieldRow>
            </SettingRow>
            <SettingRow variant="block">
              <FieldRow
                label="Console base URL"
                help="Used to build a case link in the alert body, for example https://soc.example.com. Leave it blank for no link."
              >
                <Input
                  value={notif.base_url || ''}
                  placeholder="https://soc.example.com"
                  onChange={(e) => setNotif({ base_url: e.target.value })}
                />
              </FieldRow>
            </SettingRow>
          </SettingsGroup>
        </div>
      </SettingsSection>

      <AddChannelDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdd={addChannel}
        onCloseAutoFocus={addChannelOpener.onCloseAutoFocus}
      />
    </div>
  );
}

export default NotificationsEditor;
