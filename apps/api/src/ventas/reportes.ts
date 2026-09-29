import { and, eq, inArray, lte, or, sql } from "drizzle-orm";
import { MEDIOS_PAGO, type MedioPago } from "@eventos/shared";
import type { Db } from "../db/index.js";
import {
  anulaciones,
  canjes,
  conflictos,
  devoluciones,
  dispositivos,
  eventos,
  movimientosCaja,
  movimientosStock,
  operaciones,
  pagos,
  productos,
  puntosVenta,
  turnos,
  usuarios,
  vales,
  ventaItems,
  ventas,
} from "../db/schema.js";

type PorMedio = Partial<Record<MedioPago, number>>;

const sumarEn = (destino: Map<string, PorMedio>, clave: string, medio: MedioPago, monto: number) => {
  const actual = destino.get(clave) ?? {};
  actual[medio] = (actual[medio] ?? 0) + monto;
  destino.set(clave, actual);
};

export type Arqueo = {
  turnoId: string;
  puntoVentaId: number;
  puntoVenta: string;
  usuarioId: number;
  cajero: string;
  abierto: string;
  cerrado: string | null;
  fondoInicial: number;
  cobrado: PorMedio;
  devuelto: PorMedio;
  ingresos: number;
  retiros: number;
  ventas: number;
  anuladas: number;
  efectivoEsperado: number;
  efectivoDeclarado: number | null;
  diferencia: number | null;
  /**
   * abierto: todavía no cerró. cerrado: cerró y llegó todo.
   * incompleto: cerró pero faltan operaciones de ese posnet (el arqueo puede cambiar cuando lleguen).
   */
  estado: "abierto" | "cerrado" | "incompleto";
  /** Lo que el posnet dijo haber cobrado no coincide con lo que llegó. */
  difiereDelPosnet: boolean;
  aperturaRecibida: boolean;
};

/**
 * Arqueo de cada turno del evento. Se calcula al leerlo, así refleja lo que va llegando.
 * Efectivo esperado = fondo + efectivo cobrado en el turno (incluidas ventas después anuladas)
 * + ingresos - retiros - efectivo devuelto en el turno.
 */
export function arqueos(db: Db, eventoId: number, cuentaId: number): Arqueo[] {
  const filas = db
    .select({
      turno: turnos,
      puntoVenta: puntosVenta.nombre,
      cajero: usuarios.nombre,
    })
    .from(turnos)
    .innerJoin(puntosVenta, eq(puntosVenta.id, turnos.puntoVentaId))
    // Los nombres solo de la cuenta: un posnet podría subir un id de usuario de otra.
    .leftJoin(usuarios, and(eq(usuarios.id, turnos.usuarioId), eq(usuarios.cuentaId, cuentaId)))
    .where(eq(turnos.eventoId, eventoId))
    .all();
  if (filas.length === 0) return [];

  const cobrado = new Map<string, PorMedio>();
  for (const p of db
    .select({ turnoId: ventas.turnoId, medio: pagos.medio, monto: sql<number>`sum(${pagos.monto})` })
    .from(pagos)
    .innerJoin(ventas, eq(ventas.id, pagos.ventaId))
    .where(eq(ventas.eventoId, eventoId))
    .groupBy(ventas.turnoId, pagos.medio)
    .all()) {
    sumarEn(cobrado, p.turnoId, p.medio, p.monto);
  }

  const devuelto = new Map<string, PorMedio>();
  for (const d of db
    .select({ turnoId: devoluciones.turnoId, medio: devoluciones.medio, monto: sql<number>`sum(${devoluciones.monto})` })
    .from(devoluciones)
    .innerJoin(anulaciones, eq(anulaciones.id, devoluciones.anulacionId))
    .where(eq(anulaciones.eventoId, eventoId))
    .groupBy(devoluciones.turnoId, devoluciones.medio)
    .all()) {
    sumarEn(devuelto, d.turnoId, d.medio, d.monto);
  }

  const movimientos = new Map<string, { ingresos: number; retiros: number }>();
  for (const m of db
    .select({ turnoId: movimientosCaja.turnoId, tipo: movimientosCaja.tipo, monto: sql<number>`sum(${movimientosCaja.monto})` })
    .from(movimientosCaja)
    .where(eq(movimientosCaja.eventoId, eventoId))
    .groupBy(movimientosCaja.turnoId, movimientosCaja.tipo)
    .all()) {
    const actual = movimientos.get(m.turnoId) ?? { ingresos: 0, retiros: 0 };
    if (m.tipo === "ingreso") actual.ingresos += m.monto;
    else actual.retiros += m.monto;
    movimientos.set(m.turnoId, actual);
  }

  const cantidades = new Map<string, { total: number; anuladas: number }>();
  for (const v of db
    .select({
      turnoId: ventas.turnoId,
      total: sql<number>`count(*)`,
      anuladas: sql<number>`sum(case when ${ventas.estado} = 'anulada' then 1 else 0 end)`,
    })
    .from(ventas)
    .where(eq(ventas.eventoId, eventoId))
    .groupBy(ventas.turnoId)
    .all()) {
    cantidades.set(v.turnoId, { total: v.total, anuladas: v.anuladas });
  }

  return filas.map(({ turno, puntoVenta, cajero }) => {
    const c = cobrado.get(turno.id) ?? {};
    const d = devuelto.get(turno.id) ?? {};
    const mov = movimientos.get(turno.id) ?? { ingresos: 0, retiros: 0 };
    const cant = cantidades.get(turno.id) ?? { total: 0, anuladas: 0 };
    const esperado = turno.fondoInicial + (c.efectivo ?? 0) + mov.ingresos - mov.retiros - (d.efectivo ?? 0);

    let estado: Arqueo["estado"] = "abierto";
    let difiere = false;
    if (turno.seqCierre !== null) {
      // Todas las operaciones del posnet que cerró, hasta el cierre, tienen que haber llegado.
      // Si cerró otro posnet, además el del turno no puede tener huecos.
      const cierre = turno.dispositivoCierreId ?? turno.dispositivoId;
      const completo =
        turno.aperturaRecibida &&
        sinHuecosHasta(db, cierre, turno.seqCierre) &&
        (cierre === turno.dispositivoId || sinHuecosHasta(db, turno.dispositivoId)) &&
        cant.total >= (turno.cantidadVentasDeclarada ?? 0);
      estado = completo ? "cerrado" : "incompleto";
      const declarados = turno.totalesDeclarados ?? {};
      difiere = MEDIOS_PAGO.some((m) => (declarados[m] ?? 0) !== (c[m] ?? 0));
    }

    return {
      turnoId: turno.id,
      puntoVentaId: turno.puntoVentaId,
      puntoVenta,
      usuarioId: turno.usuarioId,
      cajero: cajero ?? `Usuario ${turno.usuarioId}`,
      abierto: turno.abierto,
      cerrado: turno.cerrado,
      fondoInicial: turno.fondoInicial,
      cobrado: c,
      devuelto: d,
      ingresos: mov.ingresos,
      retiros: mov.retiros,
      ventas: cant.total,
      anuladas: cant.anuladas,
      efectivoEsperado: esperado,
      efectivoDeclarado: turno.efectivoDeclarado,
      diferencia: turno.efectivoDeclarado === null ? null : turno.efectivoDeclarado - esperado,
      estado,
      difiereDelPosnet: difiere,
      aperturaRecibida: turno.aperturaRecibida,
    };
  });
}

/** Si llegaron todas las operaciones del posnet desde la 1 hasta `hasta` (o hasta la última que llegó). */
function sinHuecosHasta(db: Db, dispositivoId: string, hasta?: number) {
  const { n, ultima } = db
    .select({ n: sql<number>`count(*)`, ultima: sql<number>`coalesce(max(${operaciones.seq}), 0)` })
    .from(operaciones)
    .where(and(eq(operaciones.dispositivoId, dispositivoId), hasta === undefined ? undefined : lte(operaciones.seq, hasta)))
    .get()!;
  return n === (hasta ?? ultima);
}

/** Nombres de los usuarios de la cuenta (un posnet podría subir ids de otra cuenta: esos no se muestran). */
export function nombresDeUsuarios(db: Db, cuentaId: number, ids: number[]) {
  if (ids.length === 0) return new Map<number, string>();
  return new Map(
    db
      .select({ id: usuarios.id, nombre: usuarios.nombre })
      .from(usuarios)
      .where(and(eq(usuarios.cuentaId, cuentaId), inArray(usuarios.id, [...new Set(ids)])))
      .all()
      .map((u) => [u.id, u.nombre]),
  );
}

/** Totales de ventas del evento: generales, por producto, por medio de pago, por punto de venta y por cajero. */
export function reporteVentas(db: Db, eventoId: number, cuentaId: number) {
  const confirmadas = and(eq(ventas.eventoId, eventoId), eq(ventas.estado, "confirmada"));

  const totales = db
    .select({
      ventas: sql<number>`coalesce(sum(case when ${ventas.estado} = 'confirmada' then 1 else 0 end), 0)`,
      importe: sql<number>`coalesce(sum(case when ${ventas.estado} = 'confirmada' then ${ventas.total} else 0 end), 0)`,
      anuladas: sql<number>`coalesce(sum(case when ${ventas.estado} = 'anulada' then 1 else 0 end), 0)`,
      importeAnulado: sql<number>`coalesce(sum(case when ${ventas.estado} = 'anulada' then ${ventas.total} else 0 end), 0)`,
    })
    .from(ventas)
    .where(eq(ventas.eventoId, eventoId))
    .get()!;

  const porProducto = db
    .select({
      productoId: ventaItems.productoId,
      nombre: sql<string>`max(${ventaItems.nombre})`,
      cantidad: sql<number>`sum(${ventaItems.cantidad})`,
      importe: sql<number>`sum(${ventaItems.subtotal})`,
    })
    .from(ventaItems)
    .innerJoin(ventas, eq(ventas.id, ventaItems.ventaId))
    .where(confirmadas)
    .groupBy(ventaItems.productoId)
    .orderBy(sql`sum(${ventaItems.subtotal}) desc`)
    .all();

  const porMedio = db
    .select({ medio: pagos.medio, cantidad: sql<number>`count(*)`, importe: sql<number>`sum(${pagos.monto})` })
    .from(pagos)
    .innerJoin(ventas, eq(ventas.id, pagos.ventaId))
    .where(confirmadas)
    .groupBy(pagos.medio)
    .all();

  const porPuntoVenta = db
    .select({
      puntoVentaId: ventas.puntoVentaId,
      nombre: sql<string>`max(${puntosVenta.nombre})`,
      ventas: sql<number>`count(*)`,
      importe: sql<number>`sum(${ventas.total})`,
    })
    .from(ventas)
    .leftJoin(puntosVenta, eq(puntosVenta.id, ventas.puntoVentaId))
    .where(confirmadas)
    .groupBy(ventas.puntoVentaId)
    .all();

  const porCajero = db
    .select({ usuarioId: ventas.usuarioId, ventas: sql<number>`count(*)`, importe: sql<number>`sum(${ventas.total})` })
    .from(ventas)
    .where(confirmadas)
    .groupBy(ventas.usuarioId)
    .all();
  const nombres = nombresDeUsuarios(
    db,
    cuentaId,
    porCajero.map((c) => c.usuarioId),
  );

  return {
    ...totales,
    porProducto,
    porMedio,
    porPuntoVenta,
    porCajero: porCajero.map((c) => ({ ...c, nombre: nombres.get(c.usuarioId) ?? `Usuario ${c.usuarioId}` })),
  };
}

/**
 * Stock por producto: lo cargado y ajustado desde el panel, menos mermas y lo vendido (ventas no anuladas).
 * Con vales, además cuánto se entregó (canjes) y cuánto falta entregar.
 */
export function reporteStock(db: Db, eventoId: number) {
  const lista = db.select().from(productos).where(eq(productos.eventoId, eventoId)).all();
  // En la base la merma se guarda en negativo, así el stock es la suma de todo.
  const movimientos = new Map<number, { cargado: number; ajustes: number; mermas: number }>();
  for (const m of db
    .select({ productoId: movimientosStock.productoId, tipo: movimientosStock.tipo, cantidad: sql<number>`sum(${movimientosStock.cantidad})` })
    .from(movimientosStock)
    .where(eq(movimientosStock.eventoId, eventoId))
    .groupBy(movimientosStock.productoId, movimientosStock.tipo)
    .all()) {
    const actual = movimientos.get(m.productoId) ?? { cargado: 0, ajustes: 0, mermas: 0 };
    if (m.tipo === "carga") actual.cargado += m.cantidad;
    else if (m.tipo === "merma") actual.mermas -= m.cantidad;
    else actual.ajustes += m.cantidad;
    movimientos.set(m.productoId, actual);
  }
  const vendidos = new Map(
    db
      .select({ productoId: ventaItems.productoId, cantidad: sql<number>`sum(${ventaItems.cantidad})` })
      .from(ventaItems)
      .innerJoin(ventas, eq(ventas.id, ventaItems.ventaId))
      .where(and(eq(ventas.eventoId, eventoId), eq(ventas.estado, "confirmada")))
      .groupBy(ventaItems.productoId)
      .all()
      .map((v) => [v.productoId, v.cantidad]),
  );
  const valesEmitidos = new Map(
    db
      .select({ productoId: vales.productoId, cantidad: sql<number>`count(*)` })
      .from(vales)
      .where(and(eq(vales.eventoId, eventoId), eq(vales.estado, "emitido")))
      .groupBy(vales.productoId)
      .all()
      .map((v) => [v.productoId, v.cantidad]),
  );
  // Canjes hechos en este evento, contados una vez por vale aunque haya duplicados.
  const entregados = new Map(
    db
      .select({ productoId: canjes.productoId, cantidad: sql<number>`count(distinct ${canjes.valeId})` })
      .from(canjes)
      .where(eq(canjes.eventoId, eventoId))
      .groupBy(canjes.productoId)
      .all()
      .map((c) => [c.productoId, c.cantidad]),
  );

  return lista.map((p) => {
    const m = movimientos.get(p.id) ?? { cargado: 0, ajustes: 0, mermas: 0 };
    const vendido = vendidos.get(p.id) ?? 0;
    const emitidos = valesEmitidos.get(p.id) ?? 0;
    const canjeados = entregados.get(p.id) ?? 0;
    return {
      productoId: p.id,
      nombre: p.nombre,
      controlaStock: p.controlaStock,
      cargado: m.cargado,
      ajustes: m.ajustes,
      mermas: m.mermas,
      vendido,
      actual: m.cargado + m.ajustes - m.mermas - vendido,
      valesEmitidos: emitidos,
      canjeados,
      pendientesDeEntrega: Math.max(0, emitidos - canjeados),
    };
  });
}

/** Stock actual de los productos que lo controlan (para avisar en el posnet cuando se agotan). */
export function stockActual(db: Db, eventoId: number): Map<number, number> {
  return new Map(reporteStock(db, eventoId).map((s) => [s.productoId, s.actual]));
}

/** Estado de los vales del evento y alertas de canje. */
export function reporteVales(db: Db, eventoId: number, cuentaId: number) {
  const porEstado = db
    .select({ estado: vales.estado, cantidad: sql<number>`count(*)` })
    .from(vales)
    .where(eq(vales.eventoId, eventoId))
    .groupBy(vales.estado)
    .all();
  // Emitidos = vigentes (no anulados). Canjeados cuenta cada vale vigente una vez, aunque se haya leído dos veces.
  const emitidos = porEstado.find((e) => e.estado === "emitido")?.cantidad ?? 0;
  const anulados = porEstado.find((e) => e.estado === "anulado")?.cantidad ?? 0;
  // Solo canjes hechos en eventos de esta cuenta: un posnet de otra cuenta no puede "gastar" un vale de acá.
  const eventosCuenta = db.select({ id: eventos.id }).from(eventos).where(eq(eventos.cuentaId, cuentaId));
  const canjeados = db
    .select({ n: sql<number>`count(distinct ${canjes.valeId})` })
    .from(canjes)
    .innerJoin(vales, and(eq(vales.id, canjes.valeId), eq(vales.eventoId, canjes.eventoValeId)))
    .where(and(eq(vales.eventoId, eventoId), eq(vales.estado, "emitido"), inArray(canjes.eventoId, eventosCuenta)))
    .get()!.n;
  // Canjes de vales de este evento (o hechos en este evento) que el servidor observó: duplicados, vencidos, etc.
  const alertas = db
    .select({ canje: canjes, observaciones: operaciones.observaciones, puntoVenta: puntosVenta.nombre })
    .from(canjes)
    .innerJoin(operaciones, eq(operaciones.id, canjes.operacionId))
    .leftJoin(puntosVenta, eq(puntosVenta.id, canjes.puntoVentaId))
    .where(
      and(
        or(eq(canjes.eventoId, eventoId), eq(canjes.eventoValeId, eventoId)),
        inArray(canjes.eventoId, eventosCuenta),
        sql`${operaciones.observaciones} <> '[]'`,
      ),
    )
    .orderBy(canjes.creada)
    .all()
    .map((a) => ({ ...a.canje, puntoVenta: a.puntoVenta, observaciones: a.observaciones }));
  return { emitidos, anulados, canjeados, pendientes: Math.max(0, emitidos - canjeados), alertas };
}

/** Anulaciones por cajero, con el porcentaje sobre lo que vendió, y el detalle de cada una. */
export function reporteAnulaciones(db: Db, eventoId: number, cuentaId: number) {
  const lista = db
    .select({ anulacion: anulaciones, venta: ventas })
    .from(anulaciones)
    .leftJoin(ventas, eq(ventas.id, anulaciones.ventaId))
    .where(eq(anulaciones.eventoId, eventoId))
    .all();
  const nombres = nombresDeUsuarios(
    db,
    cuentaId,
    lista.flatMap((l) => [l.anulacion.usuarioId, ...(l.anulacion.autorizadoPorId ? [l.anulacion.autorizadoPorId] : [])]),
  );
  const vendido = new Map(
    db
      .select({ usuarioId: ventas.usuarioId, importe: sql<number>`sum(${ventas.total})` })
      .from(ventas)
      .where(eq(ventas.eventoId, eventoId))
      .groupBy(ventas.usuarioId)
      .all()
      .map((v) => [v.usuarioId, v.importe]),
  );
  const porCajero = new Map<number, { cantidad: number; importe: number }>();
  for (const l of lista) {
    const actual = porCajero.get(l.anulacion.usuarioId) ?? { cantidad: 0, importe: 0 };
    actual.cantidad += 1;
    actual.importe += l.venta?.total ?? 0;
    porCajero.set(l.anulacion.usuarioId, actual);
  }
  return {
    porCajero: [...porCajero].map(([usuarioId, a]) => ({
      usuarioId,
      nombre: nombres.get(usuarioId) ?? `Usuario ${usuarioId}`,
      ...a,
      porcentaje: vendido.get(usuarioId) ? Math.round((a.importe / vendido.get(usuarioId)!) * 1000) / 10 : null,
    })),
    detalle: lista.map((l) => ({
      id: l.anulacion.id,
      ventaId: l.anulacion.ventaId,
      numero: l.venta?.numero ?? null,
      total: l.venta?.total ?? null,
      motivo: l.anulacion.motivo,
      detalle: l.anulacion.detalle,
      cajero: nombres.get(l.anulacion.usuarioId) ?? `Usuario ${l.anulacion.usuarioId}`,
      autorizadoPor: l.anulacion.autorizadoPorId ? (nombres.get(l.anulacion.autorizadoPorId) ?? null) : null,
      minutosDesdeLaVenta: l.venta
        ? Math.round((new Date(l.anulacion.creada).getTime() - new Date(l.venta.creada).getTime()) / 60000)
        : null,
      creada: l.anulacion.creada,
    })),
  };
}

/** Operaciones con observaciones, inválidas o en conflicto: lo que un supervisor tiene que revisar. */
export function reporteObservaciones(db: Db, eventoId: number) {
  const ops = db
    .select({
      id: operaciones.id,
      tipo: operaciones.tipo,
      estado: operaciones.estado,
      error: operaciones.error,
      observaciones: operaciones.observaciones,
      seq: operaciones.seq,
      creada: operaciones.creada,
      recibida: operaciones.recibida,
      puntoVenta: puntosVenta.nombre,
    })
    .from(operaciones)
    .innerJoin(dispositivos, eq(dispositivos.id, operaciones.dispositivoId))
    .innerJoin(puntosVenta, eq(puntosVenta.id, dispositivos.puntoVentaId))
    .where(eq(operaciones.eventoId, eventoId))
    .all()
    .filter((o) => o.estado === "invalida" || o.observaciones.length > 0);
  const enConflicto = db.select().from(conflictos).where(eq(conflictos.eventoId, eventoId)).all();
  return { operaciones: ops, conflictos: enConflicto };
}

/** Cómo viene subiendo cada posnet: última vez, desfase del reloj y operaciones que faltan. */
export function reporteSincronizacion(db: Db, eventoId: number) {
  const lista = db
    .select({ dispositivo: dispositivos, puntoVenta: puntosVenta.nombre })
    .from(dispositivos)
    .innerJoin(puntosVenta, eq(puntosVenta.id, dispositivos.puntoVentaId))
    .where(eq(puntosVenta.eventoId, eventoId))
    .all();
  return lista.map(({ dispositivo, puntoVenta }) => {
    const seqs = db
      .select({ seq: operaciones.seq })
      .from(operaciones)
      .where(eq(operaciones.dispositivoId, dispositivo.id))
      .orderBy(operaciones.seq)
      .all()
      .map((o) => o.seq);
    const faltantes: number[] = [];
    let esperado = 1;
    for (const s of seqs) {
      while (esperado < s && faltantes.length < 50) faltantes.push(esperado++);
      esperado = s + 1;
    }
    return {
      dispositivoId: dispositivo.id,
      puntoVenta,
      vinculado: dispositivo.creado,
      revocado: dispositivo.revocado,
      ultimaSincronizacion: dispositivo.ultimaSincronizacion,
      desfaseMs: dispositivo.desfaseMs,
      operaciones: seqs.length,
      ultimaSeq: seqs.at(-1) ?? 0,
      faltantes,
    };
  });
}
