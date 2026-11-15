import nodemailer, { type Transporter } from 'nodemailer';
import type { Logger } from './logger.js';

/** Avisos para el agente (cliente reportó pago, pide ayuda, recibo escalado, error del portal...). */
export interface Notificador {
  notificar(asunto: string, texto: string): Promise<void>;
}

/** Sin correo configurado: los avisos quedan en la bitácora y en el panel. */
export class NotificadorLog implements Notificador {
  constructor(private readonly logger: Logger) {}
  async notificar(asunto: string, texto: string): Promise<void> {
    this.logger.info({ asunto, texto }, 'Aviso');
  }
}

export interface OpcionesSmtp {
  host: string;
  puerto: number;
  seguro: boolean;
  usuario?: string;
  contrasena?: string;
  remitente?: string;
}

export function crearTransporte(op: OpcionesSmtp): Transporter {
  return nodemailer.createTransport({
    host: op.host,
    port: op.puerto,
    secure: op.seguro,
    auth: op.usuario ? { user: op.usuario, pass: op.contrasena } : undefined,
  });
}

export class NotificadorCorreo implements Notificador {
  constructor(
    private readonly transporte: Transporter,
    private readonly remitente: string,
    private readonly destinatarios: string[],
    private readonly prefijo: string,
    private readonly logger: Logger,
  ) {}

  async notificar(asunto: string, texto: string): Promise<void> {
    this.logger.info({ asunto }, 'Aviso');
    try {
      await this.transporte.sendMail({
        from: this.remitente,
        to: this.destinatarios.join(', '),
        subject: `[${this.prefijo}] ${asunto}`,
        text: texto,
      });
    } catch (e) {
      this.logger.error({ err: (e as Error).message }, 'No se pudo enviar el correo de aviso');
    }
  }
}
