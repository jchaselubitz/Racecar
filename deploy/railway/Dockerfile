FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml ./
COPY tsconfig.json tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/cli packages/cli
COPY packages/shim packages/shim
COPY packages/gateway packages/gateway
RUN yarn install --immutable && yarn build

FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY --from=build /app /app
ARG OVERLORD_CLI_VERSION=0.2607241654.0
ARG RACECAR_CLI_VERSION=0.1.0
# The gateway invokes these commands directly; install pinned release binaries
# rather than relying on a host image or project snapshot to provide them.
RUN npm install --global --no-audit --no-fund \
      "overlord-cli@${OVERLORD_CLI_VERSION}" \
      "racecar-cli@${RACECAR_CLI_VERSION}" \
    && ovld --version \
    && racecar --version
ENV NODE_ENV=production
CMD ["node", "packages/gateway/dist/main.js"]
