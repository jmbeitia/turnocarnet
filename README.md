# turnocarnet

Revisa cada hora el primer turno libre para la licencia de conducir (examen psicofísico) en
Rosario leyendo el selector "Lugar de atención", y avisa por WhatsApp (Evolution API):

- **Turno más temprano:** cuando la fecha más próxima es anterior a la de la lectura anterior.
- **Status diario:** a las 9 (`STATUS_HORA`), con todas las sedes y los días que faltan;
  ✅ marca los turnos a 30 días o menos (`OBJETIVO_DIAS`).
- **Errores:** una sola vez hasta que vuelve a funcionar.

## Configuración

`cp .env.example .env` y completar. Sin `EVOLUTION_URL` avisa con notificación de macOS.

## Local

```sh
npm ci && npx playwright install chromium
node check.js            # --headed para ver el navegador
```

## VPS (docker compose)

```sh
git clone git@github.com:jmbeitia/turnocarnet.git && cd turnocarnet
cp .env.example .env && nano .env
docker compose up -d --build
docker compose logs -f
```

Para probar el WhatsApp sin esperar un turno nuevo: en `data/state.json` poner una fecha
posterior (ej. `2026-12-31`) en `ultimo.sedes[0].fecha` y `docker compose restart`.
