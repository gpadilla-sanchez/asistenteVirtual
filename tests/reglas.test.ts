import { describe, expect, it } from 'vitest';
import { clasificarTexto } from '../src/dominio/clasificador.js';
import { calcularProximoEnvio, decidir } from '../src/dominio/revision.js';
import { parsearCsv } from '../src/fuentes/archivo.js';
import { interpretarTabla } from '../src/fuentes/columnas.js';
import { esquemaPerfil } from '../src/plataforma/configuracion.js';
import { normalizarTelefono } from '../src/utils/telefono.js';
import { interpretarPayload, payloadsPara } from '../src/whatsapp/plantillas.js';
import { agentePrueba, pago } from './ayudantes.js';

const reglas = agentePrueba('xxx', { envios: { primer_aviso_dias_antes: 5, repetir_cada_dias: 2, repetir_cada_dias_vencido: 1, max_avisos: 3, dejar_de_avisar_dias_despues: 10 } }).envios;

describe('cuándo se envía (decidir)', () => {
  const p = pago('A', { fechaVencimiento: '2026-11-20' });
  it('primer aviso N días antes', () => {
    expect(decidir(p, undefined, '2026-11-14', reglas, false)).toMatchObject({ motivo: 'aún no toca avisar' });
    expect(decidir(p, undefined, '2026-11-15', reglas, false)).toEqual({ tipo: 'enviar', plantilla: 'recordatorio' });
    expect(decidir(p, undefined, '2026-11-21', reglas, false)).toEqual({ tipo: 'enviar', plantilla: 'seguimiento' });
  });
  it('no escribe si la aseguradora ya lo marca pagado, sin teléfono, sin consentimiento o con baja', () => {
    expect(decidir({ ...p, estado: 'pagado' }, undefined, '2026-11-18', reglas, false).tipo).toBe('omitir');
    expect(decidir({ ...p, telefono: null }, undefined, '2026-11-18', reglas, false)).toMatchObject({ motivo: 'teléfono inválido' });
    expect(decidir({ ...p, aceptaWhatsapp: false }, undefined, '2026-11-18', reglas, false)).toMatchObject({ motivo: 'sin consentimiento' });
    expect(decidir(p, undefined, '2026-11-18', reglas, true)).toMatchObject({ motivo: 'cliente dado de baja' });
  });
  it('vencido hace demasiado: escala solo si ya se le había avisado', () => {
    expect(decidir(p, undefined, '2026-12-05', reglas, false)).toMatchObject({ tipo: 'omitir' });
    const seg = { pagoId: 'A', estado: 'pendiente' as const, origenEstado: 'sistema' as const, intentos: 2, ultimoEnvio: null, ultimoEnvioDia: '2026-11-25', proximoEnvio: '2026-11-26', ultimaRespuesta: null, fechaRespuesta: null, noReconocidas: 0, ultimoError: null };
    expect(decidir(p, seg, '2026-12-05', reglas, false)).toEqual({ tipo: 'escalar' });
  });
});

describe('cada cuándo se repite (calcularProximoEnvio)', () => {
  it('antes del vencimiento cada N días, sin saltarse el día límite', () => {
    expect(calcularProximoEnvio('2026-11-15', '2026-11-20', reglas)).toBe('2026-11-17');
    expect(calcularProximoEnvio('2026-11-19', '2026-11-20', reglas)).toBe('2026-11-20');
  });
  it('ya vencido usa su propio intervalo', () => {
    expect(calcularProximoEnvio('2026-11-20', '2026-11-20', reglas)).toBe('2026-11-21');
  });
});

describe('lectura de tablas del portal', () => {
  const perfil = esquemaPerfil.parse({
    nombre: 'x', url_login: 'x',
    columnas: { id: 'Recibo', cliente: 'Contratante', telefono: 'Teléfono', fecha_vencimiento: 'Fecha límite', monto: 'Prima', estado: 'Estatus', poliza: 'Póliza' },
    estados: { pagado: ['Aplicado'] },
  });
  it('mapea por el texto exacto del encabezado', () => {
    const pagos = interpretarTabla([
      ['Póliza', 'Recibo', 'Contratante', 'Teléfono', 'Prima', 'Fecha límite', 'Estatus'],
      ['GMM-1', 'R-1', 'Ana Ruiz', '(55) 1234-5678', '$3,450.50', '15/11/2026', 'Pendiente'],
      ['GMM-2', 'R-2', 'Luis Paz', '55 8765 4321', '$900.00', '02/12/2026', 'Aplicado'],
      ['GMM-2', 'R-2', 'duplicado', '', '', '', ''],
    ], perfil, true);
    expect(pagos).toHaveLength(2);
    expect(pagos[0]).toMatchObject({ id: 'R-1', poliza: 'GMM-1', telefono: '525512345678', monto: 3450.5, fechaVencimiento: '2026-11-15', estado: 'pendiente', aceptaWhatsapp: true });
    expect(pagos[1]!.estado).toBe('pagado');
  });
  it('explica qué columnas faltan', () => {
    expect(() => interpretarTabla([['Recibo', 'Nombre']], perfil, true)).toThrow(/Contratante/);
  });
  it('lee CSV con comillas, punto y coma y BOM', () => {
    expect(parsearCsv('﻿"Recibo";"Contratante"\r\n"R-1";"Pérez; Juan ""JJ"""\r\n')).toEqual([['Recibo', 'Contratante'], ['R-1', 'Pérez; Juan "JJ"']]);
  });
});

describe('varios', () => {
  it('los botones llevan agente y recibo', () => {
    const [si, no] = payloadsPara('ana-lopez', 'R-AL-1001');
    expect(interpretarPayload(si)).toEqual({ respuesta: 'si', agenteId: 'ana-lopez', pagoId: 'R-AL-1001' });
    expect(interpretarPayload(no)!.respuesta).toBe('no');
    expect(interpretarPayload('otra cosa')).toBeNull();
  });
  it('normaliza teléfonos mexicanos (incluido el 521 de WhatsApp)', () => {
    expect(normalizarTelefono('5215500010003')).toBe('525500010003');
    expect(normalizarTelefono('(55) 0001-0003')).toBe('525500010003');
  });
  it.each([
    ['Sí', 'si'], ['ya pagué', 'si'], ['ya realicé el pago hoy en la mañana', 'si'], ['aún no', 'no'], ['te pago la próxima semana', 'no'],
    ['BAJA', 'baja'], ['ya no me escriban', 'baja'], ['ayuda', 'ayuda'], ['si no he pagado es por la factura', 'otro'], ['hola', 'otro'],
  ])('clasifica "%s" → %s', (t, e) => expect(clasificarTexto(t)).toBe(e));
});
