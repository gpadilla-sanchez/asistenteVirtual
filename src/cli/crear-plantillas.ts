/**
 * Envía a Meta las plantillas para su aprobación (una vez; las comparten todos los agentes).
 *   npm run crear-plantillas
 * Requiere meta.waba_id en config/sistema.yaml y el token compartido en la bóveda.
 */
import { definicionesPlantillas } from '../whatsapp/plantillas.js';
import { abrirBoveda, configuracion, ejecutar } from './comun.js';

await ejecutar(async () => {
  const { sistema } = configuracion();
  if (!sistema.meta.waba_id) throw new Error('Falta meta.waba_id en config/sistema.yaml');
  const token = abrirBoveda().requerir('sistema', 'meta.token');
  const p = sistema.meta.plantillas;
  const url = `${sistema.meta.graph_url}/${sistema.meta.version_api}/${sistema.meta.waba_id}/message_templates`;
  for (const plantilla of definicionesPlantillas(p.recordatorio, p.seguimiento, p.idioma)) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(plantilla),
    });
    const d = (await res.json()) as { id?: string; status?: string; category?: string; error?: { message?: string; error_user_msg?: string } };
    if (!res.ok) {
      console.error(`✘ ${plantilla.name}: ${d.error?.error_user_msg ?? d.error?.message ?? res.status}`);
      continue;
    }
    console.log(`✔ ${plantilla.name}: enviada (id ${d.id}, estado ${d.status}, categoría ${d.category})`);
    if (d.category && d.category !== 'UTILITY') console.warn('  ⚠ Meta no la clasificó como UTILITY; revisa el texto.');
  }
});
