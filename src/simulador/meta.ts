import express from 'express';
import { createHmac } from 'node:crypto';
import { esc } from '../servidor/panel.js';
import { fechaEnZona, fechaLegible, sumarDias } from '../utils/fechas.js';
import { contarVariables, definicionesPlantillas, renderizarPlantilla } from '../whatsapp/plantillas.js';
import { formatoPortalPrima } from './datos.js';
import type { EstadoPortal } from './portal.js';

/**
 * Simulador de WhatsApp:
 *  1. Imita la Cloud API de Meta (POST /{version}/{phone_number_id}/messages y message_templates):
 *     valida el token, la plantilla y el número de variables como lo hace Meta.
 *  2. Envía al asistente los webhooks firmados (estados de entrega y respuestas).
 *  3. Ofrece un "teléfono" web para ver los mensajes de cada cliente y responder con los botones.
 *  4. Tiene los controles de la simulación: adelantar días, leer la aseguradora, enviar recordatorios.
 */

export interface OpcionesMeta {
  tokens: string[];
  appSecret: string;
  asistenteUrl: string;
  tokenSimulacion: string;
  plantillas: { recordatorio: string; seguimiento: string; idioma: string };
  zona: string;
  portal: EstadoPortal;
  /** Para pruebas: entregar los webhooks sin esperar. */
  sinRetraso?: boolean;
}

interface MensajeSim {
  wamid: string;
  phoneNumberId: string;
  tel: string;
  direccion: 'saliente' | 'entrante';
  texto: string;
  pie?: string;
  botones?: string[];
  payloads?: string[];
  estado: string;
  fecha: string;
  respondido?: boolean;
}

export class EstadoMeta {
  mensajes: MensajeSim[] = [];
  desfaseDias = 0;
  version = 0;
  ultimoAviso = '';
  private contador = 0;

  nuevoId(prefijo: string): string {
    this.contador++;
    return `wamid.SIM-${prefijo}-${Date.now().toString(36)}-${this.contador}`;
  }
}

export function crearAppMeta(op: OpcionesMeta, estado = new EstadoMeta()) {
  const app = express();
  const plantillas = definicionesPlantillas(op.plantillas.recordatorio, op.plantillas.seguimiento, op.plantillas.idioma);
  const cambio = () => estado.version++;

  // ---------------- Envío de webhooks firmados al asistente ----------------

  async function enviarWebhook(phoneNumberId: string, valor: Record<string, unknown>): Promise<void> {
    const cuerpo = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA-SIM', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phoneNumberId, display_phone_number: '5255SIMULADO' }, ...valor } }] }],
    });
    const firma = `sha256=${createHmac('sha256', op.appSecret).update(cuerpo).digest('hex')}`;
    try {
      await fetch(`${op.asistenteUrl}/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': firma }, body: cuerpo });
    } catch (e) {
      estado.ultimoAviso = `No se pudo entregar el webhook al asistente (${op.asistenteUrl}): ${(e as Error).message}`;
    }
  }

  const despues = (ms: number, fn: () => Promise<void>) => (op.sinRetraso ? fn() : void setTimeout(() => void fn(), ms));

  function programarEstados(m: MensajeSim) {
    const falla = m.tel.endsWith('9999');
    const pasos: [number, string][] = falla ? [[300, 'failed']] : [[200, 'sent'], [600, 'delivered']];
    for (const [ms, status] of pasos) {
      void despues(ms, async () => {
        m.estado = status;
        cambio();
        await enviarWebhook(m.phoneNumberId, {
          statuses: [{
            id: m.wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: m.tel,
            ...(status === 'failed' ? { errors: [{ code: 131026, title: 'Message undeliverable', error_data: { details: 'El número no tiene WhatsApp (simulado)' } }] } : {}),
          }],
        });
      });
    }
  }

  // ---------------- Imitación de la Cloud API ----------------

  const errorMeta = (res: express.Response, http: number, code: number, message: string) =>
    res.status(http).json({ error: { message, type: 'OAuthException', code, error_data: { details: message } } });

  app.post('/:version/:id/messages', express.json(), (req, res) => {
    const token = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!op.tokens.includes(token)) return errorMeta(res, 401, 190, 'Invalid OAuth access token');
    const b = req.body as { to?: string; type?: string; text?: { body?: string }; template?: { name?: string; language?: { code?: string }; components?: { type: string; parameters?: { text?: string; payload?: string }[] }[] } };
    const tel = String(b.to ?? '').replace(/\D/g, '');
    if (!tel) return errorMeta(res, 400, 100, 'Invalid parameter: to');
    const m: MensajeSim = { wamid: estado.nuevoId('OUT'), phoneNumberId: String(req.params.id), tel, direccion: 'saliente', texto: '', estado: 'accepted', fecha: new Date().toISOString() };

    if (b.type === 'template') {
      const def = plantillas.find((p) => p.name === b.template?.name && p.language === b.template?.language?.code);
      if (!def) return errorMeta(res, 404, 132001, `Template name does not exist in the translation (${b.template?.name})`);
      const variables = (b.template?.components?.find((c) => c.type === 'body')?.parameters ?? []).map((p) => p.text ?? '');
      if (variables.length !== contarVariables(def)) return errorMeta(res, 400, 132000, `Number of parameters does not match the expected number of params (${variables.length} vs ${contarVariables(def)})`);
      const r = renderizarPlantilla(def, variables);
      m.texto = r.cuerpo;
      m.pie = r.pie;
      m.botones = r.botones;
      m.payloads = (b.template?.components ?? []).filter((c) => c.type === 'button').map((c) => c.parameters?.[0]?.payload ?? '');
    } else if (b.type === 'text') {
      m.texto = b.text?.body ?? '';
    } else {
      return errorMeta(res, 400, 100, `Tipo no soportado por el simulador: ${b.type}`);
    }
    estado.mensajes.push(m);
    cambio();
    programarEstados(m);
    res.json({ messaging_product: 'whatsapp', contacts: [{ input: b.to, wa_id: tel }], messages: [{ id: m.wamid }] });
  });

  app.post('/:version/:waba/message_templates', express.json(), (req, res) => {
    const token = (req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!op.tokens.includes(token)) return errorMeta(res, 401, 190, 'Invalid OAuth access token');
    res.json({ id: `TPL-${Date.now()}`, status: 'APPROVED', category: 'UTILITY' });
  });

  // ---------------- Cliente simulado: responder ----------------

  /** WhatsApp reporta los celulares de México con 521. */
  const comoWaId = (tel: string) => (tel.startsWith('52') && tel.length === 12 ? `521${tel.slice(2)}` : tel);

  async function mensajeEntrante(tel: string, contenido: Record<string, unknown>, texto: string, contexto?: MensajeSim) {
    const ultimo = contexto ?? [...estado.mensajes].reverse().find((x) => x.tel === tel && x.direccion === 'saliente');
    const phoneNumberId = ultimo?.phoneNumberId ?? 'desconocido';
    const m: MensajeSim = { wamid: estado.nuevoId('IN'), phoneNumberId, tel, direccion: 'entrante', texto, estado: 'recibido', fecha: new Date().toISOString() };
    estado.mensajes.push(m);
    cambio();
    await enviarWebhook(phoneNumberId, {
      contacts: [{ wa_id: comoWaId(tel), profile: { name: 'Cliente simulado' } }],
      messages: [{ from: comoWaId(tel), id: m.wamid, timestamp: String(Math.floor(Date.now() / 1000)), ...(contexto ? { context: { from: '5255SIMULADO', id: contexto.wamid } } : {}), ...contenido }],
    });
  }

  const formulario = express.urlencoded({ extended: false });
  const volver = (res: express.Response, tel?: string) => res.redirect(303, tel ? `/?tel=${encodeURIComponent(tel)}` : '/');

  app.post('/ui/boton', formulario, async (req, res) => {
    const original = estado.mensajes.find((x) => x.wamid === req.body.wamid);
    const i = Number(req.body.indice);
    if (original?.botones && original.payloads) {
      original.respondido = true;
      await mensajeEntrante(original.tel, { type: 'button', button: { payload: original.payloads[i], text: original.botones[i] } }, `[Botón] ${original.botones[i]}`, original);
    }
    volver(res, original?.tel);
  });

  app.post('/ui/texto', formulario, async (req, res) => {
    const tel = String(req.body.tel ?? '');
    const texto = String(req.body.texto ?? '').trim();
    if (tel && texto) await mensajeEntrante(tel, { type: 'text', text: { body: texto } }, texto);
    volver(res, tel);
  });

  app.post('/ui/comprobante', formulario, async (req, res) => {
    const tel = String(req.body.tel ?? '');
    if (tel) await mensajeEntrante(tel, { type: 'image', image: { id: 'MEDIA-SIM', mime_type: 'image/jpeg' } }, '[Imagen] comprobante.jpg');
    volver(res, tel);
  });

  app.post('/ui/pagar', formulario, (req, res) => {
    estado.ultimoAviso = op.portal.registrarPago(String(req.body.recibo)) ? `Recibo ${req.body.recibo} marcado como Pagado en la aseguradora simulada. Usa “Leer aseguradora” para que el asistente se entere.` : 'Recibo no encontrado';
    cambio();
    volver(res, String(req.body.tel ?? ''));
  });

  // ---------------- Controles de la simulación ----------------

  async function llamarAsistente(ruta: string, cuerpo?: unknown): Promise<unknown> {
    const r = await fetch(`${op.asistenteUrl}${ruta}`, {
      method: cuerpo === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Simulacion-Token': op.tokenSimulacion },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    });
    if (!r.ok) throw new Error(`El asistente respondió ${r.status} en ${ruta}`);
    return r.json();
  }

  const resumir = (r: Record<string, Record<string, unknown>>) =>
    Object.entries(r).map(([id, x]) => `${id}: ${'error' in x ? `error (${x.error})` : Object.entries(x).filter(([, v]) => typeof v === 'number' || typeof v === 'string').map(([k, v]) => `${k} ${v}`).join(', ')}`).join(' · ');

  app.post('/ui/control', formulario, async (req, res) => {
    try {
      const accion = String(req.body.accion);
      if (accion === 'avanzar') estado.desfaseDias++;
      if (accion === 'hoy') estado.desfaseDias = 0;
      await llamarAsistente('/simulacion/reloj', { desfaseDias: estado.desfaseDias });
      if (accion === 'sincronizar') estado.ultimoAviso = `Lectura de la aseguradora → ${resumir((await llamarAsistente('/simulacion/sincronizar', {})) as never)}`;
      else if (accion === 'revisar') estado.ultimoAviso = `Revisión → ${resumir((await llamarAsistente('/simulacion/revisar', {})) as never)}`;
      else if (accion === 'dia-completo') {
        await llamarAsistente('/simulacion/sincronizar', {});
        estado.ultimoAviso = `Día simulado completo (lectura + revisión) → ${resumir((await llamarAsistente('/simulacion/revisar', {})) as never)}`;
      } else estado.ultimoAviso = `Fecha simulada: ${fechaLegible(fechaSimulada())}`;
    } catch (e) {
      estado.ultimoAviso = `Error: ${(e as Error).message}. ¿Está encendido el asistente en ${op.asistenteUrl} y en modo simulación?`;
    }
    cambio();
    volver(res, String(req.body.tel ?? '') || undefined);
  });

  const fechaSimulada = () => sumarDias(fechaEnZona(new Date(), op.zona), estado.desfaseDias);

  app.get('/ui/version', (_req, res) => res.json({ version: estado.version }));

  app.get('/ui/mensajes.json', (_req, res) => res.json(estado.mensajes));

  // ---------------- Página del teléfono simulado ----------------

  app.get('/', (req, res) => {
    const telSel = typeof req.query.tel === 'string' ? req.query.tel : undefined;
    const contactos = new Map<string, { ultimo: MensajeSim; sinLeer: number }>();
    for (const m of estado.mensajes) {
      const c = contactos.get(m.tel) ?? { ultimo: m, sinLeer: 0 };
      c.ultimo = m;
      if (m.direccion === 'saliente' && m.botones && !m.respondido) c.sinLeer++;
      contactos.set(m.tel, c);
    }
    const listaContactos = [...contactos.entries()].sort((a, b) => b[1].ultimo.fecha.localeCompare(a[1].ultimo.fecha)).map(([tel, c]) => {
      const nombre = op.portal.recibosDeTelefono(tel.slice(-10))[0]?.contratante ?? tel;
      return `<a class="contacto${tel === telSel ? ' activo' : ''}" href="/?tel=${tel}"><b>${esc(nombre)}</b>${c.sinLeer ? `<span class="burbuja">${c.sinLeer}</span>` : ''}<small>${esc(c.ultimo.texto.slice(0, 60))}</small></a>`;
    }).join('') || '<p class="tenue">Aún no hay mensajes. Usa “Simular día completo”.</p>';

    let conversacion = '<div class="vacio">Elige un contacto para ver su conversación.</div>';
    if (telSel) {
      const mensajes = estado.mensajes.filter((m) => m.tel === telSel);
      const burbujas = mensajes.map((m) => `<div class="msg ${m.direccion}">
          <div class="texto">${esc(m.texto).replace(/\*(.+?)\*/g, '<b>$1</b>').replace(/\n/g, '<br>')}</div>
          ${m.pie ? `<div class="pie">${esc(m.pie)}</div>` : ''}
          ${m.botones ? `<div class="botones">${m.botones.map((b, i) => `<form method="post" action="/ui/boton"><input type="hidden" name="wamid" value="${esc(m.wamid)}"><input type="hidden" name="indice" value="${i}"><button ${m.respondido ? 'disabled' : ''}>${esc(b)}</button></form>`).join('')}</div>` : ''}
          <div class="meta">${new Date(m.fecha).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} ${m.direccion === 'saliente' ? `· ${esc(m.estado)}` : ''}</div>
        </div>`).join('');
      const recibos = op.portal.recibosDeTelefono(telSel.slice(-10)).map((r) => `<tr><td>${esc(r.recibo)}<small>${esc(r.producto)} · ${esc(r.poliza)}</small></td><td>${esc(formatoPortalPrima(r.prima))}</td><td>${esc(fechaLegible(r.fechaLimite))}</td><td>${esc(r.estado)}</td>
          <td>${r.estado === 'Pendiente' ? `<form method="post" action="/ui/pagar"><input type="hidden" name="tel" value="${esc(telSel)}"><input type="hidden" name="recibo" value="${esc(r.recibo)}"><button class="mini">Registrar pago</button></form>` : ''}</td></tr>`).join('');
      conversacion = `<div class="chat">${burbujas}</div>
        <form class="escribir" method="post" action="/ui/texto"><input type="hidden" name="tel" value="${esc(telSel)}">
          <input name="texto" placeholder="Escribe como el cliente (p. ej. “ya pagué”, “mañana”, “BAJA”, “ayuda”)" autocomplete="off"><button>Enviar</button></form>
        <form method="post" action="/ui/comprobante"><input type="hidden" name="tel" value="${esc(telSel)}"><button class="mini">📎 Enviar foto de comprobante</button></form>
        <h3>Recibos de este cliente en la aseguradora simulada</h3>
        <table><thead><tr><th>Recibo</th><th>Prima</th><th>Fecha límite</th><th>Estado</th><th></th></tr></thead><tbody>${recibos}</tbody></table>`;
    }

    res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Simulador de WhatsApp</title>
<style>
  :root{--fondo:#efeae2;--papel:#fff;--tinta:#111b21;--suave:#667781;--verde:#d9fdd3;--acento:#00a884;--linea:#d1d7db}
  *{box-sizing:border-box} body{margin:0;font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;background:#d1d7db;color:var(--tinta)}
  .app{display:grid;grid-template-columns:340px 1fr;max-width:1200px;margin:0 auto;min-height:100vh;background:var(--papel)}
  aside{border-right:1px solid var(--linea);display:flex;flex-direction:column} .barra{background:#f0f2f5;padding:14px 16px;border-bottom:1px solid var(--linea)}
  .barra h1{font-size:17px;margin:0 0 4px} .tenue{color:var(--suave);font-size:13px;padding:0 16px}
  .controles{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:12px 16px;border-bottom:1px solid var(--linea)}
  .controles button{width:100%} .controles .ancho{grid-column:1/-1}
  button{font:inherit;font-size:13px;padding:7px 10px;border-radius:8px;border:1px solid var(--linea);background:#fff;cursor:pointer}
  button.principal{background:var(--acento);color:#fff;border-color:var(--acento)} button:disabled{opacity:.45;cursor:default}
  .contacto{display:block;padding:10px 16px;border-bottom:1px solid #f0f2f5;color:inherit;text-decoration:none}
  .contacto.activo{background:#f0f2f5} .contacto small{display:block;color:var(--suave);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .burbuja{float:right;background:var(--acento);color:#fff;border-radius:99px;font-size:12px;padding:0 7px}
  section{background:var(--fondo);display:flex;flex-direction:column;padding:16px;gap:10px;overflow:auto}
  .aviso{background:#fff7d6;border:1px solid #e6d58c;padding:8px 12px;border-radius:8px;font-size:13px}
  .chat{display:flex;flex-direction:column;gap:8px} .msg{max-width:72%;padding:8px 10px;border-radius:8px;box-shadow:0 1px .5px rgba(0,0,0,.13)}
  .msg.saliente{background:var(--papel);align-self:flex-start} .msg.entrante{background:var(--verde);align-self:flex-end}
  .pie{color:var(--suave);font-size:12px;margin-top:6px} .meta{color:var(--suave);font-size:11px;text-align:right;margin-top:4px}
  .botones{display:flex;flex-direction:column;gap:4px;margin-top:8px} .botones button{width:100%;color:#027eb5;font-weight:600}
  .escribir{display:flex;gap:8px} .escribir input{flex:1;font:inherit;padding:9px 12px;border-radius:8px;border:1px solid var(--linea)}
  table{width:100%;border-collapse:collapse;background:var(--papel);border-radius:8px;font-size:13px} th,td{padding:6px 8px;border-bottom:1px solid var(--linea);text-align:left} td small{display:block;color:var(--suave)}
  h3{font-size:14px;margin:8px 0 0} .vacio{color:var(--suave);text-align:center;margin-top:30vh} .mini{font-size:12px;padding:4px 8px}
  @media (max-width:760px){.app{grid-template-columns:1fr}}
</style></head><body><div class="app">
<aside>
  <div class="barra"><h1>Simulador de WhatsApp</h1><div class="tenue" style="padding:0">Fecha simulada: <b>${esc(fechaLegible(fechaSimulada()))}</b>${estado.desfaseDias ? ` (+${estado.desfaseDias} días)` : ' (hoy)'}</div></div>
  <form class="controles" method="post" action="/ui/control"><input type="hidden" name="tel" value="${esc(telSel ?? '')}">
    <button class="principal ancho" name="accion" value="dia-completo">▶ Simular día completo</button>
    <button name="accion" value="sincronizar">Leer aseguradora</button>
    <button name="accion" value="revisar">Enviar recordatorios</button>
    <button name="accion" value="avanzar">Avanzar 1 día ⏭</button>
    <button name="accion" value="hoy">Volver a hoy</button>
  </form>
  <div style="overflow:auto;flex:1">${listaContactos}</div>
  <p class="tenue">Portal de la aseguradora simulada: puerto 4100 · Panel del asistente: puerto 3000/panel</p>
</aside>
<section>${estado.ultimoAviso ? `<div class="aviso">${esc(estado.ultimoAviso)}</div>` : ''}${conversacion}</section>
</div>
<script>
  let v=${estado.version};
  setInterval(async()=>{ if(document.activeElement&&document.activeElement.tagName==='INPUT')return;
    try{const r=await fetch('/ui/version');const j=await r.json();if(j.version!==v)location.reload();}catch(e){} },1500);
</script></body></html>`);
  });

  return { app, estado };
}
