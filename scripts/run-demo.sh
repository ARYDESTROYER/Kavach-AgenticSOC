#!/usr/bin/env bash
# =============================================================================
# run-demo.sh — one-command LOCAL demo of Agentic SOC.
#
# Brings up the suite in its "headline-features" demo posture WITHOUT Docker:
#   * the FastAPI + LangGraph backend (app.main:app) on :8088, with API auth
#     ENABLED so the login + 6-role RBAC + MFA/SSO surfaces are live;
#   * the Vite + React web UI dev server on :5173, proxying /api/* to :8088.
#
# When auth is enabled and the user store is empty, the backend auto-seeds a
# demo super_admin:  Admin / Admin@123  (see app/config.py auth_seed_admin*).
#
# This script is DEPLOY-agnostic: it uses an in-memory / SQLite-friendly state
# backend and Demo Mode always substitutes its deterministic $0 mock LLM, even if
# real provider keys are present. It runs on a laptop with Python 3.11 + Node 22.
# It also completes the local OOBE and enables the isolated live Demo Mode, so
# the first page is populated without manual setup or provider spend.
#
# Usage:
#   ./scripts/run-demo.sh            # start both, stream logs, Ctrl-C to stop
#   DEMO_MODE=seeded ./scripts/run-demo.sh           # static, non-ticking demo
# A provider key supplied at startup is used only AFTER you exit Demo Mode and
# deliberately run non-demo triage; it never changes the $0 demo investigation.
#
# Override ports/mode/secret via env:
#   BACKEND_PORT (8088)  WEBUI_PORT (5173)  DEMO_MODE (live|seeded)
#   TLSOC_AUTH_JWT_SECRET (auto-dev)
# =============================================================================
set -euo pipefail

# --- Resolve repo paths (works from any CWD) ---------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
WEBUI_DIR="${REPO_ROOT}/webui"

# --- Release identity --------------------------------------------------------
# Local source runs share ONE stamp across backend + Vite. Only a literal `main`
# checkout derives Stable automatically; every other branch/detached state defaults
# to Testing. An explicit TLSOC_RELEASE_CHANNEL override remains available for release
# rehearsal, but unknown values fail safe to Testing.
CANONICAL_VERSION="$(tr -d '[:space:]' < "${REPO_ROOT}/VERSION")"
TLSOC_VERSION="${TLSOC_VERSION:-${CANONICAL_VERSION}}"
if [[ "${TLSOC_VERSION}" != "${CANONICAL_VERSION}" ]]; then
  echo "[demo] TLSOC_VERSION=${TLSOC_VERSION} does not match VERSION ${CANONICAL_VERSION}." >&2
  exit 2
fi

SOURCE_BRANCH="$(git -C "${REPO_ROOT}" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ -z "${TLSOC_RELEASE_CHANNEL:-}" ]]; then
  if [[ "${SOURCE_BRANCH}" == "main" ]]; then
    TLSOC_RELEASE_CHANNEL="stable"
  else
    TLSOC_RELEASE_CHANNEL="testing"
  fi
fi
case "$(printf '%s' "${TLSOC_RELEASE_CHANNEL}" | tr '[:upper:]' '[:lower:]')" in
  stable) TLSOC_RELEASE_CHANNEL="stable" ;;
  testing) TLSOC_RELEASE_CHANNEL="testing" ;;
  *)
    echo "[demo] unknown TLSOC_RELEASE_CHANNEL=${TLSOC_RELEASE_CHANNEL}; using testing." >&2
    TLSOC_RELEASE_CHANNEL="testing"
    ;;
esac

# ONE derivation, shared with scripts/agentic-soc-compose.sh, so the demo and a
# Compose source build stamp the same revision string. It never overwrites an
# identity the caller already supplied, and it flags a dirty or unknown revision on
# stderr rather than letting `unknown` reach the records silently.
# shellcheck source=scripts/lib/build-identity.sh
. "${SCRIPT_DIR}/lib/build-identity.sh"
tlsoc_derive_build_identity "${REPO_ROOT}"
tlsoc_report_build_identity "[demo]"
export TLSOC_VERSION TLSOC_RELEASE_CHANNEL TLSOC_BUILD_SHA TLSOC_BUILD_DATE

BACKEND_PORT="${BACKEND_PORT:-8088}"
WEBUI_PORT="${WEBUI_PORT:-5173}"
DEMO_MODE="${DEMO_MODE:-live}"
if [[ "${DEMO_MODE}" != "live" && "${DEMO_MODE}" != "seeded" ]]; then
  echo "[demo] DEMO_MODE must be 'live' or 'seeded' (got '${DEMO_MODE}')." >&2
  exit 2
fi

# This is intentionally a LOCAL launcher: neither service is exposed on the LAN.
# Use the documented Compose/reverse-proxy deployment when remote access is needed.
DEMO_BIND_HOST="127.0.0.1"

# Fail before installing dependencies or starting either child if a port is invalid,
# duplicated, or already occupied. Vite also gets --strictPort below to close the
# small check-to-bind race instead of silently selecting a different port.
python3 - "${DEMO_BIND_HOST}" "${BACKEND_PORT}" "${WEBUI_PORT}" <<'PY'
import socket
import sys

host, *raw_ports = sys.argv[1:]
names = ("BACKEND_PORT", "WEBUI_PORT")
ports: list[int] = []
for name, raw in zip(names, raw_ports, strict=True):
    try:
        port = int(raw)
    except ValueError:
        raise SystemExit(f"[demo] {name} must be an integer (got {raw!r}).") from None
    if not 1 <= port <= 65535:
        raise SystemExit(f"[demo] {name} must be between 1 and 65535 (got {port}).")
    ports.append(port)
if ports[0] == ports[1]:
    raise SystemExit("[demo] BACKEND_PORT and WEBUI_PORT must be different.")

for name, port in zip(names, ports, strict=True):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((host, port))
    except OSError as exc:
        raise SystemExit(
            f"[demo] {name} {port} is unavailable on {host}: {exc}. "
            "Stop the existing service or choose another port."
        ) from None
    finally:
        probe.close()
PY

# --- Demo auth posture -------------------------------------------------------
# Enabling auth turns on the login screen + RBAC + MFA/SSO surfaces and seeds
# the demo super_admin. A STABLE JWT secret keeps sessions alive across reloads;
# we generate a throwaway dev one if the operator did not supply theirs.
#
# IMPORTANT: when we run uvicorn DIRECTLY (no Docker), the backend's pydantic
# Secrets reads UNPREFIXED env names (auth_enabled / auth_jwt_secret / …). The
# TLSOC_* names are only the .env convention that the compose file maps. So here
# we accept the operator's TLSOC_* (the documented knob) AND export the
# unprefixed names the backend actually reads.
DEMO_JWT_SECRET="${TLSOC_AUTH_JWT_SECRET:-${AUTH_JWT_SECRET:-}}"
if [[ -z "${DEMO_JWT_SECRET}" ]]; then
  DEMO_JWT_SECRET="dev-demo-secret-$(python3 -c 'import secrets;print(secrets.token_hex(24))' 2>/dev/null || echo changeme-please-rotate-0123456789abcdef)"
fi

# Unprefixed names — these are what uvicorn/app.config.Secrets reads:
export AUTH_ENABLED=true
export AUTH_JWT_SECRET="${DEMO_JWT_SECRET}"
export AUTH_COOKIE_SECURE="${TLSOC_AUTH_COOKIE_SECURE:-${AUTH_COOKIE_SECURE:-false}}"
export SECURITY_HEADERS_ENABLED="${TLSOC_SECURITY_HEADERS_ENABLED:-${SECURITY_HEADERS_ENABLED:-true}}"

ADMIN_USER="${AUTH_SEED_ADMIN_USERNAME:-Admin}"
ADMIN_PASS="${AUTH_SEED_ADMIN_PASSWORD:-Admin@123}"

# --- Track child PIDs so Ctrl-C tears the whole demo down -------------------
PIDS=()
cleanup() {
  echo
  echo "[demo] shutting down…"
  for pid in "${PIDS[@]:-}"; do
    [[ -n "${pid}" ]] && kill "${pid}" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  echo "[demo] stopped."
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- 1) Backend: ensure venv + deps, then launch uvicorn --------------------
echo "[demo] preparing backend venv at ${BACKEND_DIR}/.venv …"
if [[ ! -d "${BACKEND_DIR}/.venv" ]]; then
  python3 -m venv "${BACKEND_DIR}/.venv"
fi
# shellcheck disable=SC1091
source "${BACKEND_DIR}/.venv/bin/activate"

# Install runtime deps once (idempotent; quiet). Prefer requirements.txt.
if ! python -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "[demo] installing backend dependencies (first run)…"
  if [[ -f "${BACKEND_DIR}/requirements.txt" ]]; then
    pip install -q -r "${BACKEND_DIR}/requirements.txt"
  elif [[ -f "${BACKEND_DIR}/requirements-dev.txt" ]]; then
    pip install -q -r "${BACKEND_DIR}/requirements-dev.txt"
  fi
fi

echo "[demo] starting backend (uvicorn app.main:app) on ${DEMO_BIND_HOST}:${BACKEND_PORT} …"
echo "[demo] release v${TLSOC_VERSION} · ${TLSOC_RELEASE_CHANNEL} (${SOURCE_BRANCH:-detached}, ${TLSOC_BUILD_SHA})"
(
  cd "${BACKEND_DIR}"
  exec python -m uvicorn app.main:app --host "${DEMO_BIND_HOST}" --port "${BACKEND_PORT}"
) &
PIDS+=("$!")

# Wait for the API, authenticate as the local seeded admin, finish the local OOBE,
# and enable the isolated deterministic demo. Python stdlib keeps curl/jq optional.
echo "[demo] waiting for backend and seeding deterministic Demo Mode …"
python - "${BACKEND_PORT}" "${ADMIN_USER}" "${ADMIN_PASS}" "${DEMO_MODE}" <<'PY'
import http.cookiejar
import json
import sys
import time
import urllib.error
import urllib.request

port, username, password, demo_mode = sys.argv[1:]
base = f"http://127.0.0.1:{port}/api"
cookies = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

for _ in range(120):
    try:
        with opener.open(f"{base}/health/live", timeout=1):
            break
    except Exception:
        time.sleep(0.25)
else:
    raise SystemExit("backend did not become live within 30 seconds")

def post(path, payload):
    request = urllib.request.Request(
        f"{base}/{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with opener.open(request, timeout=30) as response:
        return json.load(response)

post("auth/login", {"username": username, "password": password})
post("setup/complete", {})
status = post("demo/enable", {"mode": demo_mode, "force_capabilities": True})
print(f"[demo] {demo_mode} run {status.get('run_id', 'ready')}")
PY

# --- 2) Web UI: ensure node_modules, then launch the Vite dev server --------
echo "[demo] preparing web UI at ${WEBUI_DIR} …"
if [[ ! -d "${WEBUI_DIR}/node_modules" ]]; then
  echo "[demo] installing web UI dependencies (first run)…"
  ( cd "${WEBUI_DIR}" && npm install )
fi

echo "[demo] starting web UI (vite dev) on ${DEMO_BIND_HOST}:${WEBUI_PORT} …"
(
  cd "${WEBUI_DIR}"
  # Vite proxies /api/* to the backend; point it at our chosen backend port.
  export BACKEND_URL="http://${DEMO_BIND_HOST}:${BACKEND_PORT}"
  exec npm run dev -- --host "${DEMO_BIND_HOST}" --port "${WEBUI_PORT}" --strictPort
) &
PIDS+=("$!")

# --- 3) Banner ---------------------------------------------------------------
cat <<BANNER

==============================================================================
  Agentic SOC — DEMO is starting up
------------------------------------------------------------------------------
  Web UI :   http://${DEMO_BIND_HOST}:${WEBUI_PORT}
  Backend:   http://${DEMO_BIND_HOST}:${BACKEND_PORT}/api/health

  Login  :   username  ${ADMIN_USER}
             password  ${ADMIN_PASS}     (demo super_admin — change for real use)

  Auth is ENABLED and deterministic Demo Mode is ${DEMO_MODE} (forced $0 mock LLM).
  Release:    v${TLSOC_VERSION} · ${TLSOC_RELEASE_CHANNEL} (${SOURCE_BRANCH:-detached})
  Both services are bound to loopback only; they are not exposed on your LAN.
  Press Ctrl-C to stop both services.

  Walkthrough script:  see DEMO.md
==============================================================================

BANNER

# Bash 3.2 (still shipped by macOS) has no `wait -n`, so supervise portably. If
# either service exits—especially Vite rejecting a raced port under --strictPort—
# stop its sibling instead of leaving a half-running demo behind.
while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      child_status=0
      wait "${pid}" || child_status=$?
      if (( child_status != 0 )); then
        echo "[demo] a service exited with status ${child_status}; stopping the demo." >&2
      fi
      exit "${child_status}"
    fi
  done
  sleep 1
done
