/**
 * Arranca el entorno de simulación:
 *   - Portal de la aseguradora ficticia → http://<raspberry>:4100
 *   - WhatsApp simulado (API + teléfono web) → http://<raspberry>:4000
 * Variables: ASISTENTE_URL (http://localhost:3000), PUERTO_META, PUERTO_PORTAL, ZONA_HORARIA.
 */
import { fechaEnZona } from '../utils/fechas.js';
import { DEMO } from './demo.js';
import { crearAppMeta } from './meta.js';
import { crearAppPortal, EstadoPortal } from './portal.js';

const zona = process.env.ZONA_HORARIA ?? 'America/Mexico_City';
const puertoMeta = Number(process.env.PUERTO_META ?? 4000);
const puertoPortal = Number(process.env.PUERTO_PORTAL ?? 4100);
const asistenteUrl = (process.env.ASISTENTE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

const portal = new EstadoPortal(Object.values(DEMO.portal), fechaEnZona(new Date(), zona));
crearAppPortal(portal).listen(puertoPortal, () => console.log(`Portal de aseguradora simulado: http://localhost:${puertoPortal}  (usuarios: ${Object.values(DEMO.portal).map((u) => u.usuario).join(', ')})`));

const { app } = crearAppMeta({
  tokens: [DEMO.metaToken],
  appSecret: DEMO.appSecret,
  asistenteUrl,
  tokenSimulacion: DEMO.tokenSimulacion,
  plantillas: DEMO.plantillas,
  zona,
  portal,
});
app.listen(puertoMeta, () => console.log(`WhatsApp simulado: http://localhost:${puertoMeta}  → envía webhooks a ${asistenteUrl}/webhook`));
