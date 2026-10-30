# ─── Service 3: Change Detection & DB Diff Service ──────────
FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

USER node

ENV NODE_ENV=production

CMD ["node", "src/index.js"]

