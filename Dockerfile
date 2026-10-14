# La versión de la imagen tiene que coincidir con la de playwright en package.json
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY check.js ./
# Variables: por entorno (Easypanel) o con un .env montado en /app/.env.
# /app/data conviene montarlo como volumen para que state.json sobreviva a los redeploys.
ENV TZ=America/Argentina/Buenos_Aires \
    STATE_FILE=/app/data/state.json \
    INTERVALO_SEG=900
RUN mkdir -p /app/data
# Chequea cada INTERVALO_SEG; si falla una corrida, sigue con la próxima
CMD ["sh", "-c", "while true; do node check.js; sleep \"$INTERVALO_SEG\"; done"]
