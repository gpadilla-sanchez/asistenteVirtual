import ExcelJS from 'exceljs';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { PerfilPortal } from '../plataforma/configuracion.js';
import { interpretarTabla } from './columnas.js';
import type { FuenteDatos, Pago } from './tipos.js';

/** Lee un CSV (coma o punto y coma, comillas dobles, BOM de Excel). */
export function parsearCsv(contenido: string): string[][] {
  const texto = contenido.replace(/^﻿/, '');
  const primeraLinea = texto.split(/\r?\n/, 1)[0] ?? '';
  const separador = (primeraLinea.match(/;/g)?.length ?? 0) > (primeraLinea.match(/,/g)?.length ?? 0) ? ';' : ',';
  const filas: string[][] = [];
  let fila: string[] = [];
  let campo = '';
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === separador) { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); campo = '';
      if (fila.some((v) => v.trim() !== '')) filas.push(fila);
      fila = [];
    } else campo += c;
  }
  fila.push(campo);
  if (fila.some((v) => v.trim() !== '')) filas.push(fila);
  return filas;
}

function valorCelda(valor: ExcelJS.CellValue): unknown {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date || typeof valor !== 'object') return valor;
  if ('result' in valor) return (valor as ExcelJS.CellFormulaValue).result ?? null;
  if ('richText' in valor) return (valor as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join('');
  if ('text' in valor) return (valor as ExcelJS.CellHyperlinkValue).text;
  return String(valor);
}

/** Lee la primera hoja de un .xlsx como tabla. */
export async function leerXlsx(ruta: string): Promise<unknown[][]> {
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.readFile(ruta);
  const hoja = libro.worksheets[0];
  if (!hoja) return [];
  const filas: unknown[][] = [];
  hoja.eachRow({ includeEmpty: false }, (fila) => {
    const valores: unknown[] = [];
    fila.eachCell({ includeEmpty: true }, (celda, col) => {
      valores[col - 1] = valorCelda(celda.value);
    });
    filas.push(valores);
  });
  return filas;
}

export async function leerTablaDeArchivo(ruta: string): Promise<unknown[][]> {
  const ext = extname(ruta).toLowerCase();
  if (ext === '.xlsx') return leerXlsx(ruta);
  if (ext === '.csv' || ext === '.txt') {
    // Los CSV que exporta Excel en Windows suelen venir en Latin-1
    const utf8 = readFileSync(ruta, 'utf8');
    return parsearCsv(utf8.includes('�') ? readFileSync(ruta, 'latin1') : utf8);
  }
  throw new Error(`Formato no soportado: ${ext} (usa .xlsx o .csv)`);
}

/**
 * Fuente "archivo": el agente descarga el reporte de recibos del portal y lo deja en su carpeta
 * (o lo copia un proceso externo). Se usa siempre el archivo más reciente.
 * Útil si el portal pide captcha o doble factor y no se puede automatizar el inicio de sesión.
 */
export class FuenteArchivo implements FuenteDatos {
  readonly nombre = 'Archivo';

  constructor(
    private readonly carpeta: string,
    private readonly perfil: PerfilPortal | undefined,
    private readonly aceptaPorDefecto: boolean,
  ) {}

  archivoMasReciente(): string | null {
    if (!existsSync(this.carpeta)) return null;
    const archivos = readdirSync(this.carpeta)
      .filter((f) => /\.(xlsx|csv)$/i.test(f) && !f.startsWith('~$'))
      .map((f) => ({ ruta: join(this.carpeta, f), fecha: statSync(join(this.carpeta, f)).mtimeMs }))
      .sort((a, b) => b.fecha - a.fecha);
    return archivos[0]?.ruta ?? null;
  }

  async leerPagos(): Promise<Pago[]> {
    const ruta = this.archivoMasReciente();
    if (!ruta) throw new Error(`No hay archivos .xlsx o .csv en ${this.carpeta}`);
    return interpretarTabla(await leerTablaDeArchivo(ruta), this.perfil, this.aceptaPorDefecto);
  }
}
