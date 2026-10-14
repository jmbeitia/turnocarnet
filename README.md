# turnocarnet

Revisa cada minuto el primer turno libre para la licencia de conducir (examen psicofísico) en
Rosario leyendo el selector "Lugar de atención", y avisa por WhatsApp (Evolution API):

- **Turno más temprano:** cuando la fecha más próxima es anterior a la de la lectura anterior
  y a tu turno actual (`MI_TURNO`).
- **Status diario:** a las 9 (`STATUS_HORA`), con todas las sedes y los días que faltan;
  ✅ marca los turnos a 30 días o menos (`OBJETIVO_DIAS`). Incluye cuántos días adelantaste
  desde el primer turno que tomaste.
- **Auto-agendado** (`AUTO_AGENDAR=si`): si hay un turno anterior al tuyo, elige esa sede, la
  primera fecha y la primera hora y aprieta "Agendar turno", que **reemplaza** tu turno actual.
  Avisa qué agendó (o que no pudo) y lo suma al historial en `state.json`. Con `simular` hace
  todo menos apretar el botón, para probarlo sin riesgo.
- **Errores:** una sola vez hasta que vuelve a funcionar.

## Configuración

`cp .env.example .env` y completar. Sin `EVOLUTION_URL` avisa con notificación de macOS.

`MI_TURNO` es el registro de los turnos que fuiste tomando: cada vez que agarrás uno mejor,
agregalo al final (ej. `25/11/2026, 04/11/2026 08:15`). El último es el actual.

## Local

```sh
npm ci && npx playwright install chromium
node check.js            # --headed para ver el navegador
```

## Easypanel

App desde el repo de GitHub con build por Dockerfile. Cargar las variables de `.env.example`
en Environment y agregar un volumen montado en `/app/data` (ahí queda `state.json`).
`INTERVALO_SEG` (default 60) cambia la frecuencia.

## VPS (docker compose)

```sh
git clone git@github.com:jmbeitia/turnocarnet.git && cd turnocarnet
cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f
```

Para probar el WhatsApp sin esperar un turno nuevo: en `data/state.json` poner una fecha
posterior (ej. `2026-12-31`) en `ultimo.sedes[0].fecha` y `docker compose restart`.
