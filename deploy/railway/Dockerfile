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
ENV NODE_ENV=production
CMD ["node", "packages/gateway/dist/main.js"]
