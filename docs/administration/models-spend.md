---
title: Models and spend controls
description: Configure model routing, provider connectivity, pricing, and cost limits in Agentic SOC 0.1.
---

# Models and spend controls

Every LLM call passes through one gateway and produces a usage-ledger record. Model
selection controls quality and latency; the budget gate controls whether a new
provider call may begin. Neither can override the deterministic case decision.

## Configure providers

Agentic SOC supports configured catalog providers, cloud-specific provider settings, and
operator-registered OpenAI-compatible endpoints such as LiteLLM or self-hosted model
servers. Provider credentials remain in the secret tier.

Use **Models** to:

1. confirm that the intended provider is configured;
2. test connectivity with `/api/llm/models/test` or `/api/llm/providers/test`;
3. assign models to router, investigator, chat, and other configured roles;
4. review capability and pricing information;
5. estimate a call before applying a change.

A connectivity test is not a quality, privacy, or capacity certification. Validate
data-processing terms, regional routing, rate limits, context limits, and failure
behavior independently.

## Cost accounting

Usage records include input/output tokens and supported cache or batch adjustments.
Catalog prices can be overlaid by an administrator. Price overlays affect Agentic SOC's
estimate and ledger; they do not change provider billing.

Custom self-hosted/OpenAI-compatible models are represented as zero-priced unless an
operator supplies an appropriate accounting model. Zero in the Agentic SOC ledger does not
mean the infrastructure, GPU, network, or upstream proxy is free.

## Discounted inference

Open **Analytics → Jobs** to configure two independent paths. Neither changes
the prompt, model verdict, deterministic close/escalate authority, or requirement for
one usage-ledger row per resolved call.

### Live OpenAI Flex preference

Compatible alert/case inference prefers live Flex by default. The gateway requests
Flex only when all of these are true:

- the surface is automated scan or entity/case investigation;
- `prefer_discounted_alerts` is enabled;
- the configured provider is official OpenAI, not Azure or a custom/OpenAI-compatible
  base URL; and
- the model family is GPT-5, o3, or o4-mini.

Chat, standup, per-log overview, embeddings, and provider/model tests remain standard service.
Unsupported combinations are routed to standard service before a provider call and
are never labelled or priced as discounted.

Fresh installations assign the bundled OpenAI model ID `gpt-5.6-luna` to every completion role,
so eligible alert/case calls can use Flex without a separate model reassignment.
Embeddings remain on the dedicated `text-embedding-3-small` model. Existing stored
role assignments are not rewritten, and every alternate provider/model remains
available in Settings.

The bundled short-context Luna Standard ledger rate is configured as $0.20/M input,
$0.02/M cached input, $0.25/M cache write, and $1.20/M output. The bundled Batch and
Flex multipliers are one half of those values. Treat these as release catalog values,
not a provider invoice or timeless pricing claim: compare them with the current
[OpenAI pricing documentation](https://developers.openai.com/api/docs/pricing) and
your account contract before production use. Agentic SOC applies the configured
half-rate only to an asynchronous Batch result or a live response whose returned
service tier is Flex; a request or attempted route alone never earns the discount.

Agentic SOC sends Luna through the existing Chat Completions adapter with
`reasoning_effort: none`. This preserves the previous non-reasoning latency/cost
baseline and function-tool compatibility instead of silently inheriting GPT-5.6's
`medium` reasoning default. Change models only after comparing representative cases;
reasoning-heavy tool workflows should be evaluated separately on the Responses API.

Flex is best-effort capacity. With `fallback_to_standard` enabled (the default), an
OpenAI 429 or a Flex/service-tier-specific 400 is retried without the Flex request.
That fallback result is truthfully recorded at standard pricing. The ledger uses the
provider's returned tier, so requesting Flex does not by itself earn a discount.

### Asynchronous Batch queue

`batch.enabled` is a separate, opt-in delayed path for eligible low-urgency
event-detection work. Its severity floor and provider allow-list do not control the
live preference above. Anthropic Message Batches and OpenAI
Batch results can arrive out of order, so retrieval is keyed by `custom_id`; each
result is written to the ledger exactly once at the 0.5× batch multiplier.

The same Jobs surface first shows each actor's application jobs, then exposes related
provider Batch rows only to `models:read`. The latter are read-only shared projections:
they do not acquire application-job Cancel or Download actions. Scheduler worker health
can also appear for `automation:read`, but those rows are list-only and never personal
Inbox notifications.

New local Batch rows freeze a strict audience snapshot of at most 200 active accounts
whose effective grants include `models:read`. One generation-bound stable Inbox note per
snapshotted recipient carries only safe provider/model copy, request progress, and
terminal counts. Authorization-store outage remains pending/retryable; permission or
account-generation loss removes and fail-closed filters the note. The audience never
expands later, so later users/grants, legacy rows, and recipients beyond the bound remain
Jobs-list-only. Batch notes have no Cancel, Download, or completion toast. The bounded
audience/outbox contract is regression-backed, while the Jobs list remains authoritative
for every non-recipient. See
[Background jobs](../operations/background-jobs.md).

## Budget gate

The default balanced configuration enables a **$10 daily** LLM backstop, warns at
80%, and blocks new calls at the ceiling. Monthly limits are optional. When blocking
is selected, a denied investigation fails safe to `NEEDS_HUMAN`; the alert/case is not
dropped and the decision code does not auto-close it.

The budget check is a preflight comparison rather than an atomic reservation. Calls
already in flight may complete slightly beyond the configured limit. Configure
provider-side budgets and alerts as the final financial backstop.

## Change procedure

- Test a provider before routing production work to it.
- Change one role at a time and compare representative cases.
- Set explicit daily and provider-side limits.
- Monitor `/api/budget/status` and usage analytics.
- Keep a tested fallback model/provider.
- Treat model output and provider failures as evidence for human review, never as
  authority to bypass case policy.

Discounted modes can reduce cost but can increase latency or have limited capacity.
The live Flex preference is on by default for the narrow eligible path above; the
asynchronous Batch queue remains opt-in. Reconcile the Agentic SOC ledger with the
provider invoice rather than assuming a requested tier was discounted. See
[Settings administration](settings.md), [Background jobs](../operations/background-jobs.md),
and [Health, backup, and restore](../operations/health-backup.md).
