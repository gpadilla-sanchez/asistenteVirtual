import type { Evento, FilaPanel } from '../db/baseDatos.js';
import type { ConfigAgente } from '../plataforma/configuracion.js';
import { fechaHoraEnZona, fechaLegible } from '../utils/fechas.js';
import { formatearMonto } from '../utils/texto.js';

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ETIQUETAS: Record<string, { texto: string; clase: string }> = {
  pendiente: { texto: 'Pendiente', clase: 'pend' },
  reportado: { texto: 'Cliente dice que pagó', clase: 'rep' },
  pagado: { texto: 'Pagado', clase: 'ok' },
  escalado: { texto: 'Requiere atención', clase: 'esc' },
  cancelado: { texto: 'Cancelado', clase: 'can' },
};

const ORIGEN: Record<string, string> = {
  fuente: 'según la aseguradora',
  ausente_en_fuente: 'ya no aparece en la aseguradora',
  panel: 'marcado en el panel',
  cliente: 'respuesta del cliente',
  sistema: '',
};

const ESTILOS = `
  :root { --fondo:#f6f5f2; --papel:#fff; --tinta:#1d1d1b; --suave:#6b6a65; --linea:#e4e2dc;
          --pend:#8a6d1a; --rep:#1f5fa8; --ok:#2f7a43; --esc:#b23b2e; --can:#6b6a65; --acento:#1f4e79; }
  @media (prefers-color-scheme: dark) { :root { --fondo:#171716; --papel:#21211f; --tinta:#ecebe7; --suave:#a3a29c; --linea:#34332f;
          --pend:#e0bb5b; --rep:#7fb2ef; --ok:#79c38e; --esc:#f08a7c; --can:#a3a29c; --acento:#7fb2ef; } }
  * { box-sizing:border-box } body { margin:0; font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; background:var(--fondo); color:var(--tinta) }
  main { max-width:1240px; margin:0 auto; padding:24px 16px 48px }
  a { color:var(--acento) }
  header { display:flex; flex-wrap:wrap; gap:12px; align-items:end; justify-content:space-between; margin-bottom:18px }
  h1 { font-size:22px; margin:0 } h2 { font-size:16px; margin:28px 0 10px } .sub { color:var(--suave); font-size:13px; margin-top:4px }
  .botones { display:flex; gap:8px; flex-wrap:wrap }
  button { font:inherit; font-size:14px; padding:8px 14px; border-radius:8px; border:1px solid var(--tinta); background:var(--tinta); color:var(--fondo); cursor:pointer }
  button.sec { background:transparent; color:var(--tinta); border-color:var(--linea) }
  button.mini { font-size:12px; padding:3px 8px; background:transparent; color:var(--tinta); border-color:var(--linea) }
  .aviso { background:var(--papel); border:1px solid var(--linea); border-left:4px solid var(--rep); padding:10px 14px; border-radius:8px; margin-bottom:16px }
  .aviso.error { border-left-color:var(--esc) }
  .tarjetas { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:8px }
  .tarjeta { background:var(--papel); border:1px solid var(--linea); border-radius:10px; padding:12px 14px }
  .tarjeta span { display:block; color:var(--suave); font-size:13px } .tarjeta strong { font-size:26px }
  .tarjeta.pend strong{color:var(--pend)} .tarjeta.rep strong{color:var(--rep)} .tarjeta.esc strong{color:var(--esc)} .tarjeta.ok strong{color:var(--ok)}
  .caja { overflow-x:auto; background:var(--papel); border:1px solid var(--linea); border-radius:10px }
  table { width:100%; border-collapse:collapse; min-width:900px } th,td { padding:9px 12px; text-align:left; border-bottom:1px solid var(--linea); vertical-align:top }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--suave); font-weight:600 }
  td small { display:block; color:var(--suave); font-size:12px } td small.error { color:var(--esc) }
  .num { text-align:right; font-variant-numeric:tabular-nums }
  .etiqueta { display:inline-block; padding:2px 8px; border-radius:99px; font-size:12px; border:1px solid currentColor; white-space:nowrap }
  .etiqueta.pend{color:var(--pend)} .etiqueta.rep{color:var(--rep)} .etiqueta.ok{color:var(--ok)} .etiqueta.esc{color:var(--esc)} .etiqueta.can{color:var(--can)}
  .acciones form { display:inline } .acciones { white-space:nowrap }
  .reglas { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:8px 24px; background:var(--papel); border:1px solid var(--linea); border-radius:10px; padding:14px 16px; font-size:14px }
  .reglas dt { color:var(--suave); font-size:12px } .reglas dd { margin:0 0 6px }
  .vacio { padding:28px; text-align:center; color:var(--suave) }
  .sim { display:inline-block; background:var(--pend); color:var(--fondo); font-size:11px; font-weight:700; padding:2px 8px; border-radius:99px; letter-spacing:.05em; vertical-align:middle }
`;

function pagina(titulo: string, cuerpo: string, simulacion: boolean): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title><style>${ESTILOS}</style></head><body><main>
${simulacion ? '<p><span class="sim">MODO SIMULACIÓN</span> Los mensajes se envían al simulador, no a WhatsApp real.</p>' : ''}
${cuerpo}</main></body></html>`;
}

const RESPUESTAS: Record<string, string> = { si: 'Sí, ya pagó', no: 'Aún no', sin_respuesta: 'Sin respuesta', otro: 'Escribió otra cosa' };

const fecha = (iso: string | null | undefined, zona: string) => (iso ? fechaHoraEnZona(new Date(iso), zona) : '—');

export interface ResumenAgente {
  agente: ConfigAgente;
  conteo: Record<string, number>;
  ultimaSincronizacion?: string;
  ultimaRevision?: string;
  errorSincronizacion?: string;
}

export function contar(filas: FilaPanel[]): Record<string, number> {
  const c: Record<string, number> = { pendiente: 0, reportado: 0, escalado: 0, pagado: 0, cancelado: 0 };
  for (const f of filas) c[f.estado] = (c[f.estado] ?? 0) + 1;
  return c;
}

function tarjetas(c: Record<string, number>): string {
  return `<div class="tarjetas">${[
    ['Pendientes', c.pendiente, 'pend'],
    ['Cliente dice que pagó', c.reportado, 'rep'],
    ['Requieren atención', c.escalado, 'esc'],
    ['Pagados', c.pagado, 'ok'],
  ].map(([t, n, k]) => `<div class="tarjeta ${k}"><span>${t}</span><strong>${n ?? 0}</strong></div>`).join('')}</div>`;
}

export function renderizarResumen(resumenes: ResumenAgente[], zona: string, simulacion: boolean, aviso?: string): string {
  const total = contar([]);
  for (const r of resumenes) for (const k of Object.keys(total)) total[k]! += r.conteo[k] ?? 0;
  const filas = resumenes.map((r) => `<tr>
      <td><a href="/panel/agentes/${esc(r.agente.id)}"><strong>${esc(r.agente.nombre)}</strong></a><small>${esc(r.agente.id)}${r.agente.activo ? '' : ' · inactivo'}</small></td>
      <td class="num">${r.conteo.pendiente ?? 0}</td><td class="num">${r.conteo.reportado ?? 0}</td>
      <td class="num">${r.conteo.escalado ?? 0}</td><td class="num">${r.conteo.pagado ?? 0}</td>
      <td>${fecha(r.ultimaSincronizacion, zona)}${r.errorSincronizacion ? `<small class="error">${esc(r.errorSincronizacion)}</small>` : ''}</td>
      <td>${fecha(r.ultimaRevision, zona)}</td>
    </tr>`).join('');
  return pagina('Panel · Agentes', `
    <header><div><h1>Agentes</h1><div class="sub">${resumenes.length} agente(s) configurados</div></div></header>
    ${aviso ? `<div class="aviso">${esc(aviso)}</div>` : ''}
    ${tarjetas(total)}
    <h2>Por agente</h2>
    <div class="caja"><table><thead><tr><th>Agente</th><th class="num">Pendientes</th><th class="num">Dicen que pagaron</th>
      <th class="num">Atención</th><th class="num">Pagados</th><th>Última lectura de la aseguradora</th><th>Última revisión</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="7" class="vacio">No hay agentes. Crea uno con: npm run agente -- nuevo</td></tr>'}</tbody></table></div>`, simulacion);
}

function describirReglas(a: ConfigAgente): string {
  const e = a.envios;
  const dias = e.dias_semana.join(', ');
  const items: [string, string][] = [
    ['Lectura de la aseguradora', `cron "${a.fuente.sincronizar}" · fuente: ${a.fuente.tipo} (${a.fuente.perfil})`],
    ['Revisión diaria', `${e.hora_revision} · días: ${dias} · horario ${e.horario.inicio}–${e.horario.fin}`],
    ['Primer aviso', `${e.primer_aviso_dias_antes} día(s) antes del vencimiento`],
    ['Si dice "No" o no contesta', `cada ${e.repetir_cada_dias} día(s) antes de vencer · cada ${e.repetir_cada_dias_vencido} día(s) ya vencido`],
    ['Tope', `${e.max_avisos} avisos o ${e.dejar_de_avisar_dias_despues} días de vencido → requiere atención`],
    ['Si dice "Sí"', `se detienen los avisos; ${e.reabrir_reportado_tras_dias > 0 ? `se reanudan si en ${e.reabrir_reportado_tras_dias} días la aseguradora no lo aplica` : 'no se reanudan solos'}`],
  ];
  return `<dl class="reglas">${items.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('')}</dl>`;
}

export function renderizarAgente(op: {
  agente: ConfigAgente;
  filas: FilaPanel[];
  eventos: Evento[];
  zona: string;
  simulacion: boolean;
  esAdmin: boolean;
  csrf: string;
  ultimaSincronizacion?: string;
  ultimaRevision?: string;
  errorSincronizacion?: string;
  aviso?: string;
}): string {
  const { agente, filas, zona, csrf } = op;
  const base = `/panel/agentes/${esc(agente.id)}`;
  const boton = (pagoId: string, accion: string, texto: string) =>
    `<form method="post" action="${base}/recibos/${encodeURIComponent(pagoId)}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="accion" value="${accion}"><button class="mini" type="submit">${texto}</button></form>`;
  const renglones = filas.map((f) => {
    const e = ETIQUETAS[f.estado] ?? ETIQUETAS.pendiente!;
    const origen = ORIGEN[f.origenEstado] ?? '';
    const acciones = f.estado === 'pendiente' || f.estado === 'reportado' || f.estado === 'escalado'
      ? `${boton(f.id, 'marcar_pagado', 'Pagado')} ${boton(f.id, 'cancelar', 'Cancelar')}${f.estado !== 'pendiente' ? ` ${boton(f.id, 'reabrir', 'Reabrir')}` : ''}`
      : boton(f.id, 'reabrir', 'Reabrir');
    return `<tr>
      <td><strong>${esc(f.cliente)}</strong><small>${esc(f.telefono ?? 'sin teléfono válido')}</small></td>
      <td>${esc(f.producto)}<small>Póliza ${esc(f.poliza || '—')} · recibo ${esc(f.id)}</small></td>
      <td class="num">${f.monto != null ? esc(formatearMonto(f.monto)) : '—'}</td>
      <td>${f.fechaVencimiento ? esc(fechaLegible(f.fechaVencimiento)) : '—'}</td>
      <td><span class="etiqueta ${e.clase}">${e.texto}</span>${origen ? `<small>${esc(origen)}</small>` : ''}</td>
      <td class="num">${f.intentos}</td>
      <td>${fecha(f.ultimoEnvio, zona)}${f.proximoEnvio && f.estado === 'pendiente' ? `<small>próximo: ${esc(fechaLegible(f.proximoEnvio))}</small>` : ''}</td>
      <td>${esc(f.ultimaRespuesta ? (RESPUESTAS[f.ultimaRespuesta] ?? f.ultimaRespuesta) : '—')}${f.ultimoError ? `<small class="error">${esc(f.ultimoError)}</small>` : ''}</td>
      <td class="acciones">${acciones}</td>
    </tr>`;
  }).join('');
  const eventos = op.eventos.map((ev) => `<tr><td>${fecha(ev.fecha, zona)}</td><td>${esc(ev.pagoId ?? '')}</td><td>${esc(ev.tipo)}</td><td>${esc(ev.detalle)}</td></tr>`).join('');

  return pagina(`Panel · ${agente.nombre}`, `
    <header>
      <div>${op.esAdmin ? '<a href="/panel">← Todos los agentes</a>' : ''}<h1>${esc(agente.nombre)}</h1>
        <div class="sub">Última lectura de la aseguradora: ${fecha(op.ultimaSincronizacion, zona)} · Última revisión: ${fecha(op.ultimaRevision, zona)}</div></div>
      <div class="botones">
        <form method="post" action="${base}/sincronizar"><input type="hidden" name="csrf" value="${csrf}"><button class="sec" type="submit">Leer aseguradora ahora</button></form>
        <form method="post" action="${base}/revisar"><input type="hidden" name="csrf" value="${csrf}"><button type="submit">Enviar recordatorios ahora</button></form>
      </div>
    </header>
    ${op.aviso ? `<div class="aviso">${esc(op.aviso)}</div>` : ''}
    ${op.errorSincronizacion ? `<div class="aviso error">Último error al leer la aseguradora: ${esc(op.errorSincronizacion)}</div>` : ''}
    ${tarjetas(contar(filas))}
    <h2>Recibos</h2>
    <div class="caja">${filas.length === 0
      ? '<div class="vacio">Aún no hay recibos. Usa “Leer aseguradora ahora”.</div>'
      : `<table><thead><tr><th>Cliente</th><th>Póliza</th><th class="num">Prima</th><th>Vence</th><th>Estado</th><th class="num">Avisos</th>
         <th>Último aviso</th><th>Respuesta</th><th></th></tr></thead><tbody>${renglones}</tbody></table>`}</div>
    <h2>Cuándo y cada cuándo se envían mensajes</h2>
    ${describirReglas(agente)}
    <div class="sub">Se cambia en config/agentes/${esc(agente.id)}.yaml (y se reinicia el asistente).</div>
    <h2>Actividad reciente</h2>
    <div class="caja">${eventos ? `<table><thead><tr><th>Fecha</th><th>Recibo</th><th>Tipo</th><th>Detalle</th></tr></thead><tbody>${eventos}</tbody></table>` : '<div class="vacio">Sin actividad todavía.</div>'}</div>
  `, op.simulacion);
}
