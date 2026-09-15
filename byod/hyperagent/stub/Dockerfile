FROM node:24-bookworm-slim
WORKDIR /opt/hyperagent
COPY server.mjs ./server.mjs
USER node
EXPOSE 8788
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
