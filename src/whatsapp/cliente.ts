import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '../logger.js';
import { enmascarar } from '../utils/telefono.js';
import { esperar } from '../utils/texto.js';

export interface EnvioPlantilla {
  para: string;
  plantilla: string;
  idioma: string;
  /** Valores de {{1}}, {{2}}, ... del cuerpo */
  variables: string[];
  /** Payload de cada botón de respuesta rápida, en orden (índice 0, 1, ...) */
  payloadsBotones: string[];
}

/** Lo mínimo que el asistente necesita de WhatsApp. Permite usar un cliente falso en pruebas. */
export interface ClienteWhatsApp {
  enviarPlantilla(envio: EnvioPlantilla): Promise<string>;
  enviarTexto(para: string, texto: string): Promise<string>;
}

export class ErrorWhatsApp extends Error {
  constructor(
    mensaje: string,
    readonly estadoHttp: number,
    readonly codigo: number | undefined,
    /** true si reintentar no servirá (número inválido, plantilla no aprobada, token vencido, etc.) */
    readonly permanente: boolean,
  ) {
    super(mensaje);
    this.name = 'ErrorWhatsApp';
  }

  /** Error de token o permisos: no tiene caso seguir enviando. */
  get esDeAutenticacion(): boolean {
    return this.codigo === 190 || this.estadoHttp === 401;
  }
}

interface OpcionesCloudApi {
  /** https://graph.facebook.com en producción; el simulador en modo simulación. */
  graphUrl: string;
  token: string;
  phoneNumberId: string;
  versionApi: string;
  logger: Logger;
  reintentos?: number;
}

/** Cliente de la WhatsApp Cloud API de Meta (https://graph.facebook.com). */
export class ClienteCloudApi implements ClienteWhatsApp {
  constructor(private readonly op: OpcionesCloudApi) {}

  private async llamar(cuerpo: Record<string, unknown>): Promise<string> {
    const url = `${this.op.graphUrl.replace(/\/$/, '')}/${this.op.versionApi}/${this.op.phoneNumberId}/messages`;
    const maximo = this.op.reintentos ?? 3;
    for (let intento = 1; ; intento++) {
      let respuesta: Response;
      try {
        respuesta = await fetch(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.op.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ messaging_product: 'whatsapp', ...cuerpo }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        if (intento >= maximo) throw new ErrorWhatsApp(`Sin conexión con Meta: ${(e as Error).message}`, 0, undefined, false);
        await esperar(1000 * 2 ** (intento - 1));
        continue;
      }
      const datos = (await respuesta.json().catch(() => ({}))) as {
        messages?: { id: string }[];
        error?: { message?: string; code?: number; error_data?: { details?: string } };
      };
      if (respuesta.ok && datos.messages?.[0]?.id) return datos.messages[0].id;

      const temporal = respuesta.status === 429 || respuesta.status >= 500;
      const detalle = datos.error?.error_data?.details ?? datos.error?.message ?? `HTTP ${respuesta.status}`;
      if (temporal && intento < maximo) {
        this.op.logger.warn({ estado: respuesta.status, intento }, 'Meta respondió con error temporal; se reintenta');
        await esperar(1000 * 2 ** (intento - 1));
        continue;
      }
      throw new ErrorWhatsApp(detalle, respuesta.status, datos.error?.code, !temporal);
    }
  }

  async enviarPlantilla(e: EnvioPlantilla): Promise<string> {
    const componentes: Record<string, unknown>[] = [
      { type: 'body', parameters: e.variables.map((text) => ({ type: 'text', text })) },
      ...e.payloadsBotones.map((payload, index) => ({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload }],
      })),
    ];
    const wamid = await this.llamar({
      to: e.para,
      type: 'template',
      template: { name: e.plantilla, language: { code: e.idioma }, components: componentes },
    });
    this.op.logger.info({ para: enmascarar(e.para), plantilla: e.plantilla, wamid }, 'Plantilla enviada');
    return wamid;
  }

  async enviarTexto(para: string, texto: string): Promise<string> {
    const wamid = await this.llamar({ to: para, type: 'text', text: { body: texto, preview_url: false } });
    this.op.logger.info({ para: enmascarar(para), wamid }, 'Texto enviado');
    return wamid;
  }
}

/**
 * Verifica que un webhook realmente viene de Meta.
 * Meta firma el cuerpo con HMAC-SHA256 usando el App Secret y lo manda en X-Hub-Signature-256.
 */
export function verificarFirma(cuerpoCrudo: Buffer | undefined, encabezado: string | undefined, appSecret: string): boolean {
  if (!cuerpoCrudo || !encabezado?.startsWith('sha256=')) return false;
  const esperada = createHmac('sha256', appSecret).update(cuerpoCrudo).digest('hex');
  const recibida = encabezado.slice('sha256='.length);
  const a = Buffer.from(esperada, 'hex');
  const b = Buffer.from(recibida, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
