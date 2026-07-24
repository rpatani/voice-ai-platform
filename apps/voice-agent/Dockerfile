# Build and run the voice-agent service.
# Build context must be the repo root:
#   docker build -f apps/voice-agent/Dockerfile -t voice-agent .

FROM node:20-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
RUN npm run build

FROM node:20-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY package.json package-lock.json ./
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps ./apps
RUN npm ci --omit=dev && npm cache clean --force

ENV PORT=8080
ENV TENANT_CONFIG_DIR=/repo/packages/config/tenants
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "apps/voice-agent/dist/main.js"]
