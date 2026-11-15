import { createHmac } from 'node:crypto';
import { BaseDatos } from '../src/db/baseDatos.js';
import type { FuenteDatos, Pago } from '../src/fuentes/tipos.js';
import { crearLogger } from '../src/logger.js';
import type { Notificador } from '../src/notificaciones.js';
import { esquemaAgente, esquemaSistema, type ConfigAgente } from '../src/plataforma/configuracion.js';
import type { ContextoAgente } from '../src/plataforma/contexto.js';
import { Plataforma } from '../src/plataforma/plataforma.js';
import { Reloj } from '../src/plataforma/reloj.js';
import { hashContrasena } from '../src/seguridad/contrasenas.js';
import type { ClienteWhatsApp, EnvioPlantilla } from '../src/whatsapp/cliente.js';

export const SECRETO = 'secreto-de-prueba';
export const CHROMIUM = process.env.RUTA_CHROMIUM ?? '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome';

export function sistemaPrueba() {
  return esquemaSistema.parse({ modo: 'simulacion', nivel_log: 'fatal', envios: { pausa_entre_envios_ms: 0 } });
}

export function agentePrueba(id: string, extra: Partial<Record<string, unknown>> = {}): ConfigAgente {
  return esquemaAgente.parse({
    id,
    nombre: `Agente ${id}`,
    whatsapp: { phone_number_id: `PN-${id}` },
    panel: { usuario: id },
    fuente: { tipo: 'portal', perfil: 'demo' },
    envios: { primer_aviso_dias_antes: 3, max_avisos: 4, reabrir_reportado_tras_dias: 3, dias_semana: ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] },
    ...extra,
  });
}

export class FuenteMemoria implements FuenteDatos {
  readonly nombre = 'Memoria';
  fallar = false;
  constructor(public pagos: Pago[]) {}
  async leerPagos(): Promise<Pago[]> {
    if (this.fallar) throw new Error('El portal no responde');
    return this.pagos.map((p) => ({ ...p }));
  }
  pago(id: string): Pago {
    return this.pagos.find((p) => p.id === id)!;
  }
}

export class WhatsAppFalso implements ClienteWhatsApp {
  plantillas: EnvioPlantilla[] = [];
  textos: { para: string; texto: string }[] = [];
  private n = 0;
  constructor(private readonly prefijo = 'X') {}
  async enviarPlantilla(e: EnvioPlantilla): Promise<string> {
    this.plantillas.push(e);
    return `wamid.${this.prefijo}${++this.n}`;
  }
  async enviarTexto(para: string, texto: string): Promise<string> {
    this.textos.push({ para, texto });
    return `wamid.${this.prefijo}T${++this.n}`;
  }
}

export class NotificadorFalso implements Notificador {
  avisos: { asunto: string; texto: string }[] = [];
  async notificar(asunto: string, texto: string): Promise<void> {
    this.avisos.push({ asunto, texto });
  }
}

export function pago(id: string, extra: Partial<Pago> = {}): Pago {
  return {
    id, poliza: `POL-${id}`, cliente: `Cliente ${id}`, telefono: '523311110000', telefonoOriginal: '3311110000',
    producto: 'Vida', monto: 1000, fechaVencimiento: '2026-11-06', estado: 'pendiente', estadoOriginal: 'Pendiente', aceptaWhatsapp: true,
    ...extra,
  };
}

export interface Escenario {
  ctx: ContextoAgente;
  fuente: FuenteMemoria;
  wa: WhatsAppFalso;
  avisos: NotificadorFalso;
  reloj: Reloj;
  /** Mueve el reloj a 'YYYY-MM-DD' a la hora indicada (hora de México). */
  dia(fecha: string, hora?: string): void;
}

export function escenario(pagos: Pago[], agente = agentePrueba('ana'), relojCompartido?: Reloj): Escenario {
  let actual = new Date('2026-11-04T10:00:00-06:00');
  const reloj = relojCompartido ?? new Reloj(() => actual);
  const fuente = new FuenteMemoria(pagos);
  const wa = new WhatsAppFalso(agente.id);
  const avisos = new NotificadorFalso();
  const ctx: ContextoAgente = {
    agente, sistema: sistemaPrueba(), logger: crearLogger('fatal'), db: new BaseDatos(':memory:'),
    fuente, whatsapp: wa, notificador: avisos, reloj,
  };
  return { ctx, fuente, wa, avisos, reloj, dia(fecha, hora = '10:00') { actual = new Date(`${fecha}T${hora}:00-06:00`); } };
}

export const CONTRASENAS = { admin: 'Admin-Prueba-2026', ana: 'Ana-Prueba-2026', luis: 'Luis-Prueba-2026' };

/** Plataforma con varios agentes en memoria. */
export function plataformaPrueba(escenarios: Escenario[]): Plataforma {
  const sistema = sistemaPrueba();
  return new Plataforma(
    sistema,
    {
      appSecret: SECRETO,
      verifyToken: 'verificame123',
      usuariosPanel: [
        { usuario: 'admin', hash: hashContrasena(CONTRASENAS.admin), agenteId: null },
        ...escenarios.map((e) => ({ usuario: e.ctx.agente.panel.usuario, hash: hashContrasena(CONTRASENAS[e.ctx.agente.id as 'ana'] ?? 'x'), agenteId: e.ctx.agente.id })),
      ],
      tokenSimulacion: 'token-sim',
    },
    escenarios[0]!.reloj,
    crearLogger('fatal'),
    escenarios.map((e) => e.ctx),
  );
}

export function webhookMensaje(phoneNumberId: string, mensaje: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, messages: [mensaje] } }] }],
  };
}

export function webhookEstado(phoneNumberId: string, estado: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, statuses: [estado] } }] }],
  };
}

export function firmar(cuerpo: string): string {
  return `sha256=${createHmac('sha256', SECRETO).update(cuerpo).digest('hex')}`;
}
