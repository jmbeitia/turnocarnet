# turnocarnet

Revisa cada hora el primer turno libre para la licencia de conducir (examen psicofísico) en
Rosario leyendo el selector "Lugar de atención", y avisa por WhatsApp (Evolution API) si
aparece una fecha más temprana que la mejor vista. La primera corrida solo guarda la fecha base.

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

Para probar el WhatsApp sin esperar un turno nuevo: poner en `data/state.json` una
`mejor.fecha` posterior (ej. `2026-12-31`) y `docker compose restart`.
