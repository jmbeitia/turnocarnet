// Inicia sesión con CUIT/contraseña de .env, lee el primer turno libre de cada sede
// y avisa si la fecha más próxima es anterior a la de la última lectura, más un status diario.
// Avisa por WhatsApp vía Evolution API si EVOLUTION_URL está definido, si no con notificación de macOS.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

process.chdir(import.meta.dirname); // para cron: .env y state.json junto al script
// En Easypanel las variables vienen del entorno y no hay .env
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const { CUIT, PASSWORD, EVOLUTION_URL, EVOLUTION_INSTANCE, EVOLUTION_APIKEY, WHATSAPP_TO } = process.env;
const TURNOS_URL = 'https://www.rosario.gob.ar/inicio/perfildigital/licenciaconducir/turnos';
// Redirige a /turnos; es el paso que hace el sitio al tocar "Agendar turno"
const AGENDA_URL = 'https://www.rosario.gob.ar/inicio/perfildigital/licenciaconducir/preparar-agenda';


// Status diario a partir de esta hora; ✅ si el turno está a OBJETIVO_DIAS días o menos
const STATUS_HORA = Number(process.env.STATUS_HORA ?? 9);
const OBJETIVO_DIAS = Number(process.env.OBJETIVO_DIAS ?? 30);
const STATE_FILE = process.env.STATE_FILE ?? 'state.json';

// Turnos que fuiste tomando, en orden y separados por coma ("DD/MM/AAAA[ HH:MM]").
// El último es el actual: solo se avisa de turnos anteriores a esa fecha.
const tomados = (process.env.MI_TURNO ?? '')
  .split(',')
  .map((t) => t.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}:\d{2}))?$/))
  .filter(Boolean)
  .map(([, d, m, y, hh]) => ({ fecha: `${y}-${m}-${d}`, hora: hh }));
// Turnos agendados solos (AUTO_AGENDAR), guardados en state.json porque no pueden tocar el .env
const raw = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8').trim() : '';
const state = raw ? JSON.parse(raw) : {};
const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
for (const t of state.agendados ?? []) if (!tomados.length || t.fecha < tomados.at(-1).fecha) tomados.push(t);
const MI_TURNO = tomados.at(-1)?.fecha;
// "si" agenda solo el turno más temprano si es anterior a MI_TURNO; "simular" hace todo menos apretar el botón
const AUTO_AGENDAR = process.env.AUTO_AGENDAR ?? '';

const fmt = (iso) => iso.split('-').reverse().join('/');
const fmtTurno = (t) => fmt(t.fecha) + (t.hora ? ` ${t.hora}` : '') + (t.sede ? ` (${t.sede})` : '');

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
  if (process.platform !== 'darwin') return console.log(`[aviso] ${title}: ${msg}`);
  execFileSync('osascript', [
    '-e', 'on run argv',
    '-e', 'display notification (item 2 of argv) with title "Turno carnet" subtitle (item 1 of argv) sound name "Glass"',
    '-e', 'end run',
    title, msg,
  ]);
}

// Los id de fecha y hora cambian en cada AJAX de Drupal; el data-drupal-selector no
const SEL = { lugar: '#edit-lugar', fecha: '[data-drupal-selector=edit-fecha]', hora: '[data-drupal-selector=edit-hora]' };

async function elegir(page, campo, valor) {
  await page.selectOption(SEL[campo], valor);
  const siguiente = campo === 'lugar' ? SEL.fecha : SEL.hora;
  // Espera a que el AJAX llene el desplegable siguiente
  await page.waitForFunction((s) => document.querySelectorAll(`${s} option[value]:not([value=""])`).length > 0, siguiente, { timeout: 30000 });
  return page.$$eval(`${siguiente} option`, (os) => os.filter((o) => o.value).map((o) => ({ value: o.value, texto: o.textContent.trim() })));
}

// Elige sede, la primera fecha y la primera hora; con AUTO_AGENDAR=si aprieta "Agendar turno",
// que reemplaza el turno actual. Devuelve el turno elegido y lo que dijo la página.
async function agendar(page, sede) {
  const fechas = await elegir(page, 'lugar', sede.value);
  // Nunca para hoy ni días pasados: el primero a partir de mañana
  const fecha = fechas.map((f) => f.value).find((f) => f > hoy); // YYYY-MM-DD
  if (!fecha) throw new Error(`${sede.sede} no tiene fechas a partir de mañana`);
  if (MI_TURNO && fecha >= MI_TURNO) throw new Error(`${sede.sede} ofrece ${fmt(fecha)}, no es anterior a tu turno`);
  const horas = await elegir(page, 'fecha', fecha);
  await page.selectOption(SEL.hora, horas[0].value);
  const turno = { fecha, hora: horas[0].texto.replace(/\s*hs$/, ''), sede: sede.sede };
  if (AUTO_AGENDAR !== 'si') return { turno, simulado: true };

  await Promise.all([page.waitForLoadState('load'), page.click('#edit-submit')]);
  await page.waitForLoadState('networkidle');
  fs.writeFileSync('agendado.html', await page.content());
  const texto = (await page.innerText('main').catch(() => page.innerText('body'))).replace(/\s+/g, ' ').trim();
  const error = await page.$eval('.messages--error, .alert-danger, .alert-error, .form-item--error-message', (e) => e.textContent.trim()).catch(() => null);
  // No se probó con un turno real: si no aparece la fecha nueva, no se da por agendado
  if (!error && (await page.$('#agenda-form')) && !texto.includes(fmt(fecha))) {
    return { turno, error: 'La página no confirmó el turno (quedó en el formulario); revisá agendado.html' };
  }
  if (!error && !texto.includes(fmt(fecha))) return { turno, error: `No vi ${fmt(fecha)} en la respuesta: ${texto.slice(0, 150)}` };
  return { turno, error, texto: texto.slice(0, 600) };
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

// Fecha y hora locales (TZ=America/Argentina/Buenos_Aires en el contenedor)
const hoy = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
// 14/10/2026, 17:41:53 (es-AR solo, en 12 horas, sale 05:41:53 sin a. m./p. m.)
const ahora = () => new Date().toLocaleString('es-AR', { hourCycle: 'h23' });
const hora = new Date().getHours();
const statusPendiente = hora >= STATUS_HORA && state.statusEnviado !== hoy;
const dias = (iso) => Math.round((Date.parse(iso) - Date.parse(hoy)) / 864e5);
// "Tu turno: ..." más lo adelantado desde el primero que tomaste
const resumenMiTurno = () => {
  const actual = tomados.at(-1); // puede haber cambiado si se agendó en esta corrida
  if (!actual) return '';
  let r = `Tu turno: ${fmtTurno(actual)} (en ${dias(actual.fecha)} días)`;
  if (tomados.length > 1) {
    const ganados = dias(tomados[0].fecha) - dias(actual.fecha);
    r += `\nAdelantaste ${ganados} días: ${tomados.map(fmtTurno).join(' → ')}`;
  }
  return r;
};
const describir = (s) => `${s.sede}: ${fmt(s.fecha)} (en ${dias(s.fecha)} días)${dias(s.fecha) <= OBJETIVO_DIAS ? ' ✅' : ''}`;

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
  const sedes = (await page.$$eval('#edit-lugar option', (os) => os.map((o) => [o.value, o.textContent.trim()])))
    .map(([value, t]) => [value, t.match(/^(.*?) - Turnos a partir del (\d{2})\/(\d{2})\/(\d{4})/)])
    .filter(([, m]) => m)
    .map(([value, [, sede, d, m, y]]) => ({ sede, fecha: `${y}-${m}-${d}`, value }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  if (!sedes.length) throw new Error('No se encontraron sedes con turnos en el selector');

  // Un turno para hoy (o pasado) no sirve: se toma la primera sede con turnos desde mañana
  const mejor = sedes.find((s) => s.fecha > hoy) ?? sedes[0];
  const anterior = state.ultimo?.sedes?.[0];
  console.log(`${ahora()}  ${sedes.map((s) => `${s.sede}: ${fmt(s.fecha)}`).join(' | ')}`);

  const sirve = mejor.fecha > hoy && (!MI_TURNO || mejor.fecha < MI_TURNO);
  if (anterior && mejor.fecha < anterior.fecha && sirve) {
    const vsMiTurno = MI_TURNO ? `\nTu turno: ${fmt(MI_TURNO)} (${dias(MI_TURNO) - dias(mejor.fecha)} días antes)` : '';
    await notify('¡Turno más temprano!', `${describir(mejor)}${vsMiTurno}\nÚltima lectura: ${fmt(anterior.fecha)} (${anterior.sede})`);
  }
  // Se intenta cada vez que haya uno anterior a tu turno; un fallo se avisa una vez por fecha
  if (AUTO_AGENDAR && MI_TURNO && sirve) {
    try {
      const r = await agendar(page, mejor);
      if (r.simulado) {
        if (state.simulado !== r.turno.fecha) await notify('Simulación: agendaría', `${fmtTurno(r.turno)}\nTu turno: ${fmt(MI_TURNO)}\n(AUTO_AGENDAR=simular, no se tocó nada)`);
        state.simulado = r.turno.fecha;
      } else if (r.error) {
        throw new Error(r.error);
      } else {
        const ganados = dias(MI_TURNO) - dias(r.turno.fecha);
        (state.agendados ??= []).push(r.turno);
        tomados.push(r.turno);
        delete state.autoFallo;
        await notify('¡Turno agendado solo!', `${fmtTurno(r.turno)} (${ganados} días antes)\n\nRevisá que esté bien en tu Perfil digital. La página dijo:\n${r.texto}`);
      }
    } catch (e) {
      console.error(`Auto-agendar falló: ${e.message}`);
      if (state.autoFallo !== mejor.fecha) await notify('No pude agendar solo', `${describir(mejor)}\n${e.message.slice(0, 200)}\nAgendalo a mano si te sirve.`);
      state.autoFallo = mejor.fecha;
    }
  }
  if (state.error) await notify('Volvió a funcionar', describir(mejor));
  if (statusPendiente) {
    const miTurno = MI_TURNO ? `${resumenMiTurno()}\n\n` : '';
    await notify('Status diario', miTurno + sedes.map(describir).join('\n'));
    state.statusEnviado = hoy;
  }
  delete state.error;
  state.ultimo = { cuando: new Date().toISOString(), sedes };
  saveState();
} catch (e) {
  console.error(`${ahora()}  ${e.message}`);
  // Avisar el error una sola vez hasta que vuelva a funcionar; el status diario sigue saliendo
  if (!state.error) await notify('Error chequeando turnos', e.message.slice(0, 200));
  else if (statusPendiente) await notify('Status diario', `Sigue fallando desde ${state.error.desde}: ${state.error.msg}`);
  if (statusPendiente) state.statusEnviado = hoy;
  state.error ??= { desde: ahora(), msg: e.message.slice(0, 200) };
  saveState();
  process.exitCode = 1;
} finally {
  await browser.close();
}
