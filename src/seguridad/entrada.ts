import { createInterface } from 'node:readline';

/**
 * Preguntas en la terminal. Las contraseñas se escriben sin mostrarse en pantalla
 * y nunca pasan por la línea de comandos (no quedan en el historial).
 * Si la entrada no es una terminal (p. ej. un script), se leen línea por línea de stdin.
 */

let lineasPendientes: string[] | null = null;

async function siguienteLineaStdin(): Promise<string> {
  if (lineasPendientes === null) {
    const trozos: Buffer[] = [];
    for await (const trozo of process.stdin) trozos.push(trozo as Buffer);
    lineasPendientes = Buffer.concat(trozos).toString('utf8').split(/\r?\n/);
  }
  return lineasPendientes.shift() ?? '';
}

export async function preguntar(texto: string, opciones: { oculto?: boolean; porDefecto?: string } = {}): Promise<string> {
  const sufijo = opciones.porDefecto ? ` [${opciones.porDefecto}]` : '';
  if (!process.stdin.isTTY) {
    const valor = (await siguienteLineaStdin()).trim();
    return valor || opciones.porDefecto || '';
  }
  if (!opciones.oculto) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const respuesta = await new Promise<string>((r) => rl.question(`${texto}${sufijo}: `, r));
    rl.close();
    return respuesta.trim() || opciones.porDefecto || '';
  }
  return new Promise<string>((resolver, rechazar) => {
    process.stdout.write(`${texto}: `);
    const entrada = process.stdin;
    let valor = '';
    entrada.setRawMode(true);
    entrada.resume();
    entrada.setEncoding('utf8');
    const alTeclear = (tecla: string) => {
      for (const c of tecla) {
        if (c === '\r' || c === '\n') {
          terminar();
          process.stdout.write('\n');
          resolver(valor);
          return;
        }
        if (c === '\u0003') {
          terminar();
          process.stdout.write('\n');
          rechazar(new Error('Cancelado'));
          return;
        }
        if (c === '\u007f' || c === '\b') valor = valor.slice(0, -1);
        else valor += c;
      }
    };
    const terminar = () => {
      entrada.setRawMode(false);
      entrada.pause();
      entrada.removeListener('data', alTeclear);
    };
    entrada.on('data', alTeclear);
  });
}

export async function preguntarContrasenaDoble(texto: string): Promise<string> {
  const primera = await preguntar(texto, { oculto: true });
  if (!process.stdin.isTTY) return primera;
  const segunda = await preguntar('Repítela', { oculto: true });
  if (primera !== segunda) throw new Error('Las contraseñas no coinciden');
  return primera;
}

export async function confirmar(texto: string): Promise<boolean> {
  const r = (await preguntar(`${texto} (s/n)`, { porDefecto: 'n' })).toLowerCase();
  return r === 's' || r === 'si' || r === 'sí' || r === 'y';
}
