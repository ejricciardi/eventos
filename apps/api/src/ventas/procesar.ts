import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  claveProducto,
  MONTO_MAXIMO,
  operacionInput,
  ROLES_CONFIGURACION,
  vencimientoVales,
  type MedioPago,
  type Operacion,
  type ResultadoOperacion,
} from "@eventos/shared";
import type { Db } from "../db/index.js";
import {
  anulaciones,
  canjes,
  conflictos,
  devoluciones,
  dispositivos,
  eventos,
  movimientosCaja,
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
import { firmaValida, leerQr, type QrLeido } from "./firma.js";

/** El posnet que sube las operaciones, con su punto de venta y su evento. */
export type Dispositivo = {
  id: string;
  puntoVentaId: number;
  eventoId: number;
  cuentaId: number;
  revocado: string | null;
  clavePublica: string | null;
  tipoPuntoVenta: "caja" | "canje";
  sectorPuntoVenta: number | null;
};

// Cualquier transacción o la base misma: las dos tienen la misma forma para lo que usamos acá.
type Tx = Pick<Db, "select" | "insert" | "update">;

const sha256 = (texto: string) => createHash("sha256").update(texto).digest("hex");
const esUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const esSeq = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const minutosEntre = (desde: string, hasta: string) => (new Date(hasta).getTime() - new Date(desde).getTime()) / 60000;

/**
 * Procesa una operación que subió un posnet. Nunca rechaza algo que ya pasó (una venta cobrada, un vale canjeado)
 * por el estado actual del sistema: lo guarda y anota observaciones para que un supervisor las revise.
 * Solo rechaza lo mal formado o inconsistente consigo mismo (por ejemplo, pagos que no suman el total).
 */
export function procesarOperacion(db: Db, disp: Dispositivo, crudo: unknown, recibida: string): ResultadoOperacion {
  const datos = (crudo ?? {}) as Record<string, unknown>;
  const idCrudo = esUuid(datos.id) ? datos.id : null;

  const parseada = operacionInput.safeParse(crudo);
  if (!parseada.success) {
    const error = parseada.error.issues.map((i) => `${i.path.join(".") || "operación"}: ${i.message}`).join("; ");
    registrarInvalida(db, disp, datos, recibida, error);
    return { id: idCrudo, estado: "invalida", error };
  }
  const op = parseada.data;
  const payload = JSON.stringify(op);
  const hash = sha256(payload);

  const previa = db.select().from(operaciones).where(eq(operaciones.id, op.id)).get();
  if (previa) {
    if (previa.hash === hash && previa.dispositivoId === disp.id) {
      return previa.estado === "ok"
        ? { id: op.id, estado: "repetida", observaciones: previa.observaciones }
        : { id: op.id, estado: "invalida", error: previa.error ?? undefined };
    }
    registrarConflicto(db, disp, op.id, op.seq, payload, recibida);
    ocuparSecuencia(db, disp, op.seq, payload, recibida, "El id de esta operación ya lo usó otra");
    return { id: op.id, estado: "conflicto", error: "Ya llegó una operación con este id y otros datos" };
  }
  const mismaSecuencia = db
    .select({ id: operaciones.id })
    .from(operaciones)
    .where(and(eq(operaciones.dispositivoId, disp.id), eq(operaciones.seq, op.seq)))
    .get();
  if (mismaSecuencia) {
    registrarConflicto(db, disp, op.id, op.seq, payload, recibida);
    return { id: op.id, estado: "conflicto", error: `La secuencia ${op.seq} ya la usó otra operación de este posnet` };
  }

  // Se guarda con los datos ya validados, así un reintento de la misma operación da el mismo hash.
  const inconsistencia = validarConsistencia(op);
  if (inconsistencia) {
    registrarInvalida(db, disp, datos, recibida, inconsistencia, payload);
    return { id: op.id, estado: "invalida", error: inconsistencia };
  }

  const observaciones: string[] = [];
  if (disp.revocado) observaciones.push("dispositivo_revocado");
  try {
    aplicarYRegistrar(db, disp, op, payload, hash, recibida, observaciones);
  } catch (err) {
    // Algo que no se previó no puede trabar al posnet: la operación queda registrada como inválida y sigue el resto.
    const error = `No se pudo aplicar: ${(err as Error).message}`;
    registrarInvalida(db, disp, datos, recibida, error, payload);
    return { id: op.id, estado: "invalida", error };
  }
  return { id: op.id, estado: "ok", observaciones: [...new Set(observaciones)] };
}

function aplicarYRegistrar(
  db: Db,
  disp: Dispositivo,
  op: Operacion,
  payload: string,
  hash: string,
  recibida: string,
  observaciones: string[],
) {
  db.transaction((tx) => {
    aplicar(tx, disp, op, observaciones);
    tx.insert(operaciones)
      .values({
        id: op.id,
        dispositivoId: disp.id,
        eventoId: disp.eventoId,
        seq: op.seq,
        tipo: op.tipo,
        usuarioId: op.usuarioId,
        payload,
        hash,
        estado: "ok",
        observaciones: [...new Set(observaciones)],
        creada: op.creada,
        recibida,
      })
      .run();
  });
}

/** Id fijo para registrar una secuencia cuya operación no trae un id usable. */
function idDeSecuencia(dispositivoId: string, seq: number) {
  const h = sha256(`${dispositivoId}:${seq}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Guarda una operación inválida para que su secuencia no quede como faltante (y el posnet la pueda borrar).
 * Si el id ya lo usó otra operación, igual ocupa la secuencia con un id propio.
 */
function registrarInvalida(
  db: Db,
  disp: Dispositivo,
  datos: Record<string, unknown>,
  recibida: string,
  error: string,
  payload = JSON.stringify(datos),
) {
  if (!esSeq(datos.seq)) return;
  if (!esUuid(datos.id)) {
    ocuparSecuencia(db, disp, datos.seq, payload, recibida, error, datos);
    return;
  }
  const yaEsta = db
    .select({ dispositivoId: operaciones.dispositivoId, seq: operaciones.seq })
    .from(operaciones)
    .where(eq(operaciones.id, datos.id))
    .get();
  if (yaEsta) {
    // La misma operación que ya se había rechazado: no hay nada nuevo que guardar.
    if (yaEsta.dispositivoId === disp.id && yaEsta.seq === datos.seq) return;
    registrarConflicto(db, disp, datos.id, datos.seq, payload, recibida);
    ocuparSecuencia(db, disp, datos.seq, payload, recibida, error, datos);
    return;
  }
  if (secuenciaUsada(db, disp, datos.seq)) {
    registrarConflicto(db, disp, datos.id, datos.seq, payload, recibida);
    return;
  }
  insertarInvalida(db, disp, datos.id, datos.seq, datos, payload, recibida, error);
}

const secuenciaUsada = (db: Db, disp: Dispositivo, seq: number) =>
  db
    .select({ id: operaciones.id })
    .from(operaciones)
    .where(and(eq(operaciones.dispositivoId, disp.id), eq(operaciones.seq, seq)))
    .get() !== undefined;

/** Registra la secuencia como inválida con un id propio, si todavía está libre. */
function ocuparSecuencia(
  db: Db,
  disp: Dispositivo,
  seq: number,
  payload: string,
  recibida: string,
  error: string,
  datos: Record<string, unknown> = {},
) {
  if (secuenciaUsada(db, disp, seq)) return;
  const id = idDeSecuencia(disp.id, seq);
  if (db.select({ id: operaciones.id }).from(operaciones).where(eq(operaciones.id, id)).get()) return;
  insertarInvalida(db, disp, id, seq, datos, payload, recibida, error);
}

function insertarInvalida(
  db: Db,
  disp: Dispositivo,
  id: string,
  seq: number,
  datos: Record<string, unknown>,
  payload: string,
  recibida: string,
  error: string,
) {
  const creada = typeof datos.creada === "string" && !Number.isNaN(Date.parse(datos.creada)) ? datos.creada : recibida;
  db.insert(operaciones)
    .values({
      id,
      dispositivoId: disp.id,
      eventoId: disp.eventoId,
      seq,
      tipo: typeof datos.tipo === "string" ? datos.tipo.slice(0, 40) : "desconocido",
      usuarioId: esSeq(datos.usuarioId) ? datos.usuarioId : null,
      payload,
      hash: sha256(payload),
      estado: "invalida",
      error: error.slice(0, 1000),
      observaciones: [],
      creada,
      recibida,
    })
    .run();
}

function registrarConflicto(db: Db, disp: Dispositivo, id: string, seq: number, payload: string, recibida: string) {
  // El mismo conflicto reenviado no se vuelve a anotar.
  const repetido = db
    .select({ id: conflictos.id })
    .from(conflictos)
    .where(and(eq(conflictos.operacionId, id), eq(conflictos.dispositivoId, disp.id), eq(conflictos.payload, payload)))
    .get();
  if (repetido) return;
  db.insert(conflictos)
    .values({ operacionId: id, dispositivoId: disp.id, eventoId: disp.eventoId, seq, payload, recibida })
    .run();
}

/** Reglas que no dependen del estado del sistema: si no se cumplen, la operación está mal armada. */
function validarConsistencia(op: Operacion): string | null {
  if (op.tipo === "venta") {
    const total = op.items.reduce((s, i) => s + i.precioUnitario * i.cantidad, 0);
    const pagado = op.pagos.reduce((s, p) => s + p.monto, 0);
    if (total > MONTO_MAXIMO) return "El total de la venta supera el máximo permitido";
    if (pagado !== total) return `Los pagos (${pagado}) no suman el total de la venta (${total})`;
    const porItem = new Map<number, number>();
    const ids = new Set<string>();
    for (const v of op.vales) {
      if (v.item >= op.items.length) return `El vale ${v.valeId} apunta a un ítem que no existe`;
      if (ids.has(v.valeId)) return `El vale ${v.valeId} está repetido`;
      ids.add(v.valeId);
      porItem.set(v.item, (porItem.get(v.item) ?? 0) + 1);
    }
    for (const [item, cantidad] of porItem) {
      if (cantidad !== op.items[item].cantidad) return `El ítem ${item} tiene ${cantidad} vales para ${op.items[item].cantidad} unidades`;
    }
  }
  if (op.tipo === "canje" && !leerQr(op.qr)) return "El QR del vale no tiene un formato válido";
  return null;
}

function aplicar(tx: Tx, disp: Dispositivo, op: Operacion, obs: string[]) {
  const usuario = (id: number) =>
    tx
      .select({ id: usuarios.id, rol: usuarios.rol, activo: usuarios.activo })
      .from(usuarios)
      .where(and(eq(usuarios.id, id), eq(usuarios.cuentaId, disp.cuentaId)))
      .get();
  const revisarUsuario = (id: number) => {
    const u = usuario(id);
    if (!u) obs.push("usuario_desconocido");
    else if (!u.activo) obs.push("usuario_inactivo");
    return u;
  };
  const esSupervisor = (id: number | undefined) => {
    if (id === undefined) return false;
    const u = usuario(id);
    return !!u && u.activo && (ROLES_CONFIGURACION as readonly string[]).includes(u.rol);
  };
  const revisarAutorizacion = (id: number | undefined) => {
    if (id !== undefined && !esSupervisor(id)) obs.push("autorizacion_invalida");
  };
  const buscarTurno = (turnoId: string) => {
    const t = tx.select().from(turnos).where(eq(turnos.id, turnoId)).get();
    if (!t) obs.push("turno_desconocido");
    else if (t.eventoId !== disp.eventoId) obs.push("turno_de_otro_evento");
    else if (t.dispositivoId !== disp.id) obs.push("turno_de_otro_dispositivo");
    return t;
  };
  // Si este mismo posnet ya había cerrado el turno antes de esta operación (por su número), llegó tarde.
  const revisarCierre = (turno: typeof turnos.$inferSelect | undefined) => {
    if (turno?.seqCierre != null && turno.dispositivoCierreId === disp.id && turno.seqCierre < op.seq) {
      obs.push("turno_cerrado");
    }
  };

  /** Controles de una anulación contra su venta: al llegar la anulación o, si llegó antes, al llegar la venta. */
  const revisarAnulacion = (
    venta: typeof ventas.$inferSelect,
    a: {
      dispositivoId: string;
      usuarioId: number;
      autorizadoPorId?: number | null;
      creada: string;
      valesRecuperados: string[];
      devoluciones: { medio: MedioPago; monto: number }[];
    },
  ) => {
    if (venta.dispositivoId !== a.dispositivoId) obs.push("anulada_en_otro_dispositivo");

    // Sin supervisor, el cajero solo puede anular dentro del plazo que fija el evento.
    const autorizada = esSupervisor(a.autorizadoPorId ?? undefined) || esSupervisor(a.usuarioId);
    const evento = tx
      .select({ minutos: eventos.minutosAnulacionCajero })
      .from(eventos)
      .where(eq(eventos.id, venta.eventoId))
      .get()!;
    if (!autorizada && minutosEntre(venta.creada, a.creada) > evento.minutos) obs.push("fuera_de_plazo");

    const valesVenta = tx
      .select({ id: vales.id })
      .from(vales)
      .where(and(eq(vales.eventoId, venta.eventoId), eq(vales.ventaId, venta.id)))
      .all()
      .map((v) => v.id);
    const recuperados = new Set(a.valesRecuperados);
    if (valesVenta.some((id) => !recuperados.has(id))) obs.push("vale_no_recuperado");
    const canjeado =
      valesVenta.length > 0 &&
      tx
        .select({ id: canjes.id })
        .from(canjes)
        .innerJoin(eventos, eq(eventos.id, canjes.eventoId))
        .where(
          and(
            inArray(canjes.valeId, valesVenta),
            eq(canjes.eventoValeId, venta.eventoId),
            eq(eventos.cuentaId, disp.cuentaId),
          ),
        )
        .get();
    if (canjeado) obs.push("anulacion_con_vale_canjeado");

    // Lo devuelto tiene que coincidir con lo cobrado, medio por medio (no se devuelve en efectivo lo que se cobró con tarjeta).
    const devuelto = a.devoluciones.reduce((s, d) => s + d.monto, 0);
    if (devuelto !== venta.total) obs.push("devolucion_distinta");
    const cobradoPorMedio = new Map<string, number>();
    for (const p of tx.select({ medio: pagos.medio, monto: pagos.monto }).from(pagos).where(eq(pagos.ventaId, venta.id)).all()) {
      cobradoPorMedio.set(p.medio, (cobradoPorMedio.get(p.medio) ?? 0) + p.monto);
    }
    const devueltoPorMedio = new Map<string, number>();
    for (const d of a.devoluciones) devueltoPorMedio.set(d.medio, (devueltoPorMedio.get(d.medio) ?? 0) + d.monto);
    if ([...devueltoPorMedio].some(([medio, monto]) => monto > (cobradoPorMedio.get(medio) ?? 0))) {
      obs.push("devolucion_otro_medio");
    }
  };

  const marcarAnulada = (venta: { id: string; eventoId: number }) => {
    tx.update(ventas).set({ estado: "anulada" }).where(eq(ventas.id, venta.id)).run();
    tx.update(vales)
      .set({ estado: "anulado" })
      .where(and(eq(vales.eventoId, venta.eventoId), eq(vales.ventaId, venta.id)))
      .run();
  };

  switch (op.tipo) {
    case "apertura_turno": {
      revisarUsuario(op.usuarioId);
      revisarAutorizacion(op.entregadoPorId);
      if (disp.tipoPuntoVenta === "canje") obs.push("turno_en_puesto_de_canje");
      const otroAbierto = tx
        .select({ id: turnos.id })
        .from(turnos)
        .where(and(eq(turnos.dispositivoId, disp.id), ne(turnos.id, op.turnoId), isNull(turnos.seqCierre)))
        .get();
      if (otroAbierto) obs.push("otro_turno_abierto");
      const existente = tx.select().from(turnos).where(eq(turnos.id, op.turnoId)).get();
      if (existente && existente.eventoId !== disp.eventoId) {
        obs.push("turno_de_otro_evento");
        return;
      }
      if (existente && existente.aperturaRecibida) {
        obs.push("turno_repetido");
        return;
      }
      const datos = {
        usuarioId: op.usuarioId,
        fondoInicial: op.fondoInicial,
        entregadoPorId: op.entregadoPorId ?? null,
        abierto: op.creada,
        aperturaRecibida: true,
      };
      if (existente) {
        // El cierre llegó antes que la apertura: se completa el turno.
        if (existente.dispositivoId !== disp.id) obs.push("turno_de_otro_dispositivo");
        tx.update(turnos).set(datos).where(eq(turnos.id, op.turnoId)).run();
      } else {
        tx.insert(turnos)
          .values({ id: op.turnoId, eventoId: disp.eventoId, dispositivoId: disp.id, puntoVentaId: disp.puntoVentaId, ...datos })
          .run();
      }
      return;
    }

    case "venta": {
      if (tx.select({ id: ventas.id }).from(ventas).where(eq(ventas.id, op.ventaId)).get()) {
        obs.push("venta_repetida");
        return;
      }
      revisarUsuario(op.usuarioId);
      if (disp.tipoPuntoVenta === "canje") obs.push("venta_en_puesto_de_canje");
      const turno = buscarTurno(op.turnoId);
      if (turno) {
        if (turno.usuarioId !== op.usuarioId) obs.push("cajero_distinto");
        revisarCierre(turno);
      }

      const idsProductos = [...new Set(op.items.map((i) => i.productoId))];
      const catalogo = new Map(
        tx
          .select()
          .from(productos)
          .where(and(eq(productos.eventoId, disp.eventoId), inArray(productos.id, idsProductos)))
          .all()
          .map((p) => [p.id, p]),
      );
      for (const item of op.items) {
        const p = catalogo.get(item.productoId);
        if (!p) obs.push("producto_desconocido");
        else {
          if (!p.activo) obs.push("producto_inactivo");
          if (p.precio !== item.precioUnitario) obs.push("precio_distinto");
        }
      }

      const necesitaAutorizacion = op.pagos.some((p) => ["cortesia", "transferencia", "otro"].includes(p.medio));
      if (necesitaAutorizacion && !esSupervisor(op.autorizadoPorId)) obs.push("falta_autorizacion");
      else revisarAutorizacion(op.autorizadoPorId);
      if (op.pagos.some((p) => !p.verificado)) obs.push("pago_no_verificado");
      const externos = op.pagos.map((p) => p.idExterno).filter((x): x is string => !!x);
      if (externos.length > 0) {
        const repetido = tx
          .select({ id: pagos.id })
          .from(pagos)
          .innerJoin(ventas, eq(ventas.id, pagos.ventaId))
          .innerJoin(eventos, eq(eventos.id, ventas.eventoId))
          .where(and(inArray(pagos.idExterno, externos), eq(eventos.cuentaId, disp.cuentaId)))
          .get();
        if (repetido || new Set(externos).size !== externos.length) obs.push("pago_externo_repetido");
      }

      const total = op.items.reduce((s, i) => s + i.precioUnitario * i.cantidad, 0);
      tx.insert(ventas)
        .values({
          id: op.ventaId,
          eventoId: disp.eventoId,
          dispositivoId: disp.id,
          puntoVentaId: disp.puntoVentaId,
          turnoId: op.turnoId,
          usuarioId: op.usuarioId,
          numero: op.numero,
          total,
          conVales: op.vales.length > 0,
          estado: "confirmada",
          autorizadoPorId: op.autorizadoPorId ?? null,
          creada: op.creada,
        })
        .run();
      for (const item of op.items) {
        tx.insert(ventaItems)
          .values({
            ventaId: op.ventaId,
            productoId: item.productoId,
            nombre: item.nombre,
            precioUnitario: item.precioUnitario,
            cantidad: item.cantidad,
            subtotal: item.precioUnitario * item.cantidad,
            sectorId: catalogo.get(item.productoId)?.sectorId ?? null,
          })
          .run();
      }
      for (const p of op.pagos) {
        tx.insert(pagos)
          .values({
            ventaId: op.ventaId,
            medio: p.medio,
            monto: p.monto,
            recibido: p.recibido ?? null,
            idExterno: p.idExterno ?? null,
            autorizacion: p.autorizacion ?? null,
            ultimos4: p.ultimos4 ?? null,
            verificado: p.verificado,
          })
          .run();
      }
      for (const v of op.vales) {
        const qr = leerQr(v.qr);
        const item = op.items[v.item];
        const coincide =
          !!qr &&
          qr.contenido.i === v.valeId &&
          qr.contenido.e === disp.eventoId &&
          qr.contenido.p === item.productoId &&
          qr.contenido.d === disp.id;
        if (!coincide) obs.push("vale_inconsistente");
        const firmado = !!qr && firmaValida(qr, disp.clavePublica);
        if (!firmado) obs.push("firma_invalida");
        if (
          tx
            .select({ id: vales.id })
            .from(vales)
            .where(and(eq(vales.eventoId, disp.eventoId), eq(vales.id, v.valeId)))
            .get()
        ) {
          obs.push("vale_repetido");
          continue;
        }
        tx.insert(vales)
          .values({
            id: v.valeId,
            eventoId: disp.eventoId,
            ventaId: op.ventaId,
            productoId: item.productoId,
            sectorId: qr?.contenido.s ?? catalogo.get(item.productoId)?.sectorId ?? null,
            dispositivoId: disp.id,
            qr: v.qr,
            firmaValida: firmado,
            estado: "emitido",
            emitido: op.creada,
          })
          .run();
      }

      // La anulación pudo llegar antes que la venta (por ejemplo, la subió otro posnet que se conectó primero).
      const anulacionPrevia = tx
        .select()
        .from(anulaciones)
        .where(and(eq(anulaciones.ventaId, op.ventaId), eq(anulaciones.eventoId, disp.eventoId)))
        .get();
      if (anulacionPrevia) {
        obs.push("venta_anulada_antes_de_llegar");
        const venta = tx.select().from(ventas).where(eq(ventas.id, op.ventaId)).get()!;
        revisarAnulacion(venta, {
          ...anulacionPrevia,
          devoluciones: tx.select().from(devoluciones).where(eq(devoluciones.anulacionId, anulacionPrevia.id)).all(),
        });
        marcarAnulada(venta);
      }
      return;
    }

    case "anulacion": {
      revisarUsuario(op.usuarioId);
      revisarCierre(buscarTurno(op.turnoId));
      const venta = tx.select().from(ventas).where(eq(ventas.id, op.ventaId)).get();
      if (!venta || venta.eventoId !== disp.eventoId) {
        obs.push("venta_desconocida");
      } else {
        if (venta.estado === "anulada") obs.push("venta_ya_anulada");
        revisarAutorizacion(op.autorizadoPorId);
        revisarAnulacion(venta, { ...op, dispositivoId: disp.id });
        marcarAnulada(venta);
      }
      tx.insert(anulaciones)
        .values({
          id: op.id,
          eventoId: disp.eventoId,
          dispositivoId: disp.id,
          ventaId: op.ventaId,
          turnoId: op.turnoId,
          usuarioId: op.usuarioId,
          autorizadoPorId: op.autorizadoPorId ?? null,
          motivo: op.motivo,
          detalle: op.detalle ?? null,
          valesRecuperados: op.valesRecuperados,
          creada: op.creada,
        })
        .run();
      for (const d of op.devoluciones) {
        tx.insert(devoluciones)
          .values({ anulacionId: op.id, turnoId: op.turnoId, medio: d.medio, monto: d.monto, idExterno: d.idExterno ?? null })
          .run();
      }
      return;
    }

    case "movimiento_caja": {
      revisarUsuario(op.usuarioId);
      if (tx.select({ id: movimientosCaja.id }).from(movimientosCaja).where(eq(movimientosCaja.id, op.movimientoId)).get()) {
        obs.push("movimiento_repetido");
        return;
      }
      revisarCierre(buscarTurno(op.turnoId));
      if (op.movimiento === "retiro" && !esSupervisor(op.autorizadoPorId) && !esSupervisor(op.usuarioId)) {
        obs.push("falta_autorizacion");
      } else revisarAutorizacion(op.autorizadoPorId);
      tx.insert(movimientosCaja)
        .values({
          id: op.movimientoId,
          eventoId: disp.eventoId,
          dispositivoId: disp.id,
          turnoId: op.turnoId,
          tipo: op.movimiento,
          monto: op.monto,
          motivo: op.motivo,
          usuarioId: op.usuarioId,
          autorizadoPorId: op.autorizadoPorId ?? null,
          creada: op.creada,
        })
        .run();
      return;
    }

    case "cierre_turno": {
      revisarUsuario(op.usuarioId);
      let turno = buscarTurno(op.turnoId);
      if (!turno) {
        // Llegó el cierre antes que la apertura: se crea el turno y se completa cuando llegue la apertura.
        tx.insert(turnos)
          .values({
            id: op.turnoId,
            eventoId: disp.eventoId,
            dispositivoId: disp.id,
            puntoVentaId: disp.puntoVentaId,
            usuarioId: op.usuarioId,
            fondoInicial: 0,
            abierto: op.creada,
            aperturaRecibida: false,
          })
          .run();
        turno = tx.select().from(turnos).where(eq(turnos.id, op.turnoId)).get()!;
      }
      // Un turno de otro evento no se toca (queda la observación).
      if (turno.eventoId !== disp.eventoId) return;
      if (turno.seqCierre !== null) {
        obs.push("turno_ya_cerrado");
        return;
      }
      if (turno.usuarioId !== op.usuarioId && !esSupervisor(op.usuarioId)) obs.push("cierre_por_otro");
      tx.update(turnos)
        .set({
          cerrado: op.creada,
          cerradoPorId: op.usuarioId,
          efectivoDeclarado: op.efectivoDeclarado,
          cantidadVentasDeclarada: op.cantidadVentas,
          totalesDeclarados: op.totalesPorMedio,
          seqCierre: op.seq,
          dispositivoCierreId: disp.id,
        })
        .where(eq(turnos.id, op.turnoId))
        .run();
      return;
    }

    case "canje": {
      revisarUsuario(op.usuarioId);
      if (tx.select({ id: canjes.id }).from(canjes).where(eq(canjes.id, op.canjeId)).get()) {
        obs.push("canje_repetido");
        return;
      }
      const qr = leerQr(op.qr)!;
      const evaluacion = evaluarCanje(tx, disp, qr, op.creada);
      obs.push(...evaluacion.observaciones);
      tx.insert(canjes)
        .values({
          id: op.canjeId,
          operacionId: op.id,
          eventoId: disp.eventoId,
          dispositivoId: disp.id,
          puntoVentaId: disp.puntoVentaId,
          valeId: qr.contenido.i,
          eventoValeId: qr.contenido.e,
          productoValeId: qr.contenido.p,
          productoId: evaluacion.productoId,
          firmaValida: evaluacion.firmaValida,
          usuarioId: op.usuarioId,
          creada: op.creada,
        })
        .run();
      return;
    }
  }
}

export type EvaluacionCanje = {
  firmaValida: boolean;
  /** Producto a entregar, en el evento donde se canjea. */
  productoId: number | null;
  observaciones: string[];
};

/**
 * Producto de una lista que corresponde a otro (mismo código o, sin código, mismo nombre).
 * Si hay varios, prefiere uno disponible. Lo usan el canje en línea y la configuración que baja al posnet.
 */
export function productoEquivalente<P extends { codigo: string | null; nombre: string; activo: boolean }>(
  lista: P[],
  original: { codigo: string | null; nombre: string },
): P | undefined {
  const clave = claveProducto(original);
  return [...lista].sort((a, b) => Number(b.activo) - Number(a.activo)).find((p) => claveProducto(p) === clave);
}

/**
 * Revisa un vale leído en una barra: firma, evento, sector, vencimiento, si está anulado o ya se canjeó.
 * Lo usa el canje que sube la barra y la consulta en línea antes de entregar.
 * Solo mira vales y canjes de la cuenta del posnet: lo que haga otra cuenta con un id ajeno no afecta.
 */
export function evaluarCanje(tx: Tx, disp: Dispositivo, qr: QrLeido, momento: string): EvaluacionCanje {
  const obs: string[] = [];
  const c = qr.contenido;

  // El posnet que emitió el vale tiene que ser de un punto de venta del evento que dice el QR.
  const emisor = tx
    .select({ clavePublica: dispositivos.clavePublica, eventoId: puntosVenta.eventoId })
    .from(dispositivos)
    .innerJoin(puntosVenta, eq(puntosVenta.id, dispositivos.puntoVentaId))
    .where(eq(dispositivos.id, c.d))
    .get();
  const firmado = !!emisor && emisor.eventoId === c.e && firmaValida(qr, emisor.clavePublica);
  if (!firmado) obs.push("firma_invalida");

  const eventoVale = tx.select().from(eventos).where(eq(eventos.id, c.e)).get();
  if (!eventoVale || eventoVale.cuentaId !== disp.cuentaId) {
    obs.push("vale_de_otra_cuenta");
    return { firmaValida: firmado, productoId: null, observaciones: obs };
  }

  let productoId: number | null = null;
  let sectorEsperado: number | null = null;
  const productosAca = () => tx.select().from(productos).where(eq(productos.eventoId, disp.eventoId)).all();
  if (c.e === disp.eventoId) {
    const producto = tx
      .select({ id: productos.id })
      .from(productos)
      .where(and(eq(productos.id, c.p), eq(productos.eventoId, disp.eventoId)))
      .get();
    if (!producto) obs.push("producto_desconocido");
    else productoId = producto.id;
    sectorEsperado = c.s;
  } else if (eventoVale.valesValidez !== "sin_vencimiento") {
    obs.push("vale_de_otro_evento");
  } else {
    // Vale sin vencimiento de otro evento: se entrega el mismo producto de este evento (por código o nombre).
    const original = tx
      .select()
      .from(productos)
      .where(and(eq(productos.id, c.p), eq(productos.eventoId, c.e)))
      .get();
    const equivalente = original ? productoEquivalente(productosAca(), original) : undefined;
    if (!equivalente) obs.push("producto_no_equivalente");
    else {
      productoId = equivalente.id;
      sectorEsperado = equivalente.sectorId;
    }
  }

  const vence = vencimientoVales(eventoVale);
  if (vence && new Date(momento) > new Date(vence)) obs.push("vale_vencido");
  if (disp.sectorPuntoVenta !== null && sectorEsperado !== null && sectorEsperado !== disp.sectorPuntoVenta) {
    obs.push("otro_sector");
  }

  const vale = tx
    .select({ estado: vales.estado })
    .from(vales)
    .where(and(eq(vales.eventoId, c.e), eq(vales.id, c.i)))
    .get();
  if (!vale) obs.push("vale_sin_venta");
  else if (vale.estado === "anulado") obs.push("vale_anulado");
  if (canjePrevio(tx, disp.cuentaId, c.e, c.i)) obs.push("canje_duplicado");

  return { firmaValida: firmado, productoId, observaciones: obs };
}

/** Primer canje de un vale hecho en algún evento de la cuenta, o undefined. */
export function canjePrevio(tx: Tx, cuentaId: number, eventoValeId: number, valeId: string) {
  return tx
    .select({ id: canjes.id, creada: canjes.creada, puntoVentaId: canjes.puntoVentaId })
    .from(canjes)
    .innerJoin(eventos, eq(eventos.id, canjes.eventoId))
    .where(and(eq(canjes.valeId, valeId), eq(canjes.eventoValeId, eventoValeId), eq(eventos.cuentaId, cuentaId)))
    .orderBy(canjes.creada)
    .get();
}
