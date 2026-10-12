FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8790 \
    ROUTE_DATA_DIR=/app/data

WORKDIR /app
RUN mkdir -p /app/data && chown node:node /app /app/data
COPY --chown=node:node package.json app.mjs server.mjs store.mjs LICENSE ./
COPY --chown=node:node web ./web
USER node
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8790/health').then(async r=>{const b=await r.json();if(!r.ok||b.status!=='ok'||b.service!=='route-player')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
