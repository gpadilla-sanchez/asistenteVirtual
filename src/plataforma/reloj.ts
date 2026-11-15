/**
 * Reloj de la plataforma. En producción es la hora real.
 * En modo simulación se puede adelantar por días para probar varios días en minutos.
 */
export class Reloj {
  private desfaseMs = 0;

  constructor(private readonly base: () => Date = () => new Date()) {}

  ahora(): Date {
    return new Date(this.base().getTime() + this.desfaseMs);
  }

  get desfaseDias(): number {
    return Math.round(this.desfaseMs / 86_400_000);
  }

  fijarDesfaseDias(dias: number): void {
    this.desfaseMs = dias * 86_400_000;
  }
}

/** Limita cuántas tareas pesadas (p. ej. navegadores) corren a la vez. */
export class Semaforo {
  private activos = 0;
  private readonly espera: (() => void)[] = [];

  constructor(private readonly limite: number) {}

  async ejecutar<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activos >= this.limite) await new Promise<void>((r) => this.espera.push(r));
    this.activos++;
    try {
      return await fn();
    } finally {
      this.activos--;
      this.espera.shift()?.();
    }
  }
}

/** Ejecuta funciones asíncronas una a la vez, en orden. */
export class Candado {
  private cola: Promise<unknown> = Promise.resolve();
  ejecutar<T>(fn: () => Promise<T>): Promise<T> {
    const resultado = this.cola.then(fn, fn);
    this.cola = resultado.catch(() => undefined);
    return resultado;
  }
}
