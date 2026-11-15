import express from 'express';
import cookieParser from 'cookie-parser';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { esc } from '../servidor/panel.js';
import { formatoPortalFecha, formatoPortalPrima, generarCartera, type ReciboSimulado } from './datos.js';

/**
 * Portal de agentes de una aseguradora FICTICIA, para practicar la lectura automática
 * sin tocar el sitio real. Tiene inicio de sesión, menú, tabla paginada y exportación CSV,
 * que es lo típico en los portales de agentes.
 */

export interface UsuarioPortal {
  usuario: string;
  contrasena: string;
}

export class EstadoPortal {
  readonly carteras = new Map<string, ReciboSimulado[]>();

  constructor(
    readonly usuarios: UsuarioPortal[],
    hoy: string,
  ) {
    usuarios.forEach((u, i) => this.carteras.set(u.usuario, generarCartera(u.usuario, i + 1, hoy)));
  }

  /** Simula que el cliente pagó en la aseguradora. */
  registrarPago(recibo: string): boolean {
    for (const cartera of this.carteras.values()) {
      const r = cartera.find((x) => x.recibo === recibo);
      if (r) {
        r.estado = 'Pagado';
        return true;
      }
    }
    return false;
  }

  recibosDeTelefono(digitos10: string): (ReciboSimulado & { usuario: string })[] {
    const r: (ReciboSimulado & { usuario: string })[] = [];
    for (const [usuario, cartera] of this.carteras) {
      for (const x of cartera) if (x.telefono.replace(/\D/g, '') === digitos10) r.push({ ...x, usuario });
    }
    return r;
  }
}

const ESTILO = `
  body{margin:0;font:15px/1.4 Georgia,'Times New Roman',serif;background:#eef1f4;color:#1a2633}
  .franja{background:#7a1f1f;color:#fff;font:600 12px/1 system-ui,sans-serif;padding:8px 16px;letter-spacing:.04em}
  header{background:#1a2633;color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
  header b{font-size:18px} main{max-width:1000px;margin:24px auto;padding:0 16px}
  .caja{background:#fff;border:1px solid #c9d2dc;padding:20px;border-radius:4px}
  label{display:block;margin:12px 0 4px;font-size:14px} input{font:inherit;padding:8px;width:100%;max-width:320px;border:1px solid #9aa7b4}
  button,.btn{font:inherit;margin-top:16px;padding:8px 18px;background:#1a2633;color:#fff;border:0;cursor:pointer;text-decoration:none;display:inline-block}
  .error-login{background:#fde8e8;border:1px solid #c33;color:#900;padding:10px;margin-bottom:12px}
  nav a{color:#fff;margin-left:16px} table{border-collapse:collapse;width:100%;font-size:14px;background:#fff}
  th,td{border:1px solid #c9d2dc;padding:6px 8px;text-align:left} th{background:#dde4ec}
  .paginas{margin-top:12px;display:flex;gap:12px;align-items:center}
`;

function pagina(titulo: string, cuerpo: string, usuario?: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(titulo)}</title><style>${ESTILO}</style></head><body>
<div class="franja">SIMULADOR · Portal de una aseguradora ficticia para pruebas. No es un sitio real.</div>
<header><b>Aseguradora Demo · Portal de Agentes</b>${usuario ? `<nav id="menu-principal"><span>${esc(usuario)}</span><a id="menu-inicio" href="/inicio">Inicio</a><a id="menu-cobranza" href="/cobranza">Cobranza</a><a href="/salir">Salir</a></nav>` : ''}</header>
<main>${cuerpo}</main></body></html>`;
}

const POR_PAGINA = 5;

function igual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function crearAppPortal(estado: EstadoPortal) {
  const app = express();
  const sesiones = new Map<string, string>();
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false }));

  const usuarioDe = (req: express.Request) => sesiones.get(String(req.cookies?.sesion ?? ''));
  const requerirSesion = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!usuarioDe(req)) {
      res.redirect('/login');
      return;
    }
    next();
  };

  const formLogin = (error?: string) => pagina('Iniciar sesión', `<div class="caja" style="max-width:420px">
      <h2>Iniciar sesión</h2>${error ? `<div class="error-login">${esc(error)}</div>` : ''}
      <form id="login" method="post" action="/login">
        <label for="usuario">Usuario o clave de agente</label><input id="usuario" name="usuario" autocomplete="username">
        <label for="contrasena">Contraseña</label><input id="contrasena" name="contrasena" type="password" autocomplete="current-password">
        <button id="entrar" type="submit">Entrar</button>
      </form></div>`);

  app.get('/', (_req, res) => res.redirect('/login'));
  app.get('/login', (_req, res) => res.type('html').send(formLogin()));
  app.post('/login', (req, res) => {
    const usuario = String(req.body?.usuario ?? '');
    const contrasena = String(req.body?.contrasena ?? '');
    const cuenta = estado.usuarios.find((u) => igual(u.usuario, usuario) && igual(u.contrasena, contrasena));
    if (!cuenta) {
      res.status(401).type('html').send(formLogin('Usuario o contraseña incorrectos'));
      return;
    }
    const token = randomBytes(24).toString('hex');
    sesiones.set(token, cuenta.usuario);
    res.cookie('sesion', token, { httpOnly: true, sameSite: 'lax' }).redirect('/inicio');
  });
  app.get('/salir', (req, res) => {
    sesiones.delete(String(req.cookies?.sesion ?? ''));
    res.clearCookie('sesion').redirect('/login');
  });

  app.get('/inicio', requerirSesion, (req, res) => {
    const u = usuarioDe(req)!;
    res.type('html').send(pagina('Inicio', `<div class="caja"><h2>Bienvenido</h2><p>Consulta tus recibos por cobrar en el menú <b>Cobranza</b>.</p></div>`, u));
  });

  app.get('/cobranza', requerirSesion, (req, res) => {
    const u = usuarioDe(req)!;
    const cartera = estado.carteras.get(u) ?? [];
    const total = Math.max(1, Math.ceil(cartera.length / POR_PAGINA));
    const n = Math.min(total, Math.max(1, Number(req.query.pagina) || 1));
    const filas = cartera.slice((n - 1) * POR_PAGINA, n * POR_PAGINA).map((r) => `<tr>
        <td>${esc(r.poliza)}</td><td>${esc(r.recibo)}</td><td>${esc(r.contratante)}</td><td>${esc(r.telefono)}</td>
        <td>${esc(r.producto)}</td><td>${esc(formatoPortalPrima(r.prima))}</td><td>${esc(formatoPortalFecha(r.fechaLimite))}</td><td>${esc(r.estado)}</td></tr>`).join('');
    res.type('html').send(pagina('Cobranza', `<div class="caja"><h2>Recibos por cobrar</h2>
      <p><a id="exportar" class="btn" href="/cobranza/exportar.csv">Exportar a CSV</a></p>
      <table id="recibos"><thead><tr><th>Póliza</th><th>Recibo</th><th>Contratante</th><th>Teléfono</th><th>Producto</th><th>Prima</th><th>Fecha límite</th><th>Estado</th></tr></thead>
      <tbody>${filas}</tbody></table>
      <div class="paginas">${n > 1 ? `<a id="anterior" href="/cobranza?pagina=${n - 1}">« Anterior</a>` : ''}<span>Página ${n} de ${total}</span>
      ${n < total ? `<a id="siguiente" href="/cobranza?pagina=${n + 1}">Siguiente »</a>` : ''}</div></div>`, u));
  });

  app.get('/cobranza/exportar.csv', requerirSesion, (req, res) => {
    const cartera = estado.carteras.get(usuarioDe(req)!) ?? [];
    const comillas = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lineas = [
      ['Póliza', 'Recibo', 'Contratante', 'Teléfono', 'Producto', 'Prima', 'Fecha límite', 'Estado'].join(','),
      ...cartera.map((r) => [r.poliza, r.recibo, r.contratante, r.telefono, r.producto, formatoPortalPrima(r.prima), formatoPortalFecha(r.fechaLimite), r.estado].map(comillas).join(',')),
    ];
    res.attachment('recibos.csv').type('text/csv; charset=utf-8').send(`﻿${lineas.join('\r\n')}\r\n`);
  });

  return app;
}
