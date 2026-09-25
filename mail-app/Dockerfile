FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY server ./server
COPY public ./public
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "server/index.ts"]
