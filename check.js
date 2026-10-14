// Inicia sesión con CUIT/contraseña de .env, lee el primer turno libre de cada sede
// y avisa si aparece una fecha más temprana que la mejor vista: por WhatsApp vía Evolution API
// si EVOLUTION_URL está definido, si no con una notificación de macOS.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

process.chdir(import.meta.dirname); // para cron: .env y state.json junto al script
process.loadEnvFile('.env');
const { CUIT, PASSWORD, EVOLUTION_URL, EVOLUTION_INSTANCE, EVOLUTION_APIKEY, WHATSAPP_TO } = process.env;
const TURNOS_URL = 'https://www.rosario.gob.ar/inicio/perfildigital/licenciaconducir/turnos';
// Redirige a /turnos; es el paso que hace el sitio al tocar "Agendar turno"
const AGENDA_URL = 'https://www.rosario.gob.ar/inicio/perfildigital/licenciaconducir/preparar-agenda';

const STATE_FILE = process.env.STATE_FILE ?? 'state.json';

const fmt = (iso) => iso.split('-').reverse().join('/');

async function notify(title, msg) {
  if (EVOLUTION_URL) {
    const res = await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_APIKEY },
      body: JSON.stringify({ number: WHATSAPP_TO, text: `*${title}*\n${msg}` }),
    });
    if (!res.ok) console.error(`Evolution respondió ${res.status}: ${await res.text()}`);
    return;
  }
  execFileSync('osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title "Turno carnet" subtitle (item 1 of argv) sound name "Glass"',
    '-e', 'end run',
    title, msg,
  ]);
}

async function login(page) {
  // El formulario de CUIT/contraseña está oculto hasta elegir "Municipalidad de Rosario"
  if (!(await page.isVisible('#username'))) await page.click('.button-mr');
  await page.fill('#username', CUIT);
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  // Ojo: la URL de login contiene "www.rosario.gob.ar" en redirect_uri, por eso se compara el host
  await page
    .waitForURL((u) => u.hostname === 'www.rosario.gob.ar', { timeout: 30000 })
    .catch(async () => {
      const err = await page.textContent('#input-error, .kc-feedback-text, .alert-error').catch(() => null);
      throw new Error(`Login falló${err ? ': ' + err.trim() : ''}`);
    });
}

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const page = await browser.newPage();
try {
  await page.goto(TURNOS_URL);
  if (!page.url().includes('am.rosario.gob.ar') && !page.url().includes('/turnos')) {
    // Página intermedia de Drupal con el botón "Ingresá"
    await page.click('input[name="keycloak"]');
    await page.waitForURL((u) => u.hostname === 'am.rosario.gob.ar');
  }
  if (new URL(page.url()).hostname === 'am.rosario.gob.ar') await login(page);
  if (!page.url().includes('/turnos')) await page.goto(AGENDA_URL);
  await page.waitForLoadState('networkidle');
  fs.writeFileSync('last.html', await page.content());
  if (!page.url().includes('/turnos')) throw new Error(`No llegó a turnos, quedó en ${page.url()}`);

  // Opciones tipo "CMD Sur - Turnos a partir del 19/11/2026"
  const sedes = (await page.$$eval('#edit-lugar option', (os) => os.map((o) => o.textContent.trim())))
    .map((t) => t.match(/^(.*?) - Turnos a partir del (\d{2})\/(\d{2})\/(\d{4})/))
    .filter(Boolean)
    .map(([, sede, d, m, y]) => ({ sede, fecha: `${y}-${m}-${d}` }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (!sedes.length) throw new Error('No se encontraron sedes con turnos en el selector');

  const mejor = sedes[0];
  const raw = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8').trim() : '';
  const state = raw ? JSON.parse(raw) : {};
  const linea = sedes.map((s) => `${s.sede}: ${fmt(s.fecha)}`).join(' | ');
  console.log(`${new Date().toLocaleString('es-AR')}  ${linea}`);

  if (!state.mejor || mejor.fecha < state.mejor.fecha) {
    if (state.mejor) await notify(`¡Turno más temprano! ${mejor.sede}: ${fmt(mejor.fecha)}`, `Antes: ${fmt(state.mejor.fecha)}`);
    state.mejor = mejor;
  }
  state.ultimo = { cuando: new Date().toISOString(), sedes };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
} catch (e) {
  await notify('Error chequeando turnos', e.message.slice(0, 200));
  throw e;
} finally {
  await browser.close();
}
