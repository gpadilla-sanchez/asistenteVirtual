/**
 * Flujo completo por agente:
 *  - avisa cuando toca y pregunta si ya pagó,
 *  - "Sí" detiene los avisos; "No" o silencio → se repite según la configuración del agente,
 *  - la aseguradora manda: si el portal lo marca pagado (o desaparece) se detiene.
 */
import { describe, expect, it } from 'vitest';
import { aplicarAccion } from '../src/dominio/acciones.js';
import { revisar, sincronizar } from '../src/dominio/revision.js';
import { agentePrueba, escenario, pago, plataformaPrueba, webhookEstado, webhookMensaje } from './ayudantes.js';

const boton = (pn: string, agente: string, recibo: string, r: 'SI' | 'NO', id: string) =>
  webhookMensaje(pn, { id, from: '5213311110000', type: 'button', button: { payload: `${r}|${agente}|${recibo}`, text: r } });
const texto = (pn: string, body: string, id: string, extra: Record<string, unknown> = {}) =>
  webhookMensaje(pn, { id, from: '5213311110000', type: 'text', text: { body }, ...extra });

async function diaCompleto(e: ReturnType<typeof escenario>, fecha: string) {
  e.dia(fecha);
  await sincronizar(e.ctx);
  return revisar(e.ctx);
}

describe('flujo de un agente', () => {
  it('envía la plantilla con los datos de la póliza y el nombre del agente', async () => {
    const e = escenario([pago('A', { fechaVencimiento: '2026-11-06' }), pago('B', { fechaVencimiento: '2026-11-30', telefono: '523322220000' })]);
    const r = await diaCompleto(e, '2026-11-04');
    expect(r.enviados).toBe(1);
    expect(e.wa.plantillas[0]).toMatchObject({
      para: '523311110000',
      plantilla: 'recordatorio_poliza_v1',
      variables: ['Cliente', 'Agente ana', 'Vida', 'POL-A', '$1,000.00 MXN', '6 de noviembre'],
      payloadsBotones: ['SI|ana|A', 'NO|ana|A'],
    });
  });

  it('SÍ → deja de mandar mensajes', async () => {
    const e = escenario([pago('A')]);
    const p = plataformaPrueba([e]);
    await diaCompleto(e, '2026-11-04');
    await p.procesarWebhook(boton('PN-ana', 'ana', 'A', 'SI', 'in1'));
    expect(e.ctx.db.obtenerSeguimiento('A')!.estado).toBe('reportado');
    expect(e.wa.textos.at(-1)!.texto).toMatch(/Registré tu confirmación/);
    expect(e.avisos.avisos.some((a) => a.asunto.includes('reporta que ya pagó'))).toBe(true);
    await diaCompleto(e, '2026-11-05');
    await diaCompleto(e, '2026-11-06');
    expect(e.wa.plantillas).toHaveLength(1);
  });

  it('NO → vuelve a mandar al día siguiente (y no el mismo día)', async () => {
    const e = escenario([pago('A')]);
    const p = plataformaPrueba([e]);
    await diaCompleto(e, '2026-11-04');
    await p.procesarWebhook(boton('PN-ana', 'ana', 'A', 'NO', 'in1'));
    expect(e.wa.textos.at(-1)!.texto).toMatch(/Te lo recordaré mañana/);
    e.dia('2026-11-04', '18:00');
    await revisar(e.ctx);
    expect(e.wa.plantillas).toHaveLength(1);
    await diaCompleto(e, '2026-11-05');
    expect(e.wa.plantillas).toHaveLength(2);
  });

  it('respeta "cada cuándo" de cada agente (cada 2 días antes de vencer)', async () => {
    const agente = agentePrueba('luis', { envios: { primer_aviso_dias_antes: 6, repetir_cada_dias: 2, repetir_cada_dias_vencido: 1, dias_semana: ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] } });
    const e = escenario([pago('A', { fechaVencimiento: '2026-11-09' })], agente);
    const dias: string[] = [];
    for (const d of ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']) {
      const antes = e.wa.plantillas.length;
      await diaCompleto(e, d);
      if (e.wa.plantillas.length > antes) dias.push(d);
    }
    expect(dias).toEqual(['2026-11-04', '2026-11-06', '2026-11-08', '2026-11-09', '2026-11-10']);
  });

  it('respeta los días de la semana permitidos', async () => {
    const agente = agentePrueba('ana', { envios: { dias_semana: ['lun', 'mar', 'mie', 'jue', 'vie'] } });
    const e = escenario([pago('A', { fechaVencimiento: '2026-11-10' })], agente);
    const r = await diaCompleto(e, '2026-11-08'); // domingo
    expect(r.ejecutada).toBe(false);
    expect(r.motivo).toMatch(/dom/);
  });

  it('si la aseguradora marca el recibo pagado, se detiene', async () => {
    const e = escenario([pago('A')]);
    await diaCompleto(e, '2026-11-04');
    e.fuente.pago('A').estado = 'pagado';
    await diaCompleto(e, '2026-11-05');
    expect(e.ctx.db.obtenerSeguimiento('A')).toMatchObject({ estado: 'pagado', origenEstado: 'fuente' });
    expect(e.wa.plantillas).toHaveLength(1);
  });

  it('si el recibo desaparece del portal, se asume pagado', async () => {
    const e = escenario([pago('A'), pago('B', { telefono: '523322220000' })]);
    await diaCompleto(e, '2026-11-04');
    e.fuente.pagos = e.fuente.pagos.filter((p) => p.id !== 'A');
    const r = await sincronizar(e.ctx);
    expect(r.ausentes).toBe(1);
    expect(e.ctx.db.obtenerSeguimiento('A')!.origenEstado).toBe('ausente_en_fuente');
  });

  it('si el portal devuelve 0 recibos de golpe, no borra nada y no envía', async () => {
    const e = escenario([pago('A')]);
    await diaCompleto(e, '2026-11-04');
    e.fuente.pagos = [];
    await expect(sincronizar(e.ctx)).rejects.toThrow(/no devolvió recibos/);
    expect(e.ctx.db.obtenerSeguimiento('A')!.estado).toBe('pendiente');
  });

  it('no envía con información vieja si el portal falla', async () => {
    const e = escenario([pago('A')]);
    await diaCompleto(e, '2026-11-04');
    e.fuente.fallar = true;
    e.dia('2026-11-06');
    const r = await revisar(e.ctx);
    expect(r.ejecutada).toBe(false);
    expect(r.motivo).toMatch(/no se pudo actualizar/);
    expect(e.wa.plantillas).toHaveLength(1);
    expect(e.avisos.avisos.some((a) => a.asunto === 'No se enviaron recordatorios hoy')).toBe(true);
  });

  it('dijo SÍ pero la aseguradora no aplica el pago en N días → se reanuda', async () => {
    const e = escenario([pago('A', { fechaVencimiento: '2026-11-08' })]); // reabrir_reportado_tras_dias = 3
    const p = plataformaPrueba([e]);
    await diaCompleto(e, '2026-11-05');
    await p.procesarWebhook(boton('PN-ana', 'ana', 'A', 'SI', 'in1'));
    await diaCompleto(e, '2026-11-07');
    expect(e.wa.plantillas).toHaveLength(1);
    const r = await diaCompleto(e, '2026-11-08');
    expect(r.reabiertos).toBe(1);
    expect(e.wa.plantillas).toHaveLength(2);
    expect(e.avisos.avisos.some((a) => a.asunto.includes('aún no aplica'))).toBe(true);
  });

  it('al llegar al máximo de avisos lo marca "requiere atención" y avisa al agente', async () => {
    const e = escenario([pago('A', { fechaVencimiento: '2026-11-05' })]); // max_avisos = 4
    for (const d of ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09']) await diaCompleto(e, d);
    expect(e.wa.plantillas).toHaveLength(4);
    expect(e.ctx.db.obtenerSeguimiento('A')!.estado).toBe('escalado');
    expect(e.avisos.avisos.some((a) => a.asunto.includes('requieren tu atención'))).toBe(true);
  });

  it('acciones del panel: pagado, reabrir', async () => {
    const e = escenario([pago('A')]);
    await diaCompleto(e, '2026-11-04');
    aplicarAccion(e.ctx, 'A', 'marcar_pagado', 'ana');
    await diaCompleto(e, '2026-11-05');
    expect(e.wa.plantillas).toHaveLength(1);
    aplicarAccion(e.ctx, 'A', 'reabrir', 'ana');
    await diaCompleto(e, '2026-11-06');
    expect(e.wa.plantillas).toHaveLength(2);
    expect(e.ctx.db.eventos('A').map((x) => x.tipo)).toContain('marcar_pagado');
  });

  it('texto libre, comprobante, BAJA, duplicados y entregas fallidas', async () => {
    const e = escenario([pago('A')]);
    const p = plataformaPrueba([e]);
    await diaCompleto(e, '2026-11-04');
    await p.procesarWebhook(texto('PN-ana', 'ya pagué', 'in1'));
    expect(e.ctx.db.obtenerSeguimiento('A')!.estado).toBe('reportado');

    const e2 = escenario([pago('B')]);
    const p2 = plataformaPrueba([e2]);
    await diaCompleto(e2, '2026-11-04');
    await p2.procesarWebhook(webhookMensaje('PN-ana', { id: 'img', from: '5213311110000', type: 'image', image: { id: 'm' } }));
    expect(e2.ctx.db.obtenerSeguimiento('B')!.estado).toBe('reportado');

    const e3 = escenario([pago('C')]);
    const p3 = plataformaPrueba([e3]);
    await diaCompleto(e3, '2026-11-04');
    await p3.procesarWebhook(texto('PN-ana', 'BAJA', 'b1'));
    await p3.procesarWebhook(texto('PN-ana', 'BAJA', 'b1')); // duplicado
    expect(e3.wa.textos).toHaveLength(1);
    await diaCompleto(e3, '2026-11-05');
    expect(e3.wa.plantillas).toHaveLength(1);

    await p3.procesarWebhook(webhookEstado('PN-ana', { id: 'wamid.ana1', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }));
    expect(e3.avisos.avisos.some((a) => a.asunto === 'Recordatorio no entregado')).toBe(true);
  });
});

describe('varios agentes', () => {
  it('cada respuesta llega a su agente, aunque compartan número de WhatsApp', async () => {
    const ana = escenario([pago('A1')], agentePrueba('ana', { whatsapp: { phone_number_id: 'COMPARTIDO' } }));
    const luis = escenario([pago('L1', { telefono: '523344440000' })], agentePrueba('luis', { whatsapp: { phone_number_id: 'COMPARTIDO' } }), ana.reloj);
    const p = plataformaPrueba([ana, luis]);
    await diaCompleto(ana, '2026-11-04');
    await sincronizar(luis.ctx);
    await revisar(luis.ctx);

    // Botón: el payload trae el agente
    await p.procesarWebhook(boton('COMPARTIDO', 'luis', 'L1', 'SI', 'x1'));
    expect(luis.ctx.db.obtenerSeguimiento('L1')!.estado).toBe('reportado');
    expect(ana.ctx.db.obtenerSeguimiento('A1')!.estado).toBe('pendiente');

    // Texto citando el mensaje: se busca qué agente lo envió
    await p.procesarWebhook(texto('COMPARTIDO', 'si', 'x2', { context: { id: 'wamid.ana1' } }));
    expect(ana.ctx.db.obtenerSeguimiento('A1')!.estado).toBe('reportado');
  });

  it('los datos de cada agente están separados', async () => {
    const ana = escenario([pago('A1')], agentePrueba('ana'));
    const luis = escenario([pago('L1')], agentePrueba('luis'), ana.reloj);
    await diaCompleto(ana, '2026-11-04');
    expect(ana.ctx.db.listarPagos().map((x) => x.id)).toEqual(['A1']);
    expect(luis.ctx.db.listarPagos()).toHaveLength(0);
  });
});
