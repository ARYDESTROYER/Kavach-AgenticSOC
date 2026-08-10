FROM ghcr.io/sigstore/cosign/cosign:v3.0.6@sha256:de9c65609e6bde17e6b48de485ee788407c9502fa08b8f4459f595b21f56cd00 AS cosign

FROM docker:29.7.1-cli@sha256:27a51d5ab1cd38d9eeaba7b415b8c07bc10c31e1cf1ec8d78f6413fcfab3f44f

ARG TLSOC_VERSION=unknown
ARG TLSOC_RELEASE_CHANNEL=testing
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
ARG TLSOC_SOURCE_URL=https://github.com/ARYDESTROYER/Agentic-Kibana

LABEL org.opencontainers.image.title="Agentic SOC Update Supervisor" \
      org.opencontainers.image.description="Private host supervisor for signed Agentic SOC Compose updates" \
      org.opencontainers.image.version="${TLSOC_VERSION}" \
      dev.tlsoc.release.channel="${TLSOC_RELEASE_CHANNEL}" \
      org.opencontainers.image.revision="${TLSOC_BUILD_SHA}" \
      org.opencontainers.image.created="${TLSOC_BUILD_DATE}" \
      org.opencontainers.image.source="${TLSOC_SOURCE_URL}" \
      io.agentic-soc.state.schema="1" \
      io.agentic-soc.update-protocol="1"

RUN apk add --no-cache python3 docker-cli-compose ca-certificates \
    && addgroup -g 10001 agentic-soc \
    && mkdir -p /opt/agentic-soc-updater /run/agentic-soc-updater \
       /var/lib/agentic-soc-updater /var/backups/agentic-soc \
    && chgrp 10001 /run/agentic-soc-updater \
    && chmod 0750 /run/agentic-soc-updater

COPY --from=cosign /ko-app/cosign /usr/local/bin/cosign
COPY agentic_soc_updater /opt/agentic-soc-updater/agentic_soc_updater

ENV PYTHONPATH=/opt/agentic-soc-updater \
    PYTHONUNBUFFERED=1 \
    TUF_ROOT=/var/lib/agentic-soc-updater/sigstore-root

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["python3", "-c", "import socket; s=socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect('/run/agentic-soc-updater/control.sock'); s.sendall(b'GET /v1/status HTTP/1.1\\r\\nHost: updater\\r\\nConnection: close\\r\\n\\r\\n'); assert b'200 OK' in s.recv(128)"]

# Keep the Docker-owning process at UID 0 while making the backend's fixed GID
# the process primary group.  The Unix socket then inherits group 10001 without
# CAP_CHOWN; Compose continues to drop every capability.
USER 0:10001

ENTRYPOINT ["python3", "-m", "agentic_soc_updater"]
