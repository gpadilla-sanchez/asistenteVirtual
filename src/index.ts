import { rutasDesdeEntorno } from './plataforma/configuracion.js';
import { Plataforma } from './plataforma/plataforma.js';
import { crearApp } from './servidor/app.js';

let plataforma: Plataforma;
try {
  plataforma = Plataforma.crear(rutasDesdeEntorno(), { tokenSimulacion: process.env.SIMULACION_TOKEN });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const { sistema, logger } = plataforma;
if (sistema.modo === 'simulacion') {
  logger.warn(`MODO SIMULACIÓN: los mensajes van a ${sistema.meta.graph_url}, no a WhatsApp real`);
  if (!process.env.SIMULACION_TOKEN) logger.warn('Sin SIMULACION_TOKEN: los controles del simulador están desactivados');
}

const servidor = crearApp(plataforma).listen(sistema.puerto, () => {
  logger.info(`Asistente escuchando en el puerto ${sistema.puerto} · ${plataforma.agentes().length} agente(s): ${plataforma.agentes().map((a) => a.id).join(', ')}`);
});
const detener = plataforma.iniciarProgramador();

function apagar(senal: string) {
  logger.info({ senal }, 'Apagando');
  detener();
  servidor.close(() => {
    plataforma.cerrar();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => apagar('SIGTERM'));
process.on('SIGINT', () => apagar('SIGINT'));
