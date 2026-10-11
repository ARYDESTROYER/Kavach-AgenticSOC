---
title: Branding and customization
description: Configure organization branding, terminology, themes, saved views, and personal preferences.
---

# Branding and customization

Agentic SOC has two customization scopes: organization defaults and personal preferences.
Organization settings establish the shared console vocabulary and appearance; user
preferences can override supported presentation choices without changing other users.

## Organization branding

Administrators can configure:

- organization and product names;
- bounded logo and favicon data URLs;
- primary/secondary accent colors;
- default dark, light, or system theme;
- quiet or command material treatment;
- login headline, body, feature chips, layout, and a built-in illustration;
- footer text and support URL.

Login copy is bounded plain text. Markup is rejected. Theme-token keys are allow-listed
and unsafe CSS values are discarded; derived accessible foreground tokens are not
operator-overridable.

Preview both color modes and the login screen before saving. A technically valid brand
color can still be unsuitable for charts, screenshots, or an organization's own
accessibility requirements.

## Terminology

Terminology overrides change human-facing labels, not API field names, stored schema,
or deterministic behavior. Document organization-specific terms so support and audit
teams can map them back to the canonical concepts: event, detection, alert, case, and
campaign.

## Personal preferences

Users can keep their own theme choice, saved views, and table-column layouts. Effective
preferences layer user choices over organization defaults. Saved views may be created,
updated, deleted, and cloned; they are not a security boundary and never grant access
to data the user otherwise cannot read.

**Reduce transparency**, under **Settings → Account → Appearance & customization**,
shows the top bar and sticky toolbars as solid surfaces instead of frosted glass.
**System** follows the device's Reduce transparency setting where the browser reports
it; Safari and Firefox do not pass that setting on, so choose **On** to apply it there.
The choice is saved to the user's account. The console also honours the device's
reduced-motion and increased-contrast settings.

A few other presentation choices follow the user across devices: the Workspace Chat
width (Comfortable, Wide, or Full width) and whether the Overview's **Deeper
analytics** section is open.

## The logo while chat works

While Workspace Chat writes an answer, a thin ring can turn around the logo tile in the
navigation, in addition to the indicator on the Chat item. Administrators turn it off
with **Animate the logo while chat works** under **Settings → General → Chat
assistant**. A custom logo is never animated itself: only the ring around it moves, and
with reduced motion the ring stands still.

## Dashboards

Custom dashboards are stored per user. A user can clone a default and arrange existing
widget types. Dashboard widgets consume existing aggregate APIs; creating a dashboard
does not create a new detector or change case policy.

## Recovery

Keep a record of the prior organization values before a broad visual or terminology
change. Version 0.1 does not provide universal branding-history rollback. If a theme
becomes unusable, an administrator can restore conservative values through the API or
state backup; a factory reset is unnecessary.

See [Users and RBAC](users-rbac.md), [Settings administration](settings.md), and
[Health, backup, and restore](../operations/health-backup.md).
