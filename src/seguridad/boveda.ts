import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Bóveda de secretos: guarda contraseñas y tokens cifrados con AES-256-GCM.
 *
 * - Un archivo por ámbito: `secretos/sistema.secreto` y `secretos/<agente>.secreto`.
 * - La clave maestra (32 bytes aleatorios) vive en un archivo aparte con permisos 600.
 *   Sin ella, los archivos .secreto son ilegibles.
 * - El nombre del ámbito se usa como dato autenticado: un archivo copiado de un agente
 *   a otro no se puede descifrar.
 * - Los valores solo existen descifrados en memoria y nunca se escriben en la bitácora.
 */

const ALGORITMO = 'aes-256-gcm';
const AMBITO_VALIDO = /^[a-z0-9][a-z0-9-]{0,40}$/;

interface ArchivoCifrado {
  version: 1;
  algoritmo: typeof ALGORITMO;
  iv: string;
  etiqueta: string;
  datos: string;
}

export type Secretos = Record<string, string>;

export class ErrorBoveda extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorBoveda';
  }
}

export class Boveda {
  private readonly cache = new Map<string, Secretos>();

  constructor(
    private readonly directorio: string,
    private clave: Buffer,
  ) {
    if (clave.length !== 32) throw new ErrorBoveda('La clave maestra debe medir 32 bytes');
  }

  // ---------------- Clave maestra ----------------

  static crearClaveMaestra(ruta: string): void {
    if (existsSync(ruta)) throw new ErrorBoveda(`Ya existe una clave maestra en ${ruta}; no se sobrescribe`);
    mkdirSync(dirname(ruta), { recursive: true });
    writeFileSync(ruta, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
    chmodSync(ruta, 0o600);
  }

  static cargarClaveMaestra(ruta: string): Buffer {
    if (!existsSync(ruta)) {
      throw new ErrorBoveda(`No existe la clave maestra (${ruta}). Ejecuta primero: npm run inicializar`);
    }
    const modo = statSync(ruta).mode & 0o777;
    if (process.platform !== 'win32' && (modo & 0o007) !== 0) {
      throw new ErrorBoveda(`La clave maestra ${ruta} puede leerla cualquier usuario. Corrige con: chmod 600 ${ruta}`);
    }
    const clave = Buffer.from(readFileSync(ruta, 'utf8').trim(), 'base64');
    if (clave.length !== 32) throw new ErrorBoveda(`La clave maestra ${ruta} está dañada`);
    return clave;
  }

  static abrir(directorio: string, rutaClave: string): Boveda {
    return new Boveda(directorio, Boveda.cargarClaveMaestra(rutaClave));
  }

  // ---------------- Lectura y escritura ----------------

  private ruta(ambito: string): string {
    if (!AMBITO_VALIDO.test(ambito)) throw new ErrorBoveda(`Ámbito inválido: "${ambito}"`);
    return join(this.directorio, `${ambito}.secreto`);
  }

  private cifrar(ambito: string, secretos: Secretos): ArchivoCifrado {
    const iv = randomBytes(12);
    const cifrador = createCipheriv(ALGORITMO, this.clave, iv);
    cifrador.setAAD(Buffer.from(`ambito:${ambito}`));
    const datos = Buffer.concat([cifrador.update(JSON.stringify(secretos), 'utf8'), cifrador.final()]);
    return {
      version: 1,
      algoritmo: ALGORITMO,
      iv: iv.toString('base64'),
      etiqueta: cifrador.getAuthTag().toString('base64'),
      datos: datos.toString('base64'),
    };
  }

  private descifrar(ambito: string, archivo: ArchivoCifrado, clave = this.clave): Secretos {
    try {
      const descifrador = createDecipheriv(ALGORITMO, clave, Buffer.from(archivo.iv, 'base64'));
      descifrador.setAAD(Buffer.from(`ambito:${ambito}`));
      descifrador.setAuthTag(Buffer.from(archivo.etiqueta, 'base64'));
      const plano = Buffer.concat([descifrador.update(Buffer.from(archivo.datos, 'base64')), descifrador.final()]);
      return JSON.parse(plano.toString('utf8')) as Secretos;
    } catch {
      throw new ErrorBoveda(`No se pudieron descifrar los secretos de "${ambito}": la clave maestra no corresponde o el archivo fue alterado`);
    }
  }

  leer(ambito: string): Secretos {
    const enCache = this.cache.get(ambito);
    if (enCache) return { ...enCache };
    const ruta = this.ruta(ambito);
    if (!existsSync(ruta)) return {};
    const secretos = this.descifrar(ambito, JSON.parse(readFileSync(ruta, 'utf8')) as ArchivoCifrado);
    this.cache.set(ambito, secretos);
    return { ...secretos };
  }

  obtener(ambito: string, clave: string): string | undefined {
    return this.leer(ambito)[clave];
  }

  requerir(ambito: string, clave: string): string {
    const valor = this.obtener(ambito, clave);
    if (!valor) throw new ErrorBoveda(`Falta el secreto "${clave}" de "${ambito}". Usa: npm run secretos`);
    return valor;
  }

  guardar(ambito: string, secretos: Secretos): void {
    const ruta = this.ruta(ambito);
    mkdirSync(this.directorio, { recursive: true });
    const temporal = `${ruta}.tmp`;
    writeFileSync(temporal, JSON.stringify(this.cifrar(ambito, secretos), null, 2), { mode: 0o600 });
    renameSync(temporal, ruta);
    this.cache.set(ambito, { ...secretos });
  }

  actualizar(ambito: string, cambios: Record<string, string | undefined>): void {
    const actuales = this.leer(ambito);
    for (const [clave, valor] of Object.entries(cambios)) {
      if (valor === undefined || valor === '') delete actuales[clave];
      else actuales[clave] = valor;
    }
    this.guardar(ambito, actuales);
  }

  borrar(ambito: string): void {
    const ruta = this.ruta(ambito);
    if (existsSync(ruta)) unlinkSync(ruta);
    this.cache.delete(ambito);
  }

  ambitos(): string[] {
    if (!existsSync(this.directorio)) return [];
    return readdirSync(this.directorio)
      .filter((f) => f.endsWith('.secreto'))
      .map((f) => f.slice(0, -'.secreto'.length))
      .sort();
  }

  /** Vuelve a cifrar todos los ámbitos con una clave maestra nueva. */
  recifrar(nuevaClave: Buffer): void {
    if (nuevaClave.length !== 32) throw new ErrorBoveda('La clave nueva debe medir 32 bytes');
    const todos = this.ambitos().map((a) => [a, this.leer(a)] as const);
    const nueva = new Boveda(this.directorio, nuevaClave);
    for (const [ambito, secretos] of todos) nueva.guardar(ambito, secretos);
    this.clave = nuevaClave;
    this.cache.clear();
  }
}

/** Muestra solo el inicio y el final de un secreto: "abcd…wxyz". */
export function enmascararSecreto(valor: string | undefined): string {
  if (!valor) return '(vacío)';
  if (valor.length <= 8) return '••••••';
  return `${valor.slice(0, 3)}…${valor.slice(-3)} (${valor.length} caracteres)`;
}
