/**
 * Ejecuta a mano la lectura y/o la revisión.
 *   npm run revision -- <agente|todos> [--sincronizar] [--ya]
 *     --sincronizar  lee la aseguradora antes de revisar
 *     --ya           ignora el horario de envío (pruebas)
 * Si el asistente está corriendo en Docker: docker compose exec asistente node dist/cli/revision.js todos --sincronizar
 */
import { Plataforma } from '../plataforma/plataforma.js';
import { ejecutar, rutas } from './comun.js';

const objetivo = process.argv[2] ?? 'todos';

await ejecutar(async () => {
  const plataforma = Plataforma.crear(rutas);
  try {
    const ids = objetivo === 'todos' ? plataforma.agentes().map((a) => a.id) : [objetivo];
    for (const id of ids) {
      if (process.argv.includes('--sincronizar')) console.log(id, 'lectura:', JSON.stringify(await plataforma.sincronizarAgente(id)));
      console.log(id, 'revisión:', JSON.stringify(await plataforma.revisarAgente(id, { ignorarHorario: process.argv.includes('--ya') }), null, 2));
    }
  } finally {
    plataforma.cerrar();
  }
});
