#!/usr/bin/env bash
# Canonical Compose entry point. It preserves updater-selected digest pins.
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${repo_root}/deploy/docker-compose.agnostic.yml"
environment_file="${repo_root}/.env"
release_override="${repo_root}/.agentic-soc-runtime/active-release.compose.yml"
lifecycle_guard="${repo_root}/scripts/compose_lifecycle_guard.py"

# Source builds retain the repository's visible version without embedding that
# mutable value in the updater-managed base Compose contract. An explicit shell
# value still wins for release engineering and diagnostics.
if [[ -z "${TLSOC_VERSION:-}" ]]; then
  TLSOC_VERSION="$(tr -d '\r\n' < "${repo_root}/VERSION")"
  export TLSOC_VERSION
fi

if [[ ! -f "${environment_file}" ]]; then
  printf 'Agentic SOC: %s is missing; copy .env.example and configure it first.\n' \
    "${environment_file}" >&2
  exit 2
fi

# Build provenance. Compose expands TLSOC_BUILD_SHA/TLSOC_BUILD_DATE into the
# backend/webui/updater build arguments with a `:-unknown` fallback, so a wrapper
# that never derives them stamps every source-built image `revision=unknown` and
# leaves each persisted record's `build_sha` unknown. The shared helper derives them
# ONLY when nothing else already did: a supplied release identity (the supervised
# bootstrap) and a non-empty, non-`unknown` operator pin in the --env-file both win.
# shellcheck source=scripts/lib/build-identity.sh
. "${repo_root}/scripts/lib/build-identity.sh"
tlsoc_derive_build_identity "${repo_root}" "${environment_file}"
tlsoc_report_build_identity "Agentic SOC"

compose=(
  docker compose
  --project-name tlsoc-agentic-soc
  --env-file "${environment_file}"
  --file "${compose_file}"
)
if [[ -s "${release_override}" ]]; then
  for argument in "$@"; do
    case "${argument}" in
      build|--build)
        printf '%s\n' \
          'Agentic SOC: source builds are blocked while a signed release override is active.' \
          'Use the documented supervised-release recovery procedure before returning to a source build.' >&2
        exit 3
        ;;
    esac
  done
  compose+=(--file "${release_override}")
fi

exec python3 "${lifecycle_guard}" "${repo_root}/.agentic-soc-runtime" -- "$#" \
  "${compose[@]}" "$@"
