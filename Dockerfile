FROM node:20-alpine

WORKDIR /app

# Reproducible install: exact versions from package-lock.json, no dev dependencies, no lifecycle scripts from dependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node . .
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
EXPOSE 8080

USER node

CMD ["node", "server.js"]
