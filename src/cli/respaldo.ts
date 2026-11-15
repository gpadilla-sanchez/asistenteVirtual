/**
 * Respaldo de las bases de cada agente y de los secretos CIFRADOS.
 *   npm run respaldo
 * Guarda en data/respaldos/<fecha>/ y conserva los últimos 14.
 * La clave maestra NO se copia aquí a propósito: guárdala por separado (USB o gestor de contraseñas).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BaseDatos } from '../db/baseDatos.js';
import { ejecutar, rutas } from './comun.js';

await ejecutar(async () => {
  const sello = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const base = join(rutas.datos, 'respaldos');
  const destino = join(base, sello);
  mkdirSync(destino, { recursive: true });

  const dirAgentes = join(rutas.datos, 'agentes');
  const agentes = existsSync(dirAgentes) ? readdirSync(dirAgentes) : [];
  for (const id of agentes) {
    const ruta = join(dirAgentes, id, 'asistente.db');
    if (!existsSync(ruta)) continue;
    const db = new BaseDatos(ruta);
    await db.respaldar(join(destino, 'agentes', `${id}.db`));
    db.cerrar();
  }
  mkdirSync(join(destino, 'secretos'), { recursive: true });
  if (existsSync(rutas.secretos)) {
    for (const f of readdirSync(rutas.secretos).filter((x) => x.endsWith('.secreto'))) copyFileSync(join(rutas.secretos, f), join(destino, 'secretos', f));
  }

  const todos = readdirSync(base).sort();
  for (const viejo of todos.slice(0, Math.max(0, todos.length - 14))) rmSync(join(base, viejo), { recursive: true, force: true });
  console.log(`✔ Respaldo de ${agentes.length} agente(s) en ${destino}`);
});
