FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --chown=node:node . .
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
EXPOSE 8080

USER node

CMD ["node", "server.js"]
