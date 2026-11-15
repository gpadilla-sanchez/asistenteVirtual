import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { revisar, sincronizar } from '../src/dominio/revision.js';
import { crearApp } from '../src/servidor/app.js';
import { agentePrueba, CONTRASENAS, escenario, firmar, pago, plataformaPrueba, webhookMensaje } from './ayudantes.js';

async function preparar() {
  const ana = escenario([pago('A1')], agentePrueba('ana'));
  const luis = escenario([pago('L1', { telefono: '523344440000' })], agentePrueba('luis'), ana.reloj);
  for (const e of [ana, luis]) {
    await sincronizar(e.ctx);
    await revisar(e.ctx);
  }
  const p = plataformaPrueba([ana, luis]);
  return { ana, luis, app: crearApp(p) };
}

const csrfDe = (html: string) => html.match(/name="csrf" value="([a-f0-9]+)"/)![1]!;

describe('webhook', () => {
  it('verificación de Meta con el verify token', async () => {
    const { app } = await preparar();
    await request(app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'verificame123', 'hub.challenge': 'abc' }).expect(200, 'abc');
    await request(app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'malo', 'hub.challenge': 'abc' }).expect(403);
  });

  it('rechaza firmas inválidas y procesa las válidas', async () => {
    const { app, luis } = await preparar();
    const cuerpo = JSON.stringify(webhookMensaje('PN-luis', { id: 'w1', from: '5213344440000', type: 'button', button: { payload: 'SI|luis|L1', text: 'Sí' } }));
    await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', 'sha256=00').send(cuerpo).expect(401);
    await request(app).post('/webhook').set('Content-Type', 'application/json').set('X-Hub-Signature-256', firmar(cuerpo)).send(cuerpo).expect(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(luis.ctx.db.obtenerSeguimiento('L1')!.estado).toBe('reportado');
  });
});

describe('panel con usuario y contraseña', () => {
  it('pide contraseña y rechaza la incorrecta', async () => {
    const { app } = await preparar();
    await request(app).get('/panel').expect(401);
    await request(app).get('/panel').auth('ana', 'equivocada').expect(401);
  });

  it('el administrador ve a todos; cada agente solo lo suyo', async () => {
    const { app } = await preparar();
    const admin = await request(app).get('/panel').auth('admin', CONTRASENAS.admin).expect(200);
    expect(admin.text).toContain('Agente ana');
    expect(admin.text).toContain('Agente luis');
    await request(app).get('/panel').auth('ana', CONTRASENAS.ana).expect(302).expect('location', '/panel/agentes/ana');
    const propia = await request(app).get('/panel/agentes/ana').auth('ana', CONTRASENAS.ana).expect(200);
    expect(propia.text).toContain('Cliente A1');
    expect(propia.text).not.toContain('Cliente L1');
    await request(app).get('/panel/agentes/luis').auth('ana', CONTRASENAS.ana).expect(404);
  });

  it('las acciones exigen token CSRF', async () => {
    const { app, ana } = await preparar();
    await request(app).post('/panel/agentes/ana/recibos/A1').auth('ana', CONTRASENAS.ana).type('form').send({ accion: 'marcar_pagado' }).expect(403);
    const html = (await request(app).get('/panel/agentes/ana').auth('ana', CONTRASENAS.ana)).text;
    await request(app).post('/panel/agentes/ana/recibos/A1').auth('ana', CONTRASENAS.ana).type('form').send({ accion: 'marcar_pagado', csrf: csrfDe(html) }).expect(303);
    expect(ana.ctx.db.obtenerSeguimiento('A1')!.estado).toBe('pagado');
  });

  it('un agente no puede actuar sobre recibos de otro', async () => {
    const { app, luis } = await preparar();
    const html = (await request(app).get('/panel/agentes/ana').auth('ana', CONTRASENAS.ana)).text;
    await request(app).post('/panel/agentes/luis/recibos/L1').auth('ana', CONTRASENAS.ana).type('form').send({ accion: 'marcar_pagado', csrf: csrfDe(html) }).expect(404);
    expect(luis.ctx.db.obtenerSeguimiento('L1')!.estado).toBe('pendiente');
  });

  it('bloquea la IP tras muchos intentos fallidos', async () => {
    const { app } = await preparar();
    for (let i = 0; i < 8; i++) await request(app).get('/panel').auth('admin', `mala-${i}`).expect(401);
    await request(app).get('/panel').auth('admin', CONTRASENAS.admin).expect(429);
  });

  it('los controles de simulación exigen su token', async () => {
    const { app } = await preparar();
    await request(app).get('/simulacion/estado').expect(403);
    const r = await request(app).get('/simulacion/estado').set('X-Simulacion-Token', 'token-sim').expect(200);
    expect(r.body.agentes).toHaveLength(2);
  });
});
