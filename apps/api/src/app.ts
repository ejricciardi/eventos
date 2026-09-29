import Fastify, { type FastifyReply } from "fastify";
import cors from "@fastify/cors";
import { and, eq } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z, ZodError, type ZodTypeAny } from "zod";
import { eventoInput, impresoraInput, productoInput, puntoVentaInput, sectorInput, staffInput } from "@eventos/shared";
import type { Db } from "./db/index.js";
import { eventos, impresoras, productos, puntosVenta, sectores, staff } from "./db/schema.js";

const idParam = z.coerce.number().int().positive();

class ErrorApi extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const noEncontrado = (que: string) => new ErrorApi(404, `${que} no encontrado`);

export function crearApp(db: Db) {
  const app = Fastify({ logger: false });
  app.register(cors);

  app.setErrorHandler((err, _req, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Datos inválidos", detalles: err.flatten().fieldErrors });
    }
    if (err instanceof ErrorApi) return reply.status(err.status).send({ error: err.message });
    if (String((err as { code?: string }).code).startsWith("SQLITE_CONSTRAINT_UNIQUE")) {
      return reply.status(409).send({ error: "Ya existe un registro con ese valor" });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: status === 500 ? "Error interno" : (err as Error).message });
  });

  app.get("/api/salud", async () => ({ ok: true }));

  // ---- Eventos ----
  const buscarEvento = (id: number) => {
    const evento = db.select().from(eventos).where(eq(eventos.id, id)).get();
    if (!evento) throw noEncontrado("Evento");
    return evento;
  };

  const validarFechas = (e: { inicio: string; fin: string }) => {
    if (new Date(e.fin) <= new Date(e.inicio)) throw new ErrorApi(400, "El fin tiene que ser posterior al inicio");
  };

  app.get("/api/eventos", async () => db.select().from(eventos).all());

  app.get("/api/eventos/:id", async (req) => buscarEvento(idParam.parse((req.params as { id: string }).id)));

  app.post("/api/eventos", async (req, reply) => {
    const datos = eventoInput.parse(req.body);
    validarFechas(datos);
    const creado = db.insert(eventos).values(datos).returning().get();
    return reply.status(201).send(creado);
  });

  app.patch("/api/eventos/:id", async (req) => {
    const id = idParam.parse((req.params as { id: string }).id);
    const actual = buscarEvento(id);
    const cambios = eventoInput.partial().parse(req.body);
    validarFechas({ ...actual, ...cambios });
    if (Object.keys(cambios).length === 0) return actual;
    return db.update(eventos).set(cambios).where(eq(eventos.id, id)).returning().get();
  });

  app.delete("/api/eventos/:id", async (req, reply) => {
    const id = idParam.parse((req.params as { id: string }).id);
    buscarEvento(id);
    db.delete(eventos).where(eq(eventos.id, id)).run();
    return reply.status(204).send();
  });

  // ---- Recursos que pertenecen a un evento ----
  // Cada referencia (sectorId, impresoraId) tiene que apuntar a algo del mismo evento.
  type Referencias = Record<string, { tabla: SQLiteTable & { id: any; eventoId: any }; nombre: string }>;

  const recursoDeEvento = (
    ruta: string,
    nombre: string,
    tabla: SQLiteTable & { id: any; eventoId: any },
    schema: z.ZodObject<Record<string, ZodTypeAny>>,
    referencias: Referencias = {},
  ) => {
    const base = `/api/eventos/:eventoId/${ruta}`;
    const params = (req: { params: unknown }) => {
      const p = req.params as { eventoId: string; id?: string };
      const eventoId = idParam.parse(p.eventoId);
      buscarEvento(eventoId);
      return { eventoId, id: p.id === undefined ? undefined : idParam.parse(p.id) };
    };
    const validarReferencias = (eventoId: number, datos: Record<string, unknown>) => {
      for (const [campo, ref] of Object.entries(referencias)) {
        const valor = datos[campo];
        if (valor == null) continue;
        const existe = db
          .select({ id: ref.tabla.id })
          .from(ref.tabla)
          .where(and(eq(ref.tabla.id, valor), eq(ref.tabla.eventoId, eventoId)))
          .get();
        if (!existe) throw new ErrorApi(400, `${ref.nombre} no existe en este evento`);
      }
    };
    const filtro = (eventoId: number, id: number) => and(eq(tabla.id, id), eq(tabla.eventoId, eventoId));

    app.get(base, async (req) => {
      const { eventoId } = params(req);
      return db.select().from(tabla).where(eq(tabla.eventoId, eventoId)).all();
    });

    app.post(base, async (req, reply) => {
      const { eventoId } = params(req);
      const datos = schema.parse(req.body);
      validarReferencias(eventoId, datos);
      const creado = db
        .insert(tabla)
        .values({ ...datos, eventoId } as any)
        .returning()
        .get();
      return reply.status(201).send(creado);
    });

    app.patch(`${base}/:id`, async (req) => {
      const { eventoId, id } = params(req);
      const cambios = schema.partial().parse(req.body);
      validarReferencias(eventoId, cambios);
      if (Object.keys(cambios).length === 0) {
        const actual = db.select().from(tabla).where(filtro(eventoId, id!)).get();
        if (!actual) throw noEncontrado(nombre);
        return actual;
      }
      const actualizado = db
        .update(tabla)
        .set(cambios as any)
        .where(filtro(eventoId, id!))
        .returning()
        .get();
      if (!actualizado) throw noEncontrado(nombre);
      return actualizado;
    });

    app.delete(`${base}/:id`, async (req, reply) => {
      const { eventoId, id } = params(req);
      const borrado = db.delete(tabla).where(filtro(eventoId, id!)).returning().get();
      if (!borrado) throw noEncontrado(nombre);
      return reply.status(204).send();
    });
  };

  recursoDeEvento("impresoras", "Impresora", impresoras, impresoraInput);
  recursoDeEvento("sectores", "Sector", sectores, sectorInput, {
    impresoraId: { tabla: impresoras, nombre: "La impresora" },
  });
  recursoDeEvento("productos", "Producto", productos, productoInput, {
    sectorId: { tabla: sectores, nombre: "El sector" },
  });
  recursoDeEvento("puntos-venta", "Punto de venta", puntosVenta, puntoVentaInput);

  // ---- Staff ----
  app.get("/api/staff", async () => db.select().from(staff).all());

  app.post("/api/staff", async (req, reply) => {
    const creado = db.insert(staff).values(staffInput.parse(req.body)).returning().get();
    return reply.status(201).send(creado);
  });

  app.patch("/api/staff/:id", async (req) => {
    const id = idParam.parse((req.params as { id: string }).id);
    const cambios = staffInput.partial().parse(req.body);
    const actualizado =
      Object.keys(cambios).length === 0
        ? db.select().from(staff).where(eq(staff.id, id)).get()
        : db.update(staff).set(cambios).where(eq(staff.id, id)).returning().get();
    if (!actualizado) throw noEncontrado("Staff");
    return actualizado;
  });

  app.delete("/api/staff/:id", async (req, reply) => {
    const id = idParam.parse((req.params as { id: string }).id);
    const borrado = db.delete(staff).where(eq(staff.id, id)).returning().get();
    if (!borrado) throw noEncontrado("Staff");
    return reply.status(204).send();
  });

  // Login en el posnet: la app lee el UID de la tarjeta NFC y pregunta quién es.
  app.post("/api/staff/login-nfc", async (req) => {
    const { nfcUid } = z.object({ nfcUid: z.string().trim().min(1) }).parse(req.body);
    const persona = db
      .select()
      .from(staff)
      .where(and(eq(staff.nfcUid, nfcUid.toUpperCase()), eq(staff.activo, true)))
      .get();
    if (!persona) throw new ErrorApi(401, "Tarjeta no registrada o staff inactivo");
    return persona;
  });

  return app;
}
