import type { ContextoAgente } from '../plataforma/contexto.js';

export type AccionPanel = 'marcar_pagado' | 'cancelar' | 'reabrir';

export const ACCIONES: Record<AccionPanel, string> = {
  marcar_pagado: 'Marcado como pagado desde el panel',
  cancelar: 'Cancelado desde el panel (no se enviarán avisos)',
  reabrir: 'Reabierto desde el panel (se reinicia el conteo de avisos)',
};

/** Cambios manuales que hace el agente desde el panel. */
export function aplicarAccion(ctx: ContextoAgente, pagoId: string, accion: AccionPanel, usuario: string): void {
  if (!ctx.db.obtenerPago(pagoId)) throw new Error(`No existe el recibo ${pagoId}`);
  const seg = ctx.db.seguimientoONuevo(pagoId);
  const marca = ctx.reloj.ahora().toISOString();
  if (accion === 'marcar_pagado') ctx.db.guardarSeguimiento({ ...seg, estado: 'pagado', origenEstado: 'panel', proximoEnvio: null });
  if (accion === 'cancelar') ctx.db.guardarSeguimiento({ ...seg, estado: 'cancelado', origenEstado: 'panel', proximoEnvio: null });
  if (accion === 'reabrir') {
    ctx.db.guardarSeguimiento({ ...seg, estado: 'pendiente', origenEstado: 'panel', intentos: 0, proximoEnvio: null, ultimoEnvioDia: null, noReconocidas: 0 });
  }
  ctx.db.registrarEvento(marca, pagoId, accion, `${ACCIONES[accion]} por ${usuario}`);
}
