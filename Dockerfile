ARG NODE_IMAGE=node:24.18.0-bookworm-slim
FROM ${NODE_IMAGE} AS build
ADD --checksum=sha256:0c75e0b94e9d56cece77abb7d03e9995b47b79506df5dcca3046eeb888db5934 https://registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.4.2.tgz /opt/bun.tgz
RUN mkdir -p /opt/bun && tar -xzf /opt/bun.tgz -C /opt/bun --strip-components=1 && ln -s /opt/bun/bin/bun /usr/local/bin/bun
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
    BUN_INSTALL_CACHE_DIR=/data/cache/bun
COPY deploy/debian.sources /etc/apt/sources.list.d/debian.sources
RUN mkdir -p /data/tmp && node -p "require('node:tls').rootCertificates.join('\n')" > /usr/local/share/kw-ca-bundle.crt
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::CaInfo=/usr/local/share/kw-ca-bundle.crt update \
    && apt-get -o Acquire::Retries=3 -o Acquire::https::CaInfo=/usr/local/share/kw-ca-bundle.crt install -y --no-install-recommends ffmpeg git ca-certificates \
    && groupadd -g 10001 kwagent && useradd -u 10001 -g kwagent -m kwagent \
    && chown 10001:10001 /data /data/tmp
COPY --from=build /opt/bun/bin/bun /usr/local/bin/bun
WORKDIR /opt/kwagent
COPY --from=build /opt/kwagent/node_modules ./node_modules
COPY --from=build /opt/kwagent/packages ./packages
COPY --from=build /opt/kwagent/scripts ./scripts
COPY --from=build /opt/kwagent/package.json /opt/kwagent/bun.lock /opt/kwagent/bunfig.toml ./
ARG KW_COMMIT=unknown
LABEL org.opencontainers.image.title="KWAgent" \
      org.opencontainers.image.version="0.2.0" \
      org.opencontainers.image.revision="${KW_COMMIT}"
ENV KW_COMMIT=${KW_COMMIT}
USER 10001:10001
EXPOSE 3080
CMD ["node", "scripts/start.mjs"]
