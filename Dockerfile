# La versión de la imagen tiene que coincidir con la de playwright en package.json
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY check.js ./
# .env y state.json se montan desde el host (ver README)
CMD ["node", "check.js"]
