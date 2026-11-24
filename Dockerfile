FROM node:24-bookworm-slim
WORKDIR /srv/catalog
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.mjs schema.sql boards.json ./
USER node
ENV HOST=0.0.0.0
EXPOSE 8788
CMD ["node", "server.mjs"]
