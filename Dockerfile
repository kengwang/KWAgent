ARG NODE_IMAGE=node:24.18.0-bookworm-slim
FROM ${NODE_IMAGE} AS build
ADD --checksum=sha256:0c75e0b94e9d56cece77abb7d03e9995b47b79506df5dcca3046eeb888db5934 https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.4.2.tgz /opt/bun.tgz
RUN mkdir -p /opt/bun && tar -xzf /opt/bun.tgz -C /opt/bun --strip-components=1 && ln -s /opt/bun/bin/bun /usr/local/bin/bun
ADD --checksum=sha256:c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83 https://github.com/astral-sh/uv/releases/download/0.13.7/uv-x86_64-unknown-linux-gnu.tar.gz /opt/uv.tar.gz
RUN mkdir -p /opt/uv && tar -xzf /opt/uv.tar.gz -C /opt/uv --strip-components=1
WORKDIR /opt/kwagent
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/kw-mind/package.json ./packages/kw-mind/package.json
COPY packages/kw-lagrange/package.json ./packages/kw-lagrange/package.json
COPY packages/kw-life/package.json ./packages/kw-life/package.json
COPY packages/kw-panel/package.json ./packages/kw-panel/package.json
COPY packages/kw-bundle/package.json ./packages/kw-bundle/package.json
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --network-concurrency=16
COPY packages ./packages
COPY tsconfig*.json ./
COPY scripts ./scripts
COPY tests ./tests
RUN node scripts/build.mjs && node scripts/test.mjs

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production KW_CONTAINER=true KW_DATA_ROOT=/data DSH_HOME=/data/dsh \
    TMPDIR=/data/tmp TEMP=/data/tmp TMP=/data/tmp HOME=/data/cache/home \
    BUN_INSTALL_CACHE_DIR=/data/cache/bun UV_CACHE_DIR=/data/cache/uv UV_PYTHON_DOWNLOADS=never \
    PLAYWRIGHT_BROWSERS_PATH=/opt/kwagent/browsers
COPY deploy/debian.sources /etc/apt/sources.list.d/debian.sources
RUN mkdir -p /data/tmp && node -p "require('node:tls').rootCertificates.join('\n')" > /usr/local/share/kw-ca-bundle.crt
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::CaInfo=/usr/local/share/kw-ca-bundle.crt update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::CaInfo=/usr/local/share/kw-ca-bundle.crt install -y --no-install-recommends ffmpeg git ca-certificates python3 python3-venv fonts-noto-cjk fonts-noto-color-emoji \
    && groupadd -g 10001 kwagent && useradd -u 10001 -g kwagent -m kwagent \
    && chown 10001:10001 /data /data/tmp
COPY --from=build /opt/bun/bin/bun /usr/local/bin/bun
COPY --from=build /opt/uv/uv /opt/uv/uvx /usr/local/bin/
COPY deploy/python-requirements.txt /opt/kwagent/python/requirements.txt
RUN --mount=type=cache,target=/root/.cache/uv \
    HOME=/root UV_CACHE_DIR=/root/.cache/uv uv pip install --system --python /usr/bin/python3 --break-system-packages --require-hashes -r /opt/kwagent/python/requirements.txt \
    && HOME=/root python3 -m playwright install --with-deps --only-shell chromium
WORKDIR /opt/kwagent
COPY --from=build /opt/kwagent/node_modules ./node_modules
COPY --from=build /opt/kwagent/packages ./packages
COPY --from=build /opt/kwagent/scripts ./scripts
COPY --from=build /opt/kwagent/package.json /opt/kwagent/bun.lock /opt/kwagent/bunfig.toml ./
ARG KW_COMMIT=unknown
ARG KW_VERSION=development
LABEL org.opencontainers.image.title="KWAgent" \
      org.opencontainers.image.version="${KW_VERSION}" \
      org.opencontainers.image.revision="${KW_COMMIT}"
ENV KW_COMMIT=${KW_COMMIT}
USER 10001:10001
EXPOSE 3080
CMD ["node", "scripts/start.mjs"]
