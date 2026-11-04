---
title: Documentation versions
description: How installed, Stable, and Development documentation relate to Agentic SOC application releases.
---

# Documentation versions

Agentic SOC ships version-matched documentation with the application. The documentation
served by the running app is the authority for its controls and behavior; the public
Stable site and Development source are secondary destinations for upgrade planning
and previewing future work.

## Which documentation should I use?

| Destination | What it represents | Use it for |
| --- | --- | --- |
| **Installed version** | The Help Center built from the same accepted source as the running application and served on that application origin at `/docs/0.1/` | Daily use, administration, troubleshooting, and every decision about the running build |
| **Latest Stable** | Documentation built from the latest immutable release tag on the verified `main` source for the supported release line | Upgrade evaluation, current supported guidance, and comparison with an older installation |
| **Development** | Documentation source integrated on `Testing` but not yet promoted and tagged | Preview and review only; never assume it describes the installed application |

Open **Help Center** from the bottom of the application navigation to enter the
installed Help Center. GitHub remains the source/edit location and an escape hatch
for newer material; it is not the primary product-help destination.

## Installed documentation contract

Every application build carries two related identifiers:

- the full product SemVer, such as **0.1.13**; and
- the compatible documentation line, such as **0.1**.

The documentation build and the application build originate from the same source
commit. The web image includes the generated static Help Center and serves it from
the same origin as the Console. That provides four useful guarantees:

1. documentation remains available in an offline or isolated self-hosted deployment;
2. following an in-app documentation link does not leave the application by default;
3. the installed guide cannot silently change underneath a pinned application image;
4. a release artifact and its instructions can be traced to the same source identity.

The installed Help Center does **not** show a blanket “may be outdated” warning. It
is intentionally accurate for that installed build. A notice is appropriate only
when the reader chooses an older public documentation version or follows a link to
newer Stable or Development material.

## Version mapping

| Documentation label | Application SemVer | Source identity | Channel |
| --- | --- | --- | --- |
| 0.1 installed Testing guide | 0.1.13 | candidate commit on `Testing` | Testing |
| 0.1 installed prior Stable guide | 0.1.1 | verified `main` commit tagged `v0.1.1` | Stable |
| 0.1 historical Testing guide | 0.1.2 | unpublished Testing snapshot; not a Stable tag or operational bootstrap source | Testing archive |
| 0.1 historical Testing guide | 0.1.3 | unpublished Testing snapshot; not a Stable tag or artifact source | Testing archive |
| 0.1 failed-publication guide | 0.1.4 | immutable `v0.1.4` tag and documentation only; no GitHub Release, signed plan, or release image | Historical, non-installable |
| 0.1 failed-publication guide | 0.1.5 | immutable `v0.1.5` tag; candidate image digests built and signed, but no canonical plan, GitHub Release, or Stable tags | Historical, non-installable |
| 0.1 published-but-bootstrap-blocked guide | 0.1.6 | immutable `v0.1.6` tag plus public signed images, plan, bundle, and GitHub Release; canonical Bash 3.2 bootstrap acceptance failed before supervisor installation | Historical, superseded; not a supported bootstrap source |
| 0.1 published-but-bootstrap-blocked guide | 0.1.7 | immutable `v0.1.7` tag plus public signed images, plan, bundle, and GitHub Release; canonical updater control-socket startup failed under the shipped capability boundary | Historical, superseded; not a supported bootstrap source |
| 0.1 published-but-bootstrap-blocked guide | 0.1.8 | immutable `v0.1.8` tag plus public signed images, plan, bundle, and GitHub Release; canonical signed-plan verification failed because cosign's default TUF cache was unwritable beneath the read-only root filesystem | Historical, superseded; not a supported bootstrap source |
| 0.1 failed-publication guide | 0.1.9 | immutable `v0.1.9` tag plus public signed digest images and a generated signed plan; constrained-updater fixture failed before attestations, GitHub Release, plan-asset publication, Stable convenience tags, or Stable documentation | Historical, non-installable |
| 0.1 failed-publication guide | 0.1.10 | immutable `v0.1.10` tag and green exact-tag source CI; signed-release job timed out during the emulated Web Console builder before the complete signed artifact set, canonical Release, or Stable documentation existed | Historical, non-installable |
| 0.1 failed-publication guide | 0.1.11 | immutable `v0.1.11` tag plus public signed digest images and a generated signed plan that verified on the host and inside the constrained updater; post-verification cleanup failed before attestations, GitHub Release, plan assets, Stable tags, or Stable documentation | Historical, non-installable |
| 0.1 published-but-bootstrap-blocked guide | 0.1.12 | immutable `v0.1.12` tag plus the complete public signed release, canonical plan and bundle, Stable documentation, anonymous digest reads, and verified keyless signatures; canonical v0.1.1 bootstrap rejected matching absent legacy schema labels before application mutation | Historical, superseded; not a supported bootstrap source |
| 0.1 prospective 0.1.13 Stable guide | 0.1.13 | exact verified `main` commit after it is tagged `v0.1.13` and all signed/public artifacts plus updater runtime and canonical deployment acceptance pass | Candidate; Stable only after full acceptance |
| 0.1 public Stable guide | 0.1.x | current immutable release tag for the supported 0.1 line | Stable |

The shorter documentation label keeps patch-compatible guidance together. When a
patch changes behavior or an operational procedure, the 0.1 Help Center is rebuilt
from that accepted patch and its release notes describe the change. A future
incompatible or feature release receives a new documentation line rather than
rewriting 0.1 silently.

The channel is independent of SemVer. A Testing candidate and a Stable artifact may
both report application version `0.1.13`; only accepted `main`/tag provenance may
claim a Stable application build. Public documentation can receive corrections on
`Testing`, but a published Stable correction receives a new patch version and tag.
The installed Help Center therefore remains authoritative for the exact binaries
running in a deployment.

## Confirm what is installed

Use either of these sources:

1. open the top-right release badge in the Console; or
2. read `/api/health/build-info` from the same deployment.

Compare the reported application version and channel with the version context shown
in the Help Center. If the Console and backend stamps disagree, the Console fails
safe to Testing. Resolve that packaging mismatch before treating either component as
a Stable release.

If a custom build contains uncommitted or local build metadata, use its bundled Help
Center first and retain the deployment's own change record. Public documentation can
describe only the closest accepted base release.

## Public Stable and Development material

The versioned public site complements the installed Help Center:

```text
feature branches → Testing review → main verification → exact-tag Stable publication
```

- Pull requests and `Testing` changes must pass a strict documentation build.
- `Testing` output is a review artifact, not supported Stable guidance.
- Promotion to `main` permits final verification; only the exact immutable release
  tag publishes the versioned Stable documentation and moves Stable aliases.
- The `stable` and `latest` aliases point to the current supported documentation
  line after its release.
- Previously published version directories remain available for older deployments.

The Stable publication maintains `/0.1/`; `/stable/`, `/latest/`, and the public-site
root resolve to that supported line. A public version selector
attempts to preserve the current page in the selected release line and falls back to
that line's home page when the article did not exist.

Older public documentation displays an outdated-version warning. It remains useful
for operating an older deployment, but later security or upgrade guidance may have
superseded it. That warning concerns the selected public version; it does not make
the documentation bundled with an older installed app inaccurate for that app.

## Repository publication prerequisites

Before a Stable documentation publish, repository administrators must:

1. keep `Testing` and `main` as the integration and Stable branches, make `main`
   the default, and require the documented pull-request and CI gates;
2. open **Settings → Pages**, set **Build and deployment → Source** to
   **GitHub Actions**, and protect the generated `github-pages` environment as
   appropriate for the repository;
3. promote accepted documentation to `main` and verify that exact commit;
4. create the matching immutable annotated release tag only after verification; and
5. allow the `Documentation` workflow to complete its `validate`, `publish`, and
   `deploy` jobs for that tag.

The repository already uses `main` as its default branch and retains `Testing` as
the integration branch. GitHub Actions Pages source selection is a one-time
administrator setting; the workflow deliberately does not carry a personal access
token that could change repository settings.

Pull requests, `Testing` pushes, and the promoted `main` commit validate and assemble
review artifacts. Publication uses the exact annotated release tag after it is shown
to match the verified `main` commit. The workflow then uses Mike to update generated
history on `gh-pages`, assembles that history as a link-free Pages artifact, and
deploys it with GitHub's native Pages actions. The `gh-pages` branch is generated
version history, **not** the configured Pages publishing source. Untagged refs cannot
move the public Stable site.

Generated public-site output is a release artifact. Do not edit it by hand; edit the
Markdown on `Testing`, promote the accepted source through `main`, and let the
documentation workflow republish it.

## Source and edit policy

The application-hosted Help Center is the reading surface. The repository is the
authoring surface:

- Stable documentation corresponds to accepted source on `main` and an immutable
  release tag.
- `Testing` contains the next integrated documentation changes.
- An edit proposed from an older rendered version must target the appropriate source
  history or intentionally update the current release line.

Do not replace an installed Help Center link with a raw repository link merely
because both contain the same Markdown. The local rendered article is version-matched,
searchable, themed, and available with the application; “View source” and “Edit this
page” are secondary contributor actions.

See [Agentic SOC 0.1](0.1.md), [Release channels and versioning](channels.md), and
[Upgrades](../operations/upgrades.md).
