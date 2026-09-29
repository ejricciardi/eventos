import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  claveProducto,
  operacionInput,
  ROLES_CONFIGURACION,
  vencimientoVales,
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

  const inconsistencia = validarConsistencia(op);
  if (inconsistencia) {
    registrarInvalida(db, disp, datos, recibida, inconsistencia);
    return { id: op.id, estado: "invalida", error: inconsistencia };
  }

  const observaciones: string[] = [];
  if (disp.revocado) observaciones.push("dispositivo_revocado");
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
  return { id: op.id, estado: "ok", observaciones: [...new Set(observaciones)] };
}

/** Guarda una operación inválida si trae id y secuencia, para que no aparezca como faltante. */
function registrarInvalida(db: Db, disp: Dispositivo, datos: Record<string, unknown>, recibida: string, error: string) {
  if (!esUuid(datos.id) || !esSeq(datos.seq)) return;
  const payload = JSON.stringify(datos);
  const yaEsta = db
    .select({ id: operaciones.id })
    .from(operaciones)
    .where(eq(operaciones.id, datos.id))
    .get();
  const seqUsada = db
    .select({ id: operaciones.id })
    .from(operaciones)
    .where(and(eq(operaciones.dispositivoId, disp.id), eq(operaciones.seq, datos.seq)))
    .get();
  if (yaEsta || seqUsada) {
    if (yaEsta?.id !== datos.id || seqUsada?.id !== datos.id) {
      registrarConflicto(db, disp, datos.id, datos.seq, payload, recibida);
    }
    return;
  }
  const creada = typeof datos.creada === "string" && !Number.isNaN(Date.parse(datos.creada)) ? datos.creada : recibida;
  db.insert(operaciones)
    .values({
      id: datos.id,
      dispositivoId: disp.id,
      eventoId: disp.eventoId,
      seq: datos.seq,
      tipo: typeof datos.tipo === "string" ? datos.tipo.slice(0, 40) : "desconocido",
      usuarioId: esSeq(datos.usuarioId) ? datos.usuarioId : null,
      payload,
      hash: sha256(payload),
      estado: "invalida",
      error,
      observaciones: [],
      creada,
      recibida,
    })
    .run();
}

function registrarConflicto(db: Db, disp: Dispositivo, id: string, seq: number, payload: string, recibida: string) {
  db.insert(conflictos)
    .values({ operacionId: id, dispositivoId: disp.id, eventoId: disp.eventoId, seq, payload, recibida })
    .run();
}

/** Reglas que no dependen del estado del sistema: si no se cumplen, la operación está mal armada. */
function validarConsistencia(op: Operacion): string | null {
  if (op.tipo === "venta") {
    const total = op.items.reduce((s, i) => s + i.precioUnitario * i.cantidad, 0);
    const pagado = op.pagos.reduce((s, p) => s + p.monto, 0);
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
        if (turno.seqCierre !== null && turno.seqCierre < op.seq) obs.push("turno_cerrado");
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
        if (tx.select({ id: vales.id }).from(vales).where(eq(vales.id, v.valeId)).get()) {
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
      return;
    }

    case "anulacion": {
      revisarUsuario(op.usuarioId);
      buscarTurno(op.turnoId);
      const venta = tx.select().from(ventas).where(eq(ventas.id, op.ventaId)).get();
      if (!venta || venta.eventoId !== disp.eventoId) {
        obs.push("venta_desconocida");
      } else {
        if (venta.estado === "anulada") obs.push("venta_ya_anulada");
        if (venta.dispositivoId !== disp.id) obs.push("anulada_en_otro_dispositivo");

        // Sin supervisor, el cajero solo puede anular dentro del plazo que fija el evento.
        const autorizada = esSupervisor(op.autorizadoPorId) || esSupervisor(op.usuarioId);
        revisarAutorizacion(op.autorizadoPorId);
        const evento = tx
          .select({ minutos: eventos.minutosAnulacionCajero })
          .from(eventos)
          .where(eq(eventos.id, disp.eventoId))
          .get()!;
        if (!autorizada && minutosEntre(venta.creada, op.creada) > evento.minutos) obs.push("fuera_de_plazo");

        const valesVenta = tx.select({ id: vales.id }).from(vales).where(eq(vales.ventaId, venta.id)).all();
        const recuperados = new Set(op.valesRecuperados);
        if (valesVenta.some((v) => !recuperados.has(v.id))) obs.push("vale_no_recuperado");
        if (
          valesVenta.length > 0 &&
          tx
            .select({ id: canjes.id })
            .from(canjes)
            .where(
              inArray(
                canjes.valeId,
                valesVenta.map((v) => v.id),
              ),
            )
            .get()
        ) {
          obs.push("anulacion_con_vale_canjeado");
        }

        const devuelto = op.devoluciones.reduce((s, d) => s + d.monto, 0);
        if (devuelto !== venta.total) obs.push("devolucion_distinta");
        const mediosCobrados = new Set(
          tx
            .select({ medio: pagos.medio })
            .from(pagos)
            .where(eq(pagos.ventaId, venta.id))
            .all()
            .map((p) => p.medio),
        );
        if (op.devoluciones.some((d) => !mediosCobrados.has(d.medio))) obs.push("devolucion_otro_medio");

        tx.update(ventas).set({ estado: "anulada" }).where(eq(ventas.id, venta.id)).run();
        tx.update(vales).set({ estado: "anulado" }).where(eq(vales.ventaId, venta.id)).run();
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
      const turno = buscarTurno(op.turnoId);
      if (turno?.seqCierre != null && turno.seqCierre < op.seq) obs.push("turno_cerrado");
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
        })
        .where(eq(turnos.id, op.turnoId))
        .run();
      return;
    }

    case "canje": {
      revisarUsuario(op.usuarioId);
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
 * Revisa un vale leído en una barra: firma, evento, sector, vencimiento, si está anulado o ya se canjeó.
 * Lo usa el canje que sube la barra y la consulta en línea antes de entregar.
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
  let productoId: number | null = null;
  let sectorEsperado: number | null = null;
  if (!eventoVale || eventoVale.cuentaId !== disp.cuentaId) {
    obs.push("vale_de_otra_cuenta");
  } else if (c.e === disp.eventoId) {
    productoId = c.p;
    sectorEsperado = c.s;
  } else if (eventoVale.valesValidez !== "sin_vencimiento") {
    obs.push("vale_de_otro_evento");
  } else {
    // Vale sin vencimiento de otro evento: se entrega el mismo producto de este evento (por código o nombre).
    const original = tx.select().from(productos).where(eq(productos.id, c.p)).get();
    const clave = original ? claveProducto(original) : null;
    const equivalente = clave
      ? tx
          .select()
          .from(productos)
          .where(eq(productos.eventoId, disp.eventoId))
          .all()
          .find((p) => claveProducto(p) === clave)
      : undefined;
    if (!equivalente) obs.push("producto_no_equivalente");
    else {
      productoId = equivalente.id;
      sectorEsperado = equivalente.sectorId;
    }
  }

  if (eventoVale) {
    const vence = vencimientoVales(eventoVale);
    if (vence && new Date(momento) > new Date(vence)) obs.push("vale_vencido");
  }
  if (disp.sectorPuntoVenta !== null && sectorEsperado !== null && sectorEsperado !== disp.sectorPuntoVenta) {
    obs.push("otro_sector");
  }

  const vale = tx.select({ estado: vales.estado }).from(vales).where(eq(vales.id, c.i)).get();
  if (!vale) obs.push("vale_sin_venta");
  else if (vale.estado === "anulado") obs.push("vale_anulado");
  if (tx.select({ id: canjes.id }).from(canjes).where(eq(canjes.valeId, c.i)).get()) obs.push("canje_duplicado");

  return { firmaValida: firmado, productoId, observaciones: obs };
}
