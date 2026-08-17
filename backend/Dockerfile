# Agentic SOC — backend image
#
# Targets:
#   full (default/final) — every connector client advertised by the built-in registry.
#   core                 — pull + stdlib/Redis receivers only; explicitly opt in with
#                          ``docker build --target core ...``.
FROM python:3.14.7-slim-bookworm@sha256:23c59390fc717bf09f9336908199a0ae75d9c4264bf296123f94ad772fea3b52 AS runtime-base

ARG TLSOC_VERSION=unknown
ARG TLSOC_RELEASE_CHANNEL=testing
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
ARG TLSOC_SOURCE_URL=https://github.com/ARYDESTROYER/Agentic-Kibana

LABEL org.opencontainers.image.title="Agentic SOC API" \
      org.opencontainers.image.description="Backend API for Agentic SOC" \
      org.opencontainers.image.version="${TLSOC_VERSION}" \
      dev.tlsoc.release.channel="${TLSOC_RELEASE_CHANNEL}" \
      org.opencontainers.image.revision="${TLSOC_BUILD_SHA}" \
      org.opencontainers.image.created="${TLSOC_BUILD_DATE}" \
      org.opencontainers.image.source="${TLSOC_SOURCE_URL}" \
      io.agentic-soc.state.schema="1"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    TLSOC_RELEASE_CHANNEL=${TLSOC_RELEASE_CHANNEL} \
    TLSOC_BUILD_SHA=${TLSOC_BUILD_SHA} \
    TLSOC_BUILD_DATE=${TLSOC_BUILD_DATE}

WORKDIR /app

# Install the product's core runtime first so this layer is shared by both image
# targets.  No compiler or package manager is retained in the runtime image.
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir wheel==0.45.1 -r requirements.txt \
    && python -m pip check \
    && groupadd --gid 10001 tlsoc \
    && useradd --uid 10001 --gid tlsoc --create-home --home-dir /home/tlsoc tlsoc \
    && chown tlsoc:tlsoc /app

# ``playbooks/`` is a sibling of ``app/`` by runtime contract
# (AppState._playbooks_dir); omitting it silently disables built-in procedures.
COPY --chown=tlsoc:tlsoc app ./app
COPY --chown=tlsoc:tlsoc playbooks ./playbooks

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8088/api/health/ready', timeout=3)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8088"]

# Lean opt-in target for operators who deliberately provide only stdlib/Redis
# receivers.  It is not the default because the wizard must not advertise clients
# that the shipped image cannot import.
FROM runtime-base AS core
USER 10001:10001

# Default release target: install every optional client named by a built-in
# connector manifest.  Protocol certification remains separate from availability.
FROM runtime-base AS full
COPY requirements-connectors.txt ./
RUN python -m pip install --no-cache-dir wheel==0.45.1 -r requirements-connectors.txt \
    && python -m pip check \
    && rm requirements-connectors.txt
USER 10001:10001
