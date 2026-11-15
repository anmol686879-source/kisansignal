FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATABASE_FILE=/data/kisansignal.db
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
