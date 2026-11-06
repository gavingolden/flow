FROM oven/bun:1
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8080
CMD ["bun", "src/app.ts"]
