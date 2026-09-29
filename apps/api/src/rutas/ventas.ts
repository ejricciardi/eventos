import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { movimientoStockInput } from "@eventos/shared";
import type { Contexto } from "../app.js";
import {
  movimientosCaja,
  movimientosStock,
  pagos,
  productos,
  puntosVenta,
  sectores,
  usuarios,
  ventaItems,
  ventas,
} from "../db/schema.js";
import { ErrorApi } from "../errores.js";
import {
  arqueos,
  reporteAnulaciones,
  reporteObservaciones,
  reporteSincronizacion,
  reporteStock,
  reporteVales,
  reporteVentas,
} from "../ventas/reportes.js";

// Rutas del panel para ver lo que pasó en el evento (ventas, arqueos, reportes) y cargar stock.
// Son para supervisores y administradores, también si entraron con tarjeta: es operar, no configurar.

const filtroVentas = z.object({
  turnoId: z.string().uuid().optional(),
  puntoVentaId: z.coerce.number().int().positive().optional(),
  limite: z.coerce.number().int().min(1).max(1000).default(200),
});

const filtroTurno = z.object({ turnoId: z.string().uuid().optional() });

export function rutasVentas(app: FastifyInstance, { db, exigirSupervisor, eventoDeRuta }: Contexto) {
  const base = "/api/eventos/:eventoId";
  const evento = (req: FastifyRequest) => {
    exigirSupervisor(req);
    return eventoDeRuta(req);
  };

  app.get(`${base}/turnos`, async (req) => arqueos(db, evento(req).id));

  // Últimas ventas, con sus ítems y pagos. Se puede filtrar por turno o por punto de venta.
  app.get(`${base}/ventas`, async (req) => {
    const { id: eventoId } = evento(req);
    const f = filtroVentas.parse(req.query);
    const lista = db
      .select()
      .from(ventas)
      .where(
        and(
          eq(ventas.eventoId, eventoId),
          f.turnoId ? eq(ventas.turnoId, f.turnoId) : undefined,
          f.puntoVentaId ? eq(ventas.puntoVentaId, f.puntoVentaId) : undefined,
        ),
      )
      .orderBy(desc(ventas.creada))
      .limit(f.limite)
      .all();
    if (lista.length === 0) return [];
    const ids = lista.map((v) => v.id);
    const items = db.select().from(ventaItems).where(inArray(ventaItems.ventaId, ids)).all();
    const cobros = db.select().from(pagos).where(inArray(pagos.ventaId, ids)).all();
    const nombres = new Map(
      db
        .select({ id: usuarios.id, nombre: usuarios.nombre })
        .from(usuarios)
        .where(inArray(usuarios.id, [...new Set(lista.map((v) => v.usuarioId))]))
        .all()
        .map((u) => [u.id, u.nombre]),
    );
    const puntos = new Map(
      db
        .select({ id: puntosVenta.id, nombre: puntosVenta.nombre })
        .from(puntosVenta)
        .where(eq(puntosVenta.eventoId, eventoId))
        .all()
        .map((p) => [p.id, p.nombre]),
    );
    return lista.map((v) => ({
      ...v,
      cajero: nombres.get(v.usuarioId) ?? `Usuario ${v.usuarioId}`,
      puntoVenta: puntos.get(v.puntoVentaId) ?? `Punto ${v.puntoVentaId}`,
      items: items.filter((i) => i.ventaId === v.id),
      pagos: cobros.filter((p) => p.ventaId === v.id),
    }));
  });

  app.get(`${base}/movimientos-caja`, async (req) => {
    const { id: eventoId } = evento(req);
    const { turnoId } = filtroTurno.parse(req.query);
    return db
      .select()
      .from(movimientosCaja)
      .where(and(eq(movimientosCaja.eventoId, eventoId), turnoId ? eq(movimientosCaja.turnoId, turnoId) : undefined))
      .orderBy(desc(movimientosCaja.creada))
      .all();
  });

  app.get(`${base}/reportes/ventas`, async (req) => reporteVentas(db, evento(req).id));
  app.get(`${base}/reportes/stock`, async (req) => reporteStock(db, evento(req).id));
  app.get(`${base}/reportes/vales`, async (req) => reporteVales(db, evento(req).id));
  app.get(`${base}/reportes/anulaciones`, async (req) => reporteAnulaciones(db, evento(req).id));
  app.get(`${base}/reportes/observaciones`, async (req) => reporteObservaciones(db, evento(req).id));
  app.get(`${base}/reportes/sincronizacion`, async (req) => reporteSincronizacion(db, evento(req).id));

  app.get(`${base}/stock/movimientos`, async (req) => {
    const { id: eventoId } = evento(req);
    return db
      .select({
        id: movimientosStock.id,
        productoId: movimientosStock.productoId,
        producto: productos.nombre,
        sectorId: movimientosStock.sectorId,
        tipo: movimientosStock.tipo,
        cantidad: movimientosStock.cantidad,
        usuario: usuarios.nombre,
        nota: movimientosStock.nota,
        creado: movimientosStock.creado,
      })
      .from(movimientosStock)
      .innerJoin(productos, eq(productos.id, movimientosStock.productoId))
      .innerJoin(usuarios, eq(usuarios.id, movimientosStock.usuarioId))
      .where(eq(movimientosStock.eventoId, eventoId))
      .orderBy(desc(movimientosStock.creado), desc(movimientosStock.id))
      .all();
  });

  app.post(`${base}/stock`, async (req, reply) => {
    const { id: eventoId } = evento(req);
    const datos = movimientoStockInput.parse(req.body);
    const producto = db
      .select({ id: productos.id })
      .from(productos)
      .where(and(eq(productos.id, datos.productoId), eq(productos.eventoId, eventoId)))
      .get();
    if (!producto) throw new ErrorApi(400, "El producto no existe en este evento");
    if (
      datos.sectorId !== null &&
      !db
        .select({ id: sectores.id })
        .from(sectores)
        .where(and(eq(sectores.id, datos.sectorId), eq(sectores.eventoId, eventoId)))
        .get()
    ) {
      throw new ErrorApi(400, "El sector no existe en este evento");
    }
    const creado = db
      .insert(movimientosStock)
      .values({
        eventoId,
        productoId: datos.productoId,
        sectorId: datos.sectorId,
        tipo: datos.tipo,
        cantidad: datos.tipo === "merma" ? -datos.cantidad : datos.cantidad,
        usuarioId: req.sesion.usuarioId,
        nota: datos.nota ?? null,
        creado: new Date().toISOString(),
      })
      .returning()
      .get();
    return reply.status(201).send(creado);
  });
}
