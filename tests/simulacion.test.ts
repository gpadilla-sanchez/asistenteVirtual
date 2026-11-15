/**
 * Prueba de punta a punta del entorno de simulación, con navegador real (Chromium):
 * portal ficticio → lectura automática → recordatorios al WhatsApp simulado → el cliente
 * pulsa "Sí, ya pagué" → el asistente detiene los avisos y responde.
 */
import { cpSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorPortal, FuentePortal } from '../src/fuentes/portal.js';
import { crearLogger } from '../src/logger.js';
import { cargarConfiguracion, type Rutas } from '../src/plataforma/configuracion.js';
import { Plataforma } from '../src/plataforma/plataforma.js';
import { Reloj } from '../src/plataforma/reloj.js';
import { Boveda } from '../src/seguridad/boveda.js';
import { hashContrasena } from '../src/seguridad/contrasenas.js';
import { crearApp } from '../src/servidor/app.js';
import { DEMO } from '../src/simulador/demo.js';
import { crearAppMeta, EstadoMeta } from '../src/simulador/meta.js';
import { crearAppPortal, EstadoPortal } from '../src/simulador/portal.js';
import { fechaEnZona } from '../src/utils/fechas.js';
import { CHROMIUM } from './ayudantes.js';

const servidores: Server[] = [];
const escuchar = (app: { listen: (p: number, cb: () => void) => Server }) =>
  new Promise<string>((r) => {
    const s = app.listen(0, () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    servidores.push(s);
  });
const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

let plataforma: Plataforma;
let estadoMeta: EstadoMeta;
let urlMeta: string;
let urlPortal: string;
let portal: EstadoPortal;
let rutas: Rutas;

beforeAll(async () => {
  const hoy = fechaEnZona(new Date(), 'America/Mexico_City');
  portal = new EstadoPortal(Object.values(DEMO.portal), hoy);
  urlPortal = await escuchar(crearAppPortal(portal));

  // El asistente necesita la URL del simulador de Meta y viceversa: se arranca Meta con URL provisional
  estadoMeta = new EstadoMeta();
  const opcionesMeta = { tokens: [DEMO.metaToken], appSecret: DEMO.appSecret, asistenteUrl: '', tokenSimulacion: DEMO.tokenSimulacion, plantillas: DEMO.plantillas, zona: 'America/Mexico_City', portal, sinRetraso: true };
  urlMeta = await escuchar(crearAppMeta(opcionesMeta, estadoMeta).app);

  const base = mkdtempSync(join(tmpdir(), 'sim-'));
  cpSync('config-simulacion', join(base, 'config'), { recursive: true });
  rutas = { config: join(base, 'config'), secretos: join(base, 'secretos'), claveMaestra: join(base, 'secretos', 'clave'), datos: join(base, 'data') };
  process.env.GRAPH_URL = urlMeta;
  process.env.SIMULADOR_PORTAL_URL = urlPortal;
  process.env.RUTA_CHROMIUM = CHROMIUM;

  Boveda.crearClaveMaestra(rutas.claveMaestra);
  const boveda = Boveda.abrir(rutas.secretos, rutas.claveMaestra);
  boveda.actualizar('sistema', { 'meta.app_secret': DEMO.appSecret, 'meta.verify_token': DEMO.verifyToken, 'meta.token': DEMO.metaToken, 'panel.hash': hashContrasena(DEMO.panel.admin!) });
  for (const [id, cred] of Object.entries(DEMO.portal)) {
    boveda.actualizar(id, { 'portal.usuario': cred.usuario, 'portal.contrasena': cred.contrasena, 'panel.hash': hashContrasena(DEMO.panel[id]!) });
  }

  plataforma = Plataforma.crear(rutas, { reloj: new Reloj(), tokenSimulacion: DEMO.tokenSimulacion });
  for (const c of plataforma.contextos.values()) (c.logger as { level: string }).level = 'fatal';
  (plataforma.sistema.envios as { pausa_entre_envios_ms: number }).pausa_entre_envios_ms = 0;
  opcionesMeta.asistenteUrl = await escuchar(crearApp(plataforma));
}, 60_000);

afterAll(() => {
  servidores.forEach((s) => s.close());
  plataforma?.cerrar();
});

describe('simulación completa en la "Raspberry"', () => {
  it('lee el portal con navegador real: tabla paginada (Ana) y exportación CSV (Luis)', async () => {
    const ana = await plataforma.sincronizarAgente('ana-lopez');
    const luis = await plataforma.sincronizarAgente('luis-martinez');
    expect(ana.recibos).toBe(12); // 3 páginas de 5
    expect(luis.recibos).toBe(12);
    const recibo = plataforma.contexto('ana-lopez').db.listarPagos().find((p) => p.producto)!;
    expect(recibo.telefono).toMatch(/^5255\d{8}$/);
    expect(recibo.poliza).toMatch(/^[A-Z]{3}-\d{6}$/);
  }, 90_000);

  it('envía recordatorios al WhatsApp simulado con la plantilla correcta', async () => {
    const r = await plataforma.revisarAgente('ana-lopez', { ignorarHorario: true });
    expect(r.enviados).toBeGreaterThan(3);
    const recordatorio = estadoMeta.mensajes.find((m) => m.botones);
    expect(recordatorio!.texto).toMatch(/soy Ana López, tu asesor de seguros/);
    expect(recordatorio!.botones).toEqual(['Sí, ya pagué', 'Aún no']);
    await esperar(300);
    expect(estadoMeta.mensajes.filter((m) => m.estado === 'delivered').length).toBeGreaterThan(0);
  });

  it('el número que no tiene WhatsApp queda registrado como no entregado', async () => {
    await esperar(300);
    const db = plataforma.contexto('ana-lopez').db;
    expect(db.eventos().some((e) => e.tipo === 'no_entregado')).toBe(true);
  });

  it('el cliente pulsa "Sí, ya pagué" en el teléfono simulado → se detienen los avisos', async () => {
    const msg = estadoMeta.mensajes.find((m) => m.botones && !m.tel.endsWith('9999'))!;
    await request(urlMeta).post('/ui/boton').type('form').send({ wamid: msg.wamid, indice: '0' }).expect(303);
    await esperar(400);
    const reciboId = msg.payloads![0]!.split('|')[2]!;
    const db = plataforma.contexto('ana-lopez').db;
    expect(db.obtenerSeguimiento(reciboId)!.estado).toBe('reportado');
    expect(estadoMeta.mensajes.some((m) => m.tel === msg.tel && m.texto.includes('Registré tu confirmación'))).toBe(true);
  });

  it('los controles del simulador adelantan el reloj del asistente', async () => {
    await request(urlMeta).post('/ui/control').type('form').send({ accion: 'avanzar' }).expect(303);
    expect(plataforma.reloj.desfaseDias).toBe(1);
    await request(urlMeta).post('/ui/control').type('form').send({ accion: 'hoy' }).expect(303);
    expect(plataforma.reloj.desfaseDias).toBe(0);
  });

  it('con usuario o contraseña incorrectos avisa "credenciales"', async () => {
    const { perfiles } = cargarConfiguracion(rutas.config);
    const fuente = new FuentePortal({
      perfil: perfiles.get('aseguradora_demo')!,
      credenciales: () => ({ usuario: 'ana.lopez', contrasena: 'incorrecta' }),
      aceptaPorDefecto: true, rutaChromium: CHROMIUM, argumentos: ['--no-sandbox'], tiempoEsperaMs: 15_000,
      dirTrabajo: join(rutas.datos, 'tmp'), logger: crearLogger('fatal'),
    });
    await expect(fuente.leerPagos()).rejects.toMatchObject({ tipo: 'credenciales' });
    await expect(fuente.leerPagos()).rejects.toBeInstanceOf(ErrorPortal);
  }, 60_000);
});
