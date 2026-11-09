FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap util-linux git python3 ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/engine
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY apps ./apps
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY . .
ENV NODE_ENV=production PORT=8080 SIE_STORAGE_DIR=/data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# bubblewrap needs unprivileged user namespaces (or run with --security-opt seccomp=unconfined on restrictive hosts)
CMD ["sh","-c","node scripts/migrate.mjs && node apps/api/src/server.mjs"]
