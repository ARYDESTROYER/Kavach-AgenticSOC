# shellcheck shell=bash
# =============================================================================
# scripts/lib/build-identity.sh — ONE derivation of the non-secret build identity.
#
# `TLSOC_BUILD_SHA` / `TLSOC_BUILD_DATE` are Docker *build arguments*: the reference
# Compose files expand them with a `:-unknown` fallback, and the backend/webui/updater
# Dockerfiles bake the result into `org.opencontainers.image.revision` and the running
# process environment. A wrapper that never derives them therefore ships an image
# permanently stamped `revision=unknown`, which in turn blocks supervised updates
# (`engine/update_service` requires an exact source revision) and leaves every
# persisted case/audit/usage row with `build_sha="unknown"`.
#
# This file is sourced by BOTH `scripts/agentic-soc-compose.sh` (Compose source
# builds) and `scripts/run-demo.sh` (local uvicorn + Vite), so there is exactly one
# revision string with several call sites. It is deliberately Bash 3.2 compatible
# (macOS still ships 3.2) and touches nothing but these two variables.
#
# THREE THINGS IT MUST NEVER DO — each is a real, load-bearing failure:
#
#   1. It must never MODIFY an identity that was already supplied. The supervised
#      bootstrap invokes the Compose wrapper with the verified release identity
#      already exported. Appending a `-dirty` suffix to a signed release revision
#      would fail the updater's exact-object-id check and permanently disable
#      one-click updates on a correctly bootstrapped host. Every derivation below is
#      therefore guarded on the variable being empty.
#
#   2. The dirty probe must count only TRACKED modifications. `git status --porcelain`
#      also counts untracked files, so a single operator note dropped in the
#      deployment directory would mark every subsequent build dirty forever. We use
#      `git diff --quiet HEAD --`, which ignores untracked paths.
#
#   3. An operator pin in the Compose `--env-file` must WIN. That file is read by
#      Compose, not by this shell, and an exported shell variable OUTRANKS it — so an
#      unconditional derivation would silently override a documented operator pin. We
#      probe the env file for a non-empty, non-`unknown` assignment and suppress the
#      derivation *without exporting anything*, leaving Compose to apply the pin.
#      A literal `unknown` (what `.env.example` used to ship) is not a pin.
# =============================================================================

# Read one assignment out of a Compose `--env-file`, honouring last-wins and the
# optional `export ` prefix, and stripping surrounding quotes plus a trailing CR.
# Prints the value on stdout. Returns non-zero when the file or key is absent.
tlsoc_build_identity_env_file_value() {
  local tlsoc_bi_env_file="$1"
  local tlsoc_bi_name="$2"
  local tlsoc_bi_line=""
  local tlsoc_bi_value=""

  [ -f "${tlsoc_bi_env_file}" ] || return 1
  tlsoc_bi_line="$(
    grep -E "^[[:space:]]*(export[[:space:]]+)?${tlsoc_bi_name}=" \
      "${tlsoc_bi_env_file}" 2>/dev/null | tail -n 1
  )" || true
  [ -n "${tlsoc_bi_line}" ] || return 1

  tlsoc_bi_value="${tlsoc_bi_line#*=}"
  tlsoc_bi_value="${tlsoc_bi_value%$'\r'}"
  # Strip one layer of matching quotes, then surrounding whitespace.
  case "${tlsoc_bi_value}" in
    \"*\") tlsoc_bi_value="${tlsoc_bi_value#\"}"; tlsoc_bi_value="${tlsoc_bi_value%\"}" ;;
    \'*\') tlsoc_bi_value="${tlsoc_bi_value#\'}"; tlsoc_bi_value="${tlsoc_bi_value%\'}" ;;
  esac
  tlsoc_bi_value="$(printf '%s' "${tlsoc_bi_value}" | tr -d '[:space:]')"
  printf '%s' "${tlsoc_bi_value}"
}

# True when the env file pins the variable to a usable value. A blank assignment or
# the literal `unknown` is NOT a pin — it is the absence the wrapper exists to fill.
tlsoc_build_identity_env_file_pins() {
  local tlsoc_bi_pin=""
  tlsoc_bi_pin="$(tlsoc_build_identity_env_file_value "$1" "$2")" || return 1
  [ -n "${tlsoc_bi_pin}" ] || return 1
  case "$(printf '%s' "${tlsoc_bi_pin}" | tr '[:upper:]' '[:lower:]')" in
    unknown) return 1 ;;
  esac
  return 0
}

# Derive and export TLSOC_BUILD_SHA / TLSOC_BUILD_DATE for a SOURCE build.
#
#   tlsoc_derive_build_identity <repo_root> [env_file]
#
# Sets two report-only globals describing what the build will actually observe:
#   TLSOC_BUILD_IDENTITY_SHA  / TLSOC_BUILD_IDENTITY_DATE   (effective values)
#   TLSOC_BUILD_IDENTITY_ORIGIN_SHA / ..._ORIGIN_DATE       (supplied|pinned|derived|absent)
tlsoc_derive_build_identity() {
  local tlsoc_bi_root="$1"
  local tlsoc_bi_env="${2:-}"
  local tlsoc_bi_sha=""
  local tlsoc_bi_date=""

  TLSOC_BUILD_IDENTITY_ORIGIN_SHA="derived"
  TLSOC_BUILD_IDENTITY_ORIGIN_DATE="derived"

  # --- (1) a supplied identity is authoritative and is never touched --------
  if [ -n "${TLSOC_BUILD_SHA:-}" ]; then
    TLSOC_BUILD_IDENTITY_ORIGIN_SHA="supplied"
    TLSOC_BUILD_IDENTITY_SHA="${TLSOC_BUILD_SHA}"
  # --- (3) an operator pin in the env file wins; do not export -------------
  elif [ -n "${tlsoc_bi_env}" ] &&
       tlsoc_build_identity_env_file_pins "${tlsoc_bi_env}" TLSOC_BUILD_SHA; then
    TLSOC_BUILD_IDENTITY_ORIGIN_SHA="pinned"
    TLSOC_BUILD_IDENTITY_SHA="$(
      tlsoc_build_identity_env_file_value "${tlsoc_bi_env}" TLSOC_BUILD_SHA
    )"
  else
    tlsoc_bi_sha="$(git -C "${tlsoc_bi_root}" rev-parse --verify HEAD 2>/dev/null || true)"
    if [ -n "${tlsoc_bi_sha}" ]; then
      # --- (2) tracked modifications only; untracked files are not dirt -----
      if ! git -C "${tlsoc_bi_root}" diff --quiet HEAD -- 2>/dev/null; then
        tlsoc_bi_sha="${tlsoc_bi_sha}-dirty"
      fi
    else
      tlsoc_bi_sha="unknown"
      TLSOC_BUILD_IDENTITY_ORIGIN_SHA="absent"
    fi
    TLSOC_BUILD_SHA="${tlsoc_bi_sha}"
    export TLSOC_BUILD_SHA
    TLSOC_BUILD_IDENTITY_SHA="${tlsoc_bi_sha}"
  fi

  if [ -n "${TLSOC_BUILD_DATE:-}" ]; then
    TLSOC_BUILD_IDENTITY_ORIGIN_DATE="supplied"
    TLSOC_BUILD_IDENTITY_DATE="${TLSOC_BUILD_DATE}"
  elif [ -n "${tlsoc_bi_env}" ] &&
       tlsoc_build_identity_env_file_pins "${tlsoc_bi_env}" TLSOC_BUILD_DATE; then
    TLSOC_BUILD_IDENTITY_ORIGIN_DATE="pinned"
    TLSOC_BUILD_IDENTITY_DATE="$(
      tlsoc_build_identity_env_file_value "${tlsoc_bi_env}" TLSOC_BUILD_DATE
    )"
  else
    tlsoc_bi_date="$(
      git -C "${tlsoc_bi_root}" show -s --format=%cI HEAD 2>/dev/null || true
    )"
    if [ -z "${tlsoc_bi_date}" ]; then
      tlsoc_bi_date="unknown"
      TLSOC_BUILD_IDENTITY_ORIGIN_DATE="absent"
    fi
    TLSOC_BUILD_DATE="${tlsoc_bi_date}"
    export TLSOC_BUILD_DATE
    TLSOC_BUILD_IDENTITY_DATE="${tlsoc_bi_date}"
  fi
}

# Print ONE line on stderr whenever the resolved identity is not an immutable
# release revision, naming the observed values. Never silent, never fatal.
tlsoc_report_build_identity() {
  local tlsoc_bi_label="${1:-Agentic SOC}"
  local tlsoc_bi_report_sha="${TLSOC_BUILD_IDENTITY_SHA:-unknown}"
  local tlsoc_bi_report_date="${TLSOC_BUILD_IDENTITY_DATE:-unknown}"
  local tlsoc_bi_degraded=0

  [ -n "${tlsoc_bi_report_sha}" ] || tlsoc_bi_report_sha="unknown"
  [ -n "${tlsoc_bi_report_date}" ] || tlsoc_bi_report_date="unknown"
  case "${tlsoc_bi_report_sha}" in
    unknown|*-dirty) tlsoc_bi_degraded=1 ;;
  esac
  case "${tlsoc_bi_report_date}" in
    unknown) tlsoc_bi_degraded=1 ;;
  esac

  if [ "${tlsoc_bi_degraded}" -eq 1 ]; then
    printf '%s: build provenance is not an immutable release revision (TLSOC_BUILD_SHA=%s [%s], TLSOC_BUILD_DATE=%s [%s]); records and image labels carry this value and supervised updates stay unavailable.\n' \
      "${tlsoc_bi_label}" \
      "${tlsoc_bi_report_sha}" "${TLSOC_BUILD_IDENTITY_ORIGIN_SHA:-derived}" \
      "${tlsoc_bi_report_date}" "${TLSOC_BUILD_IDENTITY_ORIGIN_DATE:-derived}" >&2
  fi
}
