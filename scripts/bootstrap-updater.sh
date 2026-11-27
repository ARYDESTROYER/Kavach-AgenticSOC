#!/usr/bin/env bash
# One-time host-authorized bridge from a pre-supervisor Stable Compose release.
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${repo_root}/.env"
compose_wrapper="${repo_root}/scripts/agentic-soc-compose.sh"
runtime_dir="${repo_root}/.agentic-soc-runtime"

die() {
  printf 'Updater bootstrap refused: %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "Docker is not installed."
command -v git >/dev/null 2>&1 || die "Git is not installed."
command -v python3 >/dev/null 2>&1 || die "Python 3 is not installed."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is unavailable."
[[ -f "${env_file}" ]] || die "${env_file} is missing; copy .env.example and configure it."

read_env() {
  local key="$1"
  local value
  value="$(sed -n -E "s/^${key}=(.*)$/\\1/p" "${env_file}" | tail -n 1)"
  value="${value%\"}"
  value="${value#\"}"
  printf '%s' "${value}"
}

[[ "$(read_env TLSOC_AUTH_ENABLED)" == "true" ]] \
  || die "TLSOC_AUTH_ENABLED=true is required before updates can be authorized."
auth_secret="$(read_env TLSOC_AUTH_JWT_SECRET)"
[[ ${#auth_secret} -ge 32 ]] \
  || die "TLSOC_AUTH_JWT_SECRET must be a durable secret of at least 32 characters."
[[ -n "$(read_env TLSOC_PG_PASSWORD)" ]] \
  || die "TLSOC_PG_PASSWORD must be durable in .env."

cd "${repo_root}"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] \
  || die "the release checkout must be clean; do not bootstrap from modified source."
version="$(tr -d '[:space:]' < VERSION)"
[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "VERSION is not semantic."
tag="v${version}"
# The trusted repository is the signing identity of every release plan. The frozen
# Compose base still defaults to the former name, so bootstrap requires the value
# in .env and never edits that file. Bash 3.2 has no ${var,,}; fold case with tr.
canonical_repository="ARYDESTROYER/Kavach-AgenticSOC"
former_repository="ARYDESTROYER/Agentic-Kibana"
fold_case() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}
repository="$(read_env AGENTIC_SOC_UPDATE_REPOSITORY)"
[[ -n "${repository}" ]] \
  || die "AGENTIC_SOC_UPDATE_REPOSITORY is not set in ${env_file}. Add the line AGENTIC_SOC_UPDATE_REPOSITORY=${canonical_repository} and run this script again."
[[ "$(fold_case "${repository}")" != "$(fold_case "${former_repository}")" ]] \
  || die "AGENTIC_SOC_UPDATE_REPOSITORY names the former repository ${repository}. Releases are now signed as ${canonical_repository}. Change the line in ${env_file} to AGENTIC_SOC_UPDATE_REPOSITORY=${canonical_repository} and run this script again."
if [[ "$(fold_case "${repository}")" == "$(fold_case "${canonical_repository}")" \
  && "${repository}" != "${canonical_repository}" ]]; then
  die "AGENTIC_SOC_UPDATE_REPOSITORY is ${repository}, but the signing identity is case-sensitive. Change the line in ${env_file} to AGENTIC_SOC_UPDATE_REPOSITORY=${canonical_repository} exactly and run this script again."
fi
[[ "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
  || die "AGENTIC_SOC_UPDATE_REPOSITORY must be owner/name."

# This source build is only the bootstrap transport. Prove HEAD is the exact
# annotated Stable release commit and that the released commit remains in main;
# all application images and the replacement supervisor are then selected from
# the signed, digest-pinned release plan.
git fetch --force origin main "refs/tags/${tag}:refs/tags/${tag}" >/dev/null
[[ "$(git cat-file -t "refs/tags/${tag}")" == "tag" ]] \
  || die "${tag} must be an annotated Stable tag."
release_sha="$(git rev-parse "refs/tags/${tag}^{commit}")"
[[ "${release_sha}" == "$(git rev-parse HEAD)" ]] \
  || die "checkout HEAD is not the ${tag} release commit."
git merge-base --is-ancestor "${release_sha}" origin/main \
  || die "${tag} release commit is not contained in origin/main."

docker inspect tlsoc-postgres >/dev/null 2>&1 \
  || die "the supported standalone PostgreSQL Compose stack is not running."
docker inspect tlsoc-backend >/dev/null 2>&1 \
  || die "the Agentic SOC backend is not running."
mkdir -p "${runtime_dir}"
chmod 0700 "${runtime_dir}"

bootstrap_status_python='import json,socket
s=socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect("/run/agentic-soc-updater/control.sock")
s.sendall(b"GET /v1/status HTTP/1.1\r\nHost: updater\r\nConnection: close\r\n\r\n")
data=b""
while True:
 chunk=s.recv(65536)
 if not chunk: break
 data+=chunk
head,payload=data.split(b"\r\n\r\n",1)
assert int(head.split(b" ",2)[1]) == 200
print(json.dumps(json.loads(payload),separators=(",",":")))'

preserved_override=""
bootstrap_start_key_file=""
supervisor_handoff_owned=false
finalize_preserved_updater() {
  local result=$?
  # Once submission to /v1/jobs begins, the durable supervisor may already own
  # the deployment even if the client loses the response. From that boundary
  # onward the bootstrap must never restore or remove release overrides; doing
  # so would race the updater's verified switch/rollback state machine.
  if [[ "${supervisor_handoff_owned}" == true ]]; then
    return "${result}"
  fi
  if [[ -z "${preserved_override}" || ! -f "${preserved_override}" ]]; then
    return "${result}"
  fi
  if [[ "${result}" -eq 0 ]]; then
    rm -f -- "${preserved_override}" || {
      printf 'Updater bootstrap completed, but the preserved override could not be removed: %s\n' \
        "${preserved_override}" >&2
      return 1
    }
    return 0
  fi
  if [[ "${result}" -ne 0 ]]; then
    set +e
    if [[ -f "${runtime_dir}/active-release.compose.yml" ]]; then
      mv "${runtime_dir}/active-release.compose.yml" \
        "${runtime_dir}/failed-bootstrap.compose.yml"
    fi
    mv "${preserved_override}" "${runtime_dir}/active-release.compose.yml"
    "${compose_wrapper}" up --detach --no-build --force-recreate agentic-soc-updater
    set -e
  fi
  return "${result}"
}
trap finalize_preserved_updater EXIT

retire_bootstrap_start_key() {
  [[ -n "${bootstrap_start_key_file}" ]] || return 0
  python3 - "${bootstrap_start_key_file}" <<'PY'
import os
import sys

path = os.path.abspath(sys.argv[1])
try:
    os.unlink(path)
except FileNotFoundError:
    pass
directory = os.open(os.path.dirname(path), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
try:
    os.fsync(directory)
finally:
    os.close(directory)
PY
}

replace_updater=false
if docker inspect agentic-soc-updater >/dev/null 2>&1; then
  existing_status="$(
    docker exec agentic-soc-updater python3 -c "${bootstrap_status_python}" 2>/dev/null
  )" || die "the existing updater state cannot be inspected safely; recover it before bootstrap."
  if ! updater_decision="$(
    PYTHONPATH="${repo_root}/updater" python3 - "${existing_status}" "${version}" <<'PY'
import json, sys
from agentic_soc_updater.bootstrap import BootstrapStatusError, replacement_decision
try:
    print(replacement_decision(json.loads(sys.argv[1]), sys.argv[2]))
except (BootstrapStatusError, json.JSONDecodeError) as exc:
    print(str(exc), file=sys.stderr)
    raise SystemExit(1)
PY
  )"; then
    die "the existing updater has active or invalid durable state; no replacement was attempted."
  fi
  [[ "${updater_decision}" == replace ]] && replace_updater=true
fi

if ! docker inspect agentic-soc-updater >/dev/null 2>&1 || [[ "${replace_updater}" == true ]]; then
  if [[ "${replace_updater}" == true ]]; then
    preserved_override="${runtime_dir}/active-release.compose.yml.bootstrap-preserved"
    [[ ! -e "${preserved_override}" ]] \
      || die "a preserved bootstrap override already exists; resolve it before retrying."
    if [[ -f "${runtime_dir}/active-release.compose.yml" ]]; then
      mv "${runtime_dir}/active-release.compose.yml" "${preserved_override}"
    else
      prior_updater_image="$(
        docker inspect --format '{{.Image}}' agentic-soc-updater 2>/dev/null
      )" || die "the prior updater image identity could not be captured safely."
      [[ "${prior_updater_image}" =~ ^sha256:[0-9a-f]{64}$ ]] \
        || die "the prior updater does not expose an immutable image ID."
      recovery_temp="${preserved_override}.tmp.$$"
      (
        umask 077
        printf '%s\n' \
          '# Bootstrap recovery override. Remove only after the replacement succeeds.' \
          'services:' \
          '  agentic-soc-updater:' \
          "    image: ${prior_updater_image}" > "${recovery_temp}"
      )
      mv "${recovery_temp}" "${preserved_override}"
    fi
  fi
  printf 'Installing the private update supervisor boundary...\n'
  start_updater() {
    TLSOC_VERSION="${version}" \
    TLSOC_RELEASE_CHANNEL=stable \
    TLSOC_BUILD_SHA="${release_sha}" \
    "${compose_wrapper}" up --detach --build "$@" agentic-soc-updater
  }
  if [[ "${replace_updater}" == true ]]; then
    start_updater --force-recreate
  else
    # `"$@"` is intentionally used instead of an optional empty array. macOS
    # still ships Bash 3.2, where expanding an empty array under `set -u` exits
    # with "unbound variable" before Compose can install the supervisor.
    start_updater
  fi
fi

deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
  updater_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' agentic-soc-updater 2>/dev/null || true)"
  [[ "${updater_health}" == "healthy" ]] && break
  [[ "${updater_health}" == "unhealthy" ]] \
    && die "the update supervisor is unhealthy; inspect its logs before retrying."
  sleep 2
done
[[ "${updater_health:-none}" == "healthy" ]] \
  || die "the update supervisor did not become healthy."
verified_status="$(
  docker exec agentic-soc-updater python3 -c "${bootstrap_status_python}" 2>/dev/null
)" || die "the installed updater status could not be verified."
verified_decision="$(
  PYTHONPATH="${repo_root}/updater" python3 - "${verified_status}" "${version}" <<'PY'
import json, sys
from agentic_soc_updater.bootstrap import replacement_decision
print(replacement_decision(json.loads(sys.argv[1]), sys.argv[2]))
PY
)" || die "the installed updater protocol or capabilities are incompatible."
[[ "${verified_decision}" == reuse ]] \
  || die "the installed updater is not ready for signed release preflight."

request_python='import json,socket,sys
method,path,raw=sys.argv[1:4]
body=raw.encode()
s=socket.socket(socket.AF_UNIX); s.settimeout(30); s.connect("/run/agentic-soc-updater/control.sock")
request=(f"{method} {path} HTTP/1.1\r\nHost: updater\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode()+body
s.sendall(request)
data=b""
while True:
 chunk=s.recv(65536)
 if not chunk: break
 data+=chunk
head,payload=data.split(b"\r\n\r\n",1)
status=int(head.split(b" ",2)[1]); value=json.loads(payload)
print(json.dumps(value,separators=(",",":")))
raise SystemExit(0 if status < 400 else 22)'

updater_request() {
  local method="$1" path="$2" body="$3" _attempt response
  for _attempt in $(seq 1 30); do
    if response="$(docker exec agentic-soc-updater python3 -c "${request_python}" "${method}" "${path}" "${body}" 2>/dev/null)"; then
      printf '%s' "${response}"
      return 0
    fi
    sleep 2
  done
  return 1
}

release="$(python3 - "${repository}" "${version}" "${tag}" "${release_sha}" <<'PY'
import json, sys
repository, version, tag, commit_sha = sys.argv[1:]
base = f"https://github.com/{repository}/releases/download/{tag}"
print(json.dumps({
    "release_id": tag,
    "version": version,
    "tag": tag,
    "commit_sha": commit_sha,
    "plan_url": f"{base}/upgrade-plan.json",
    "bundle_url": f"{base}/upgrade-plan.sigstore.json",
    "repository": repository,
}, separators=(",", ":")))
PY
)"
preflight_key="bootstrap-preflight-${release_sha}-$(date +%s)"
preflight_body="$(python3 - "${release}" "${preflight_key}" <<'PY'
import json, sys
print(json.dumps({"release": json.loads(sys.argv[1]), "idempotency_key": sys.argv[2]}, separators=(",", ":")))
PY
)"
printf 'Verifying the signed Stable release and deployment prerequisites...\n'
preflight="$(updater_request POST /v1/preflight "${preflight_body}")" \
  || die "signed release preflight could not be completed."
python3 - "${preflight}" <<'PY' || exit $?
import json, sys
value = json.loads(sys.argv[1])
if value.get("blockers"):
    for blocker in value["blockers"]:
        print(f"BLOCKED: {blocker['message']} Fix: {blocker['remediation']}", file=sys.stderr)
    raise SystemExit(1)
PY
preflight_token="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["preflight_token"])' "${preflight}")"

# Reuse one unpredictable key for this release until the supervisor reports a
# terminal job. If the host or client dies after submission, the next bootstrap
# invocation resolves the exact durable job instead of starting another one.
bootstrap_start_key_file="${runtime_dir}/bootstrap-start-${release_sha}.key"
bootstrap_start_key="$(python3 - "${bootstrap_start_key_file}" "${release_sha}" <<'PY'
import fcntl
import os
import re
import secrets
import stat
import sys

path, release_sha = sys.argv[1:]
expected = re.compile(rf"bootstrap-start-{re.escape(release_sha)}-[0-9a-f]{{32}}")
flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
created = False
try:
    descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
    created = True
except FileExistsError:
    descriptor = os.open(path, flags)

try:
    fcntl.flock(descriptor, fcntl.LOCK_EX)
    details = os.fstat(descriptor)
    if not stat.S_ISREG(details.st_mode) or details.st_uid != os.getuid():
        raise SystemExit("bootstrap start-key file has unsafe ownership or type")
    if stat.S_IMODE(details.st_mode) & 0o077:
        raise SystemExit("bootstrap start-key file permissions must be 0600")
    if created:
        value = f"bootstrap-start-{release_sha}-{secrets.token_hex(16)}"
        os.write(descriptor, (value + "\n").encode("ascii"))
        os.fsync(descriptor)
        directory = os.open(
            os.path.dirname(os.path.abspath(path)),
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    else:
        os.lseek(descriptor, 0, os.SEEK_SET)
        value = os.read(descriptor, 512).decode("ascii").strip()
    if not expected.fullmatch(value):
        raise SystemExit("bootstrap start-key file is malformed")
    print(value)
finally:
    os.close(descriptor)
PY
)" || die "the durable bootstrap start key could not be created or recovered."

start_body="$(python3 - "${release}" "${preflight_token}" "${bootstrap_start_key}" <<'PY'
import json, sys
print(json.dumps({
    "release": json.loads(sys.argv[1]),
    "preflight_token": sys.argv[2],
    "idempotency_key": sys.argv[3],
}, separators=(",", ":")))
PY
)"
# Set ownership before sending the request: a socket error after the server has
# accepted it is indistinguishable from a pre-accept failure to this client.
supervisor_handoff_owned=true
job="$(updater_request POST /v1/jobs "${start_body}")" \
  || die "the durable update job could not be started."
job_id="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["job_id"])' "${job}")"

printf 'Applying %s through the signed updater (job %s)...\n' "${tag}" "${job_id}"
deadline=$((SECONDS + 3600))
while (( SECONDS < deadline )); do
  job="$(updater_request GET "/v1/jobs/${job_id}" '{}')" || { sleep 2; continue; }
  status="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["status"])' "${job}")"
  stage="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["stage"])' "${job}")"
  printf '  %-20s %s\n' "${stage}" "${status}"
  case "${status}" in
    succeeded)
      retire_bootstrap_start_key \
        || die "the completed bootstrap start key could not be retired safely."
      if [[ -n "${preserved_override}" && -f "${preserved_override}" ]]; then
        rm -f -- "${preserved_override}" \
          || die "the preserved pre-bootstrap override could not be retired safely."
        preserved_override=""
      fi
      printf 'Agentic SOC %s is healthy and the durable release override is active.\n' "${tag}"
      exit 0
      ;;
    failed|rolled_back|cancelled)
      python3 - "${job}" <<'PY'
import json, sys
value = json.loads(sys.argv[1])
error = value.get("error") or {}
print(f"Update ended as {value['status']}: {error.get('message', value.get('message', 'unknown failure'))}", file=sys.stderr)
PY
      retire_bootstrap_start_key \
        || die "the terminal bootstrap start key could not be retired safely."
      exit 1
      ;;
  esac
  sleep 3
done

die "the durable update job is still running after one hour; inspect it in the Console or updater ledger."
