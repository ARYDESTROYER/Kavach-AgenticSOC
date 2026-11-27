# Agentic SOC — build the version-matched Help Center + standalone web app,
# then serve both from nginx. The build context is the repository root because
# the canonical MkDocs source lives beside (not inside) webui/.
# Docs and browser assets are architecture-neutral, so their package tools run on
# the native builder platform rather than through target-architecture emulation.

FROM --platform=$BUILDPLATFORM python:3.11-alpine@sha256:7fbad8e4652eae0186429a6f26cf5b23e27e8c6fd7ac4d0cfd7a6988cdeea1e1 AS docs
WORKDIR /repo
COPY docs/requirements.txt docs/requirements.txt
RUN python3 -m pip install --no-cache-dir --requirement docs/requirements.txt
COPY VERSION mkdocs.yml ./
COPY docs ./docs
COPY overrides ./overrides
COPY scripts/build_docs_bundle.py ./scripts/build_docs_bundle.py

ARG TLSOC_VERSION=unknown
ARG TLSOC_RELEASE_CHANNEL=testing
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
RUN TLSOC_VERSION="${TLSOC_VERSION}" \
    TLSOC_RELEASE_CHANNEL="${TLSOC_RELEASE_CHANNEL}" \
    python3 scripts/build_docs_bundle.py --output /artifact/docs

FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /repo/webui
COPY webui/package.json webui/package-lock.json ./
RUN npm ci
COPY webui/ ./
COPY --from=docs /artifact/docs ./public/docs

# These values are consumed by Vite while compiling the immutable browser bundle.
# Defaults are deliberately non-Stable; Compose/release CI must stamp accepted builds.
ARG TLSOC_VERSION=unknown
ARG TLSOC_RELEASE_CHANNEL=testing
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
# The Help Center is already built in the Python stage. The public `npm run
# build` command still creates it for non-Docker development builds.
RUN npm run build:app

# No platform override: the shipping nginx stage inherits Docker's TARGETPLATFORM.
FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

ARG TLSOC_VERSION=unknown
ARG TLSOC_RELEASE_CHANNEL=testing
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
ARG TLSOC_SOURCE_URL=https://github.com/ARYDESTROYER/Kavach-AgenticSOC

LABEL org.opencontainers.image.title="Agentic SOC" \
      org.opencontainers.image.description="Operator console for Agentic SOC" \
      org.opencontainers.image.version="${TLSOC_VERSION}" \
      dev.tlsoc.release.channel="${TLSOC_RELEASE_CHANNEL}" \
      org.opencontainers.image.revision="${TLSOC_BUILD_SHA}" \
      org.opencontainers.image.created="${TLSOC_BUILD_DATE}" \
      org.opencontainers.image.source="${TLSOC_SOURCE_URL}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.agentic-soc.state.schema="1"

COPY webui/nginx.conf /etc/nginx/conf.d/default.conf
COPY webui/nginx-security-headers.conf /etc/nginx/agentic-soc-security-headers.conf
COPY LICENSE /usr/share/doc/agentic-soc/LICENSE
COPY --from=build /repo/webui/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
