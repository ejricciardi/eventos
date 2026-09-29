import { randomUUID } from "node:crypto";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { and, eq, gt, isNull, lte, ne, or } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { z, ZodError, type ZodTypeAny } from "zod";
import {
  eventoInput,
  impresoraInput,
  loginInput,
  loginNfcInput,
  productoInput,
  puntoVentaInput,
  registroInput,
  ROLES_CONFIGURACION,
  sectorInput,
  usuarioInput,
  type Sesion,
  type Usuario,
} from "@eventos/shared";
import type { Db } from "./db/index.js";
import {
  anulaciones,
  canjes,
  cuentas,
  dispositivos,
  eventos,
  impresoras,
  movimientosCaja,
  movimientosStock,
  operaciones,
  productos,
  puntosVenta,
  sectores,
  sesiones,
  turnos,
  usuarios,
  vales,
  ventaItems,
  ventas,
} from "./db/schema.js";
import { ErrorApi, noEncontrado } from "./errores.js";
import { rutasDispositivo } from "./rutas/dispositivo.js";
import { rutasVentas } from "./rutas/ventas.js";
import { claveFicticia, generarToken, hashearClave, hashNfc, hashToken, verificarClave } from "./seguridad.js";

const idParam = z.coerce.number().int().positive();
const DURACION_SESION_MS = 12 * 60 * 60 * 1000;

// Límites de intentos en las rutas de acceso. Se cuentan en preHandler para poder usar el cuerpo del pedido.
// Login: por IP y usuario, así un atacante no bloquea a todos los que salen por la misma IP (un proxy o el wifi del evento).
const LIMITE_LOGIN = {
  max: 10,
  timeWindow: "1 minute",
  hook: "preHandler" as const,
  keyGenerator: (req: FastifyRequest) => {
    const usuario = (req.body as { usuario?: unknown } | undefined)?.usuario;
    return `login:${req.ip}:${typeof usuario === "string" ? usuario.trim().toLowerCase() : ""}`;
  },
};
// NFC: por posnet, con margen para el cambio de turno. Una clave de dispositivo inventada no sirve para nada.
const LIMITE_NFC = {
  max: 60,
  timeWindow: "1 minute",
  hook: "preHandler" as const,
  keyGenerator: (req: FastifyRequest) => {
    const clave = req.headers["x-clave-dispositivo"];
    return typeof clave === "string" && clave ? `nfc:${hashToken(clave)}` : `nfc-ip:${req.ip}`;
  },
};
const LIMITE_REGISTRO = { max: 10, timeWindow: "1 minute" };

const TIENE_OPERACIONES = "Tiene ventas u operaciones registradas: no se puede borrar. Desactivalo en su lugar.";

type SesionActiva = {
  id: number;
  usuarioId: number;
  cuentaId: number;
  rol: Usuario["rol"];
  origen: "clave" | "nfc";
  puntoVentaId: number | null;
};

declare module "fastify" {
  interface FastifyRequest {
    sesion: SesionActiva;
  }
  interface FastifyContextConfig {
    publica?: boolean;
  }
}

type FilaUsuario = typeof usuarios.$inferSelect;
type FilaPuntoVenta = typeof puntosVenta.$inferSelect;

/** Lo que se muestra de un usuario: nunca los hashes de la clave ni de la tarjeta. */
const usuarioPublico = ({ claveHash, nfcHash, ...u }: FilaUsuario): Usuario => ({ ...u, tieneClave: claveHash !== null });

/** Lo que las rutas de cada módulo necesitan de la app: acceso a la base y los controles de permisos. */
export type Contexto = {
  db: Db;
  exigirConfiguracion: (req: FastifyRequest) => void;
  exigirSupervisor: (req: FastifyRequest) => void;
  /** Lee :eventoId de la ruta y verifica que el evento sea de la cuenta de la sesión. */
  eventoDeRuta: (req: FastifyRequest) => typeof eventos.$inferSelect;
};

export type OpcionesApp = {
  /** Permite crear cuentas nuevas. Si no hay ninguna cuenta, el registro siempre está abierto. */
  registroAbierto?: boolean;
  /** Activar cuando la API corre detrás de un proxy, para que la IP del cliente sea la real y no la del proxy. */
  trustProxy?: boolean;
};

export function crearApp(db: Db, opciones: OpcionesApp = {}) {
  const app = Fastify({ logger: false, trustProxy: opciones.trustProxy ?? false });
  app.register(cors);
  app.register(rateLimit, { global: false });
  app.decorateRequest("sesion", null as unknown as SesionActiva);

  app.setErrorHandler((err, _req, reply: FastifyReply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Datos inválidos", detalles: err.flatten().fieldErrors });
    }
    if (err instanceof ErrorApi) return reply.status(err.status).send({ error: err.message });
    const codigo = String((err as { code?: string }).code);
    if (codigo.startsWith("SQLITE_CONSTRAINT_UNIQUE")) {
      return reply.status(409).send({ error: "Ya existe un registro con ese valor" });
    }
    // Con ON DELETE RESTRICT, SQLite informa SQLITE_CONSTRAINT_TRIGGER en vez de SQLITE_CONSTRAINT_FOREIGNKEY.
    if (codigo.startsWith("SQLITE_CONSTRAINT") && (err as Error).message.includes("FOREIGN KEY")) {
      return reply.status(409).send({ error: TIENE_OPERACIONES });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: status === 500 ? "Error interno" : (err as Error).message });
  });

  // Las rutas van dentro de un plugin para que se registren después de rate-limit y lo tomen.
  app.register(async (app) => {
    // ---- Sesiones ----
    const ahora = () => new Date().toISOString();

    const crearSesion = (usuario: FilaUsuario, origen: "clave" | "nfc", puntoVentaId: number | null = null): Sesion => {
      const token = generarToken();
      const expira = new Date(Date.now() + DURACION_SESION_MS).toISOString();
      db.delete(sesiones).where(lte(sesiones.expira, ahora())).run();
      db.insert(sesiones)
        .values({ tokenHash: hashToken(token), usuarioId: usuario.id, origen, puntoVentaId, expira })
        .run();
      const cuenta = db
        .select({ id: cuentas.id, nombre: cuentas.nombre })
        .from(cuentas)
        .where(eq(cuentas.id, usuario.cuentaId))
        .get()!;
      return { token, expira, usuario: usuarioPublico(usuario), cuenta };
    };

    // Todas las rutas piden sesión salvo las marcadas como públicas.
    app.addHook("onRequest", async (req) => {
      if (req.routeOptions.config?.publica) return;
      const [tipo, token] = (req.headers.authorization ?? "").split(" ");
      if (tipo !== "Bearer" || !token) throw new ErrorApi(401, "Hace falta iniciar sesión");
      const fila = db
        .select({
          id: sesiones.id,
          usuarioId: usuarios.id,
          cuentaId: usuarios.cuentaId,
          rol: usuarios.rol,
          origen: sesiones.origen,
          puntoVentaId: sesiones.puntoVentaId,
        })
        .from(sesiones)
        .innerJoin(usuarios, eq(usuarios.id, sesiones.usuarioId))
        .where(and(eq(sesiones.tokenHash, hashToken(token)), gt(sesiones.expira, ahora()), eq(usuarios.activo, true)))
        .get();
      if (!fila) throw new ErrorApi(401, "La sesión venció o no es válida");
      req.sesion = fila;
    });

    const exigirConfiguracion = (req: FastifyRequest) => {
      if (req.sesion.origen !== "clave") {
        throw new ErrorApi(403, "Para cambiar la configuración entrá con usuario y clave");
      }
      if (!(ROLES_CONFIGURACION as readonly string[]).includes(req.sesion.rol)) {
        throw new ErrorApi(403, "Tu rol no puede cambiar la configuración");
      }
    };

    // Ver reportes y cargar stock es operar, no configurar: alcanza con el rol, aunque haya entrado con tarjeta.
    const exigirSupervisor = (req: FastifyRequest) => {
      if (!(ROLES_CONFIGURACION as readonly string[]).includes(req.sesion.rol)) {
        throw new ErrorApi(403, "Solo un supervisor o administrador puede ver esto");
      }
    };

    const exigirAdmin = (req: FastifyRequest) => {
      exigirConfiguracion(req);
      if (req.sesion.rol !== "admin") throw new ErrorApi(403, "Solo un administrador puede hacer esto");
    };

    const publica = { config: { publica: true } };

    app.get("/api/salud", publica, async () => ({ ok: true }));

    // ---- Registro y acceso ----
    const registroAbierto = () =>
      opciones.registroAbierto === true || db.select({ id: cuentas.id }).from(cuentas).limit(1).get() === undefined;

    app.get("/api/registro", publica, async () => ({ abierto: registroAbierto() }));

    app.post("/api/registro", { config: { publica: true, rateLimit: LIMITE_REGISTRO } }, async (req, reply) => {
      const datos = registroInput.parse(req.body);
      const claveHash = await hashearClave(datos.clave);
      // Chequeo e inserción en la misma transacción para que dos registros simultáneos no abran dos cuentas.
      const usuario = db.transaction((tx) => {
        if (!registroAbierto()) throw new ErrorApi(403, "El registro de cuentas nuevas está cerrado");
        const cuenta = tx.insert(cuentas).values({ nombre: datos.cuenta, creada: ahora() }).returning().get();
        return tx
          .insert(usuarios)
          .values({ cuentaId: cuenta.id, nombre: datos.nombre, usuario: datos.usuario, claveHash, rol: "admin" })
          .returning()
          .get();
      });
      return reply.status(201).send(crearSesion(usuario, "clave"));
    });

    app.post("/api/auth/login", { config: { publica: true, rateLimit: LIMITE_LOGIN } }, async (req) => {
      const { usuario, clave } = loginInput.parse(req.body);
      const fila = db.select().from(usuarios).where(eq(usuarios.usuario, usuario)).get();
      // Se verifica igual contra un hash ficticio para no revelar, por el tiempo de respuesta, si el usuario existe.
      const valida = await verificarClave(clave, fila?.claveHash ?? (await claveFicticia()));
      if (!fila || !fila.claveHash || !fila.activo || !valida) throw new ErrorApi(401, "Usuario o clave incorrectos");
      return crearSesion(fila, "clave");
    });

    // Acceso rápido en el posnet: el dispositivo manda su clave y el UID de la tarjeta apoyada.
    app.post("/api/auth/nfc", { config: { publica: true, rateLimit: LIMITE_NFC } }, async (req) => {
      const { nfcUid } = loginNfcInput.parse(req.body);
      const claveDispositivo = req.headers["x-clave-dispositivo"];
      if (typeof claveDispositivo !== "string" || !claveDispositivo) {
        throw new ErrorApi(401, "Este dispositivo no está vinculado a ningún punto de venta");
      }
      const pv = db
        .select({ id: puntosVenta.id, cuentaId: eventos.cuentaId })
        .from(dispositivos)
        .innerJoin(puntosVenta, eq(puntosVenta.id, dispositivos.puntoVentaId))
        .innerJoin(eventos, eq(eventos.id, puntosVenta.eventoId))
        .where(and(eq(dispositivos.claveHash, hashToken(claveDispositivo)), isNull(dispositivos.revocado)))
        .get();
      if (!pv) throw new ErrorApi(401, "Este dispositivo no está vinculado a ningún punto de venta");
      const fila = db
        .select()
        .from(usuarios)
        .where(and(eq(usuarios.nfcUid, nfcUid), eq(usuarios.cuentaId, pv.cuentaId), eq(usuarios.activo, true)))
        .get();
      if (!fila) throw new ErrorApi(401, "Tarjeta no registrada");
      return crearSesion(fila, "nfc", pv.id);
    });

    app.post("/api/auth/salir", async (req, reply) => {
      db.delete(sesiones).where(eq(sesiones.id, req.sesion.id)).run();
      return reply.status(204).send();
    });

    app.get("/api/yo", async (req) => {
      const fila = db.select().from(usuarios).where(eq(usuarios.id, req.sesion.usuarioId)).get()!;
      const cuenta = db
        .select({ id: cuentas.id, nombre: cuentas.nombre })
        .from(cuentas)
        .where(eq(cuentas.id, req.sesion.cuentaId))
        .get()!;
      return {
        usuario: usuarioPublico(fila),
        cuenta,
        origen: req.sesion.origen,
        puntoVentaId: req.sesion.puntoVentaId,
      };
    });

    // ---- Usuarios de la cuenta ----
    const buscarUsuario = (id: number, cuentaId: number) => {
      const fila = db
        .select()
        .from(usuarios)
        .where(and(eq(usuarios.id, id), eq(usuarios.cuentaId, cuentaId)))
        .get();
      if (!fila) throw noEncontrado("Usuario");
      return fila;
    };

    // Un usuario que vendió, autorizó o canjeó algo queda en los reportes: no se borra, se desactiva.
    const usuarioConActividad = (id: number) =>
      [
        db.select({ x: operaciones.id }).from(operaciones).where(eq(operaciones.usuarioId, id)),
        db.select({ x: ventas.id }).from(ventas).where(or(eq(ventas.usuarioId, id), eq(ventas.autorizadoPorId, id))),
        db
          .select({ x: turnos.id })
          .from(turnos)
          .where(or(eq(turnos.usuarioId, id), eq(turnos.entregadoPorId, id), eq(turnos.cerradoPorId, id))),
        db
          .select({ x: anulaciones.id })
          .from(anulaciones)
          .where(or(eq(anulaciones.usuarioId, id), eq(anulaciones.autorizadoPorId, id))),
        db
          .select({ x: movimientosCaja.id })
          .from(movimientosCaja)
          .where(or(eq(movimientosCaja.usuarioId, id), eq(movimientosCaja.autorizadoPorId, id))),
        db.select({ x: canjes.id }).from(canjes).where(eq(canjes.usuarioId, id)),
        db.select({ x: movimientosStock.id }).from(movimientosStock).where(eq(movimientosStock.usuarioId, id)),
      ].some((q) => q.limit(1).get() !== undefined);

    app.get("/api/usuarios", async (req) => {
      exigirAdmin(req);
      return db.select().from(usuarios).where(eq(usuarios.cuentaId, req.sesion.cuentaId)).all().map(usuarioPublico);
    });

    app.post("/api/usuarios", async (req, reply) => {
      exigirAdmin(req);
      const { clave, ...datos } = usuarioInput.parse(req.body);
      const claveHash = clave === undefined ? null : await hashearClave(clave);
      const nfcHash = datos.nfcUid ? await hashNfc(req.sesion.cuentaId, datos.nfcUid) : null;
      const creado = db
        .insert(usuarios)
        .values({ ...datos, claveHash, nfcHash, cuentaId: req.sesion.cuentaId })
        .returning()
        .get();
      return reply.status(201).send(usuarioPublico(creado));
    });

    app.patch("/api/usuarios/:id", async (req) => {
      exigirAdmin(req);
      const id = idParam.parse((req.params as { id: string }).id);
      const actual = buscarUsuario(id, req.sesion.cuentaId);
      const { clave, ...cambios } = usuarioInput.partial().parse(req.body);
      if (id === req.sesion.usuarioId && ((cambios.rol && cambios.rol !== "admin") || cambios.activo === false)) {
        throw new ErrorApi(400, "No podés quitarte a vos mismo el acceso de administrador");
      }
      const set: Partial<FilaUsuario> = { ...cambios };
      if (clave !== undefined) set.claveHash = await hashearClave(clave);
      if (cambios.nfcUid !== undefined) {
        set.nfcHash = cambios.nfcUid ? await hashNfc(req.sesion.cuentaId, cambios.nfcUid) : null;
      }
      if (Object.keys(set).length === 0) return usuarioPublico(actual);
      const actualizado = db.update(usuarios).set(set).where(eq(usuarios.id, id)).returning().get();
      // Si cambió algo del acceso, se cierran sus otras sesiones.
      if (
        clave !== undefined ||
        cambios.rol !== undefined ||
        cambios.activo !== undefined ||
        cambios.nfcUid !== undefined
      ) {
        db.delete(sesiones)
          .where(and(eq(sesiones.usuarioId, id), ne(sesiones.id, req.sesion.id)))
          .run();
      }
      return usuarioPublico(actualizado);
    });

    app.delete("/api/usuarios/:id", async (req, reply) => {
      exigirAdmin(req);
      const id = idParam.parse((req.params as { id: string }).id);
      if (id === req.sesion.usuarioId) throw new ErrorApi(400, "No podés borrar tu propio usuario");
      buscarUsuario(id, req.sesion.cuentaId);
      if (usuarioConActividad(id)) throw new ErrorApi(409, TIENE_OPERACIONES);
      db.delete(usuarios).where(eq(usuarios.id, id)).run();
      return reply.status(204).send();
    });

    // ---- Eventos ----
    const buscarEvento = (id: number, cuentaId: number) => {
      const evento = db
        .select()
        .from(eventos)
        .where(and(eq(eventos.id, id), eq(eventos.cuentaId, cuentaId)))
        .get();
      if (!evento) throw noEncontrado("Evento");
      return evento;
    };

    const validarEvento = (e: { inicio: string; fin: string; valesValidez: string; valesVencimiento: string | null }) => {
      if (new Date(e.fin) <= new Date(e.inicio)) throw new ErrorApi(400, "El fin tiene que ser posterior al inicio");
      if (e.valesValidez === "fecha") {
        if (!e.valesVencimiento) throw new ErrorApi(400, "Indicá hasta cuándo sirven los vales");
        if (new Date(e.valesVencimiento) <= new Date(e.inicio)) {
          throw new ErrorApi(400, "El vencimiento de los vales tiene que ser posterior al inicio del evento");
        }
      }
    };

    app.get("/api/eventos", async (req) =>
      db.select().from(eventos).where(eq(eventos.cuentaId, req.sesion.cuentaId)).all(),
    );

    app.get("/api/eventos/:id", async (req) =>
      buscarEvento(idParam.parse((req.params as { id: string }).id), req.sesion.cuentaId),
    );

    app.post("/api/eventos", async (req, reply) => {
      exigirConfiguracion(req);
      const datos = eventoInput.parse(req.body);
      validarEvento(datos);
      const creado = db
        .insert(eventos)
        .values({ ...datos, cuentaId: req.sesion.cuentaId })
        .returning()
        .get();
      return reply.status(201).send(creado);
    });

    app.patch("/api/eventos/:id", async (req) => {
      exigirConfiguracion(req);
      const id = idParam.parse((req.params as { id: string }).id);
      const actual = buscarEvento(id, req.sesion.cuentaId);
      const cambios = eventoInput.partial().parse(req.body);
      validarEvento({ ...actual, ...cambios });
      if (Object.keys(cambios).length === 0) return actual;
      return db.update(eventos).set(cambios).where(eq(eventos.id, id)).returning().get();
    });

    app.delete("/api/eventos/:id", async (req, reply) => {
      exigirConfiguracion(req);
      const id = idParam.parse((req.params as { id: string }).id);
      buscarEvento(id, req.sesion.cuentaId);
      db.delete(eventos).where(eq(eventos.id, id)).run();
      return reply.status(204).send();
    });

    // ---- Recursos que pertenecen a un evento ----
    // Cada referencia (sectorId, impresoraId) tiene que apuntar a algo del mismo evento.
    type TablaDeEvento = SQLiteTable & { id: any; eventoId: any };
    type Referencias = Record<string, { tabla: TablaDeEvento; nombre: string }>;

    const params = (req: FastifyRequest) => {
      const p = req.params as { eventoId: string; id?: string };
      const eventoId = idParam.parse(p.eventoId);
      buscarEvento(eventoId, req.sesion.cuentaId);
      return { eventoId, id: p.id === undefined ? undefined : idParam.parse(p.id) };
    };

    const recursoDeEvento = (
      ruta: string,
      nombre: string,
      tabla: TablaDeEvento,
      schema: z.ZodObject<Record<string, ZodTypeAny>>,
      {
        referencias = {},
        serializar = (f: any) => f,
        antesDeBorrar,
      }: {
        referencias?: Referencias;
        serializar?: (fila: any) => unknown;
        /** Para frenar el borrado de algo que ya se usó en ventas. */
        antesDeBorrar?: (id: number) => void;
      } = {},
    ) => {
      const base = `/api/eventos/:eventoId/${ruta}`;
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
        return db.select().from(tabla).where(eq(tabla.eventoId, eventoId)).all().map(serializar);
      });

      app.post(base, async (req, reply) => {
        exigirConfiguracion(req);
        const { eventoId } = params(req);
        const datos = schema.parse(req.body);
        validarReferencias(eventoId, datos);
        const creado = db
          .insert(tabla)
          .values({ ...datos, eventoId } as any)
          .returning()
          .get();
        return reply.status(201).send(serializar(creado));
      });

      app.patch(`${base}/:id`, async (req) => {
        exigirConfiguracion(req);
        const { eventoId, id } = params(req);
        const cambios = schema.partial().parse(req.body);
        validarReferencias(eventoId, cambios);
        const actualizado =
          Object.keys(cambios).length === 0
            ? db.select().from(tabla).where(filtro(eventoId, id!)).get()
            : db
                .update(tabla)
                .set(cambios as any)
                .where(filtro(eventoId, id!))
                .returning()
                .get();
        if (!actualizado) throw noEncontrado(nombre);
        return serializar(actualizado);
      });

      app.delete(`${base}/:id`, async (req, reply) => {
        exigirConfiguracion(req);
        const { eventoId, id } = params(req);
        if (!db.select({ id: tabla.id }).from(tabla).where(filtro(eventoId, id!)).get()) throw noEncontrado(nombre);
        antesDeBorrar?.(id!);
        const borrado = db.delete(tabla).where(filtro(eventoId, id!)).returning().get();
        if (!borrado) throw noEncontrado(nombre);
        return reply.status(204).send();
      });
    };

    recursoDeEvento("impresoras", "Impresora", impresoras, impresoraInput);
    recursoDeEvento("sectores", "Sector", sectores, sectorInput, {
      referencias: { impresoraId: { tabla: impresoras, nombre: "La impresora" } },
    });
    recursoDeEvento("productos", "Producto", productos, productoInput, {
      referencias: { sectorId: { tabla: sectores, nombre: "El sector" } },
      antesDeBorrar: (id) => {
        const usado =
          db.select({ x: ventaItems.id }).from(ventaItems).where(eq(ventaItems.productoId, id)).limit(1).get() ??
          db.select({ x: vales.id }).from(vales).where(eq(vales.productoId, id)).limit(1).get() ??
          db.select({ x: canjes.id }).from(canjes).where(or(eq(canjes.productoId, id), eq(canjes.productoValeId, id))).limit(1).get();
        if (usado) throw new ErrorApi(409, TIENE_OPERACIONES);
      },
    });

    const dispositivoActivo = (puntoVentaId: number) =>
      db
        .select({ id: dispositivos.id, creado: dispositivos.creado, ultimaSincronizacion: dispositivos.ultimaSincronizacion })
        .from(dispositivos)
        .where(and(eq(dispositivos.puntoVentaId, puntoVentaId), isNull(dispositivos.revocado)))
        .get();
    const puntoVentaPublico = (pv: FilaPuntoVenta) => {
      const disp = dispositivoActivo(pv.id);
      return { ...pv, dispositivoVinculado: disp !== undefined, ultimaSincronizacion: disp?.ultimaSincronizacion ?? null };
    };
    recursoDeEvento("puntos-venta", "Punto de venta", puntosVenta, puntoVentaInput, {
      referencias: { sectorId: { tabla: sectores, nombre: "El sector" } },
      serializar: puntoVentaPublico,
    });

    // Vincula un posnet al punto de venta. La clave se muestra una sola vez y se carga en la app del posnet.
    // Si ya había uno vinculado, queda revocado: no entra ni baja configuración, pero puede terminar de subir lo que vendió.
    const revocar = (puntoVentaId: number) => {
      db.update(dispositivos)
        .set({ revocado: ahora() })
        .where(and(eq(dispositivos.puntoVentaId, puntoVentaId), isNull(dispositivos.revocado)))
        .run();
      db.delete(sesiones).where(eq(sesiones.puntoVentaId, puntoVentaId)).run();
    };

    const puntoDeVentaDeRuta = (req: FastifyRequest) => {
      const { eventoId, id } = params(req);
      const pv = db
        .select({ id: puntosVenta.id })
        .from(puntosVenta)
        .where(and(eq(puntosVenta.id, id!), eq(puntosVenta.eventoId, eventoId)))
        .get();
      if (!pv) throw noEncontrado("Punto de venta");
      return pv.id;
    };

    app.post("/api/eventos/:eventoId/puntos-venta/:id/dispositivo", async (req) => {
      exigirAdmin(req);
      const puntoVentaId = puntoDeVentaDeRuta(req);
      const claveDispositivo = generarToken();
      const dispositivoId = randomUUID();
      db.transaction(() => {
        revocar(puntoVentaId);
        db.insert(dispositivos)
          .values({ id: dispositivoId, puntoVentaId, claveHash: hashToken(claveDispositivo), creado: ahora() })
          .run();
      });
      return { claveDispositivo, dispositivoId };
    });

    app.delete("/api/eventos/:eventoId/puntos-venta/:id/dispositivo", async (req, reply) => {
      exigirAdmin(req);
      revocar(puntoDeVentaDeRuta(req));
      return reply.status(204).send();
    });

    const contexto: Contexto = {
      db,
      exigirConfiguracion,
      exigirSupervisor,
      eventoDeRuta: (req) => buscarEvento(params(req).eventoId, req.sesion.cuentaId),
    };
    rutasVentas(app, contexto);
    rutasDispositivo(app, db);
  });

  return app;
}
