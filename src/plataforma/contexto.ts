import type { BaseDatos } from '../db/baseDatos.js';
import type { FuenteDatos } from '../fuentes/tipos.js';
import type { Logger } from '../logger.js';
import type { Notificador } from '../notificaciones.js';
import type { ClienteWhatsApp } from '../whatsapp/cliente.js';
import type { ConfigAgente, ConfigSistema } from './configuracion.js';

/** Todo lo que se necesita para atender a UN agente. En las pruebas se arma con piezas falsas. */
export interface ContextoAgente {
  agente: ConfigAgente;
  sistema: ConfigSistema;
  logger: Logger;
  db: BaseDatos;
  fuente: FuenteDatos;
  whatsapp: ClienteWhatsApp;
  notificador: Notificador;
  reloj: { ahora(): Date };
}
