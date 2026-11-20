# Threadline on Node: the API (apps/api/src/node.ts) serving the built web app.
# Used by docker-compose.yml, which also runs the migrations with this image.
FROM node:22-slim

ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@11.2.2

WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @threadline/web build && chown -R node:node /app

USER node
ENV PORT=8787
EXPOSE 8787
WORKDIR /app/apps/api
CMD ["node_modules/.bin/tsx", "src/node.ts"]
