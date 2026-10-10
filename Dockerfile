# Runlight's standalone server. Build with:
#   docker build -t runlight .
# Run with:
#   docker run -p 3000:3000 -v runlight-data:/data runlight
#
# The base image is pinned by digest (the multi-platform index of
# node:24-slim), so a rebuild of the same commit starts from the same image.
# Dependabot (.github/dependabot.yml) proposes a new digest as it changes.

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
# better-sqlite3 compiles from source where no prebuilt binary fits.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund && npm run build
RUN mkdir /pack && npm pack --silent --workspace packages/sdk --workspace packages/server --pack-destination /pack
# The install the image runs, built here so the compilers stay out of it:
# the two packages as npm packs them, in the workspace layout, installed from
# the root package-lock.json so the image runs exactly what CI tested.
WORKDIR /app
RUN cp /src/package.json /src/package-lock.json . \
  && mkdir -p packages/sdk packages/server \
  && tar -xzf /pack/runlight-sdk-*.tgz -C packages/sdk --strip-components=1 \
  && tar -xzf /pack/runlight.sh-*.tgz -C packages/server --strip-components=1 \
  && npm ci --omit=dev --workspace packages/server --no-audit --no-fund

FROM node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "node_modules/runlight.sh/dist/cli.js"]
