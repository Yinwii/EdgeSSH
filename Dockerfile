# EdgeSSH 自托管 Docker 镜像（可选）：构建后数据落在挂载卷 /data
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV EDGESSH_DATA_DIR=/data
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/build ./build
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/server/serve.mjs ./server/serve.mjs
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV PORT=8787
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "server/serve.mjs"]
