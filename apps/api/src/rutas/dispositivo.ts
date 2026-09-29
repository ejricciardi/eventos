import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { z } from "zod";
import { claveProducto, imprimeVales, sincronizacionInput, vencimientoVales } from "@eventos/shared";
import type { Db } from "../db/index.js";
import {
  dispositivos,
  eventos,
  impresoras,
  operaciones,
  productos,
  puntosVenta,
  sectores,
  usuarios,
  vales,
} from "../db/schema.js";
import { ErrorApi } from "../errores.js";
import { hashToken, parametrosNfc } from "../seguridad.js";
import { clavePublicaValida, leerQr, type QrLeido } from "../ventas/firma.js";
import { canjePrevio, evaluarCanje, procesarOperacion, type Dispositivo } from "../ventas/procesar.js";
import { stockActual } from "../ventas/reportes.js";

// Rutas que usa la app del posnet. No van con sesión de usuario sino con la clave del dispositivo
// (header x-clave-dispositivo), porque el posnet trabaja sin conexión y sube lo que hizo cuando puede.

const LIMITE_DISPOSITIVO = {
  max: 300,
  timeWindow: "1 minute",
  keyGenerator: (req: FastifyRequest) => {
    const clave = req.headers["x-clave-dispositivo"];
    return typeof clave === "string" && clave ? `disp:${hashToken(clave)}` : `disp-ip:${req.ip}`;
  },
};

/** Observaciones de un canje por las que la barra no tiene que entregar. */
export const MOTIVOS_PARA_NO_ENTREGAR = [
  "firma_invalida",
  "vale_de_otra_cuenta",
  "vale_de_otro_evento",
  "producto_no_equivalente",
  "vale_vencido",
  "otro_sector",
  "vale_anulado",
  "canje_duplicado",
  "canje_en_curso",
] as const;

// Mientras una barra consulta un vale y entrega, otra no lo puede canjear. Dura lo que tarda en subir el canje.
const RESERVA_CANJE_MS = 60_000;

export function rutasDispositivo(app: FastifyInstance, db: Db) {
  const config = { config: { publica: true, rateLimit: LIMITE_DISPOSITIVO } };
  // Clave: cuenta, evento del vale e id del vale (el id solo no alcanza: lo genera el posnet y está impreso en el QR).
  const reservas = new Map<string, { dispositivoId: string; hasta: number }>();
  const claveReserva = (cuentaId: number, qr: QrLeido) => `${cuentaId}:${qr.contenido.e}:${qr.contenido.i}`;

  const dispositivoDeClave = (req: FastifyRequest, { permitirRevocado = false } = {}): Dispositivo => {
    const clave = req.headers["x-clave-dispositivo"];
    if (typeof clave !== "string" || !clave) throw new ErrorApi(401, "Falta la clave del dispositivo");
    const fila = db
      .select({
        id: dispositivos.id,
        puntoVentaId: dispositivos.puntoVentaId,
        eventoId: puntosVenta.eventoId,
        cuentaId: eventos.cuentaId,
        revocado: dispositivos.revocado,
        clavePublica: dispositivos.clavePublica,
        tipoPuntoVenta: puntosVenta.tipo,
        sectorPuntoVenta: puntosVenta.sectorId,
      })
      .from(dispositivos)
      .innerJoin(puntosVenta, eq(puntosVenta.id, dispositivos.puntoVentaId))
      .innerJoin(eventos, eq(eventos.id, puntosVenta.eventoId))
      .where(eq(dispositivos.claveHash, hashToken(clave)))
      .get();
    if (!fila) throw new ErrorApi(401, "Este dispositivo no está vinculado a ningún punto de venta");
    // Un posnet desvinculado todavía puede subir lo que vendió, pero nada más.
    if (fila.revocado && !permitirRevocado) {
      throw new ErrorApi(401, "Este posnet fue desvinculado. Volvé a vincularlo desde el panel.");
    }
    db.update(dispositivos).set({ ultimoContacto: new Date().toISOString() }).where(eq(dispositivos.id, fila.id)).run();
    return fila;
  };

  /** Todo lo que el posnet necesita para vender y canjear sin conexión. */
  app.get("/api/dispositivo/configuracion", config, async (req) => {
    const disp = dispositivoDeClave(req);
    const evento = db.select().from(eventos).where(eq(eventos.id, disp.eventoId)).get()!;
    const pv = db.select().from(puntosVenta).where(eq(puntosVenta.id, disp.puntoVentaId)).get()!;
    const stock = stockActual(db, evento.id);
    const todos = db.select().from(productos).where(eq(productos.eventoId, evento.id)).all();

    // Eventos de la cuenta cuyos vales se pueden canjear acá: este y los que tienen vales sin vencimiento.
    const eventosCanjeables = db
      .select({ id: eventos.id })
      .from(eventos)
      .where(
        and(eq(eventos.cuentaId, disp.cuentaId), or(eq(eventos.id, evento.id), eq(eventos.valesValidez, "sin_vencimiento"))),
      )
      .all()
      .map((e) => e.id);
    const otrosEventos = eventosCanjeables.filter((id) => id !== evento.id);

    // Para vales sin vencimiento de otros eventos: qué producto de este evento se entrega por cada uno
    // (el mismo criterio que productoEquivalente: por código o nombre, prefiriendo uno disponible).
    const aca = new Map<string, number>();
    for (const p of [...todos].sort((a, b) => Number(b.activo) - Number(a.activo))) {
      if (!aca.has(claveProducto(p))) aca.set(claveProducto(p), p.id);
    }
    const equivalencias =
      otrosEventos.length === 0
        ? []
        : db
            .select()
            .from(productos)
            .where(inArray(productos.eventoId, otrosEventos))
            .all()
            .flatMap((p) => {
              const productoId = aca.get(claveProducto(p));
              return productoId === undefined ? [] : [{ eventoId: p.eventoId, productoValeId: p.id, productoId }];
            });

    const cuerpo = {
      dispositivoId: disp.id,
      evento: {
        id: evento.id,
        nombre: evento.nombre,
        lugar: evento.lugar,
        inicio: evento.inicio,
        fin: evento.fin,
        modoVenta: evento.modoVenta,
        valesValidez: evento.valesValidez,
        vencimientoVales: vencimientoVales(evento),
        minutosAnulacionCajero: evento.minutosAnulacionCajero,
      },
      puntoVenta: {
        id: pv.id,
        nombre: pv.nombre,
        plataforma: pv.plataforma,
        tipo: pv.tipo,
        sectorId: pv.sectorId,
        vistaProductos: pv.vistaProductos,
        imprimeTicket: pv.imprimeTicket,
        imprimeVales: imprimeVales(evento, pv),
      },
      productos: todos
        .filter((p) => p.activo)
        .map((p) => {
          const actual = p.controlaStock ? (stock.get(p.id) ?? 0) : null;
          return {
            id: p.id,
            nombre: p.nombre,
            codigo: p.codigo,
            categoria: p.categoria,
            precio: p.precio,
            sectorId: p.sectorId,
            controlaStock: p.controlaStock,
            stock: actual,
            agotado: actual !== null && actual <= 0,
          };
        }),
      sectores: db.select().from(sectores).where(eq(sectores.eventoId, evento.id)).all(),
      impresoras: db.select().from(impresoras).where(eq(impresoras.eventoId, evento.id)).all(),
      // Personal activo de la cuenta. La tarjeta viaja como hash lento: el posnet calcula el de la tarjeta apoyada y compara.
      nfc: parametrosNfc(disp.cuentaId),
      personal: db
        .select({ id: usuarios.id, nombre: usuarios.nombre, rol: usuarios.rol, nfcHash: usuarios.nfcHash })
        .from(usuarios)
        .where(and(eq(usuarios.cuentaId, disp.cuentaId), eq(usuarios.activo, true)))
        .all(),
      // Claves públicas para verificar la firma de los vales que se pueden canjear acá (incluye posnets ya desvinculados).
      clavesPublicas: db
        .select({ dispositivoId: dispositivos.id, eventoId: puntosVenta.eventoId, clavePublica: dispositivos.clavePublica })
        .from(dispositivos)
        .innerJoin(puntosVenta, eq(puntosVenta.id, dispositivos.puntoVentaId))
        .where(and(inArray(puntosVenta.eventoId, eventosCanjeables), isNotNull(dispositivos.clavePublica)))
        .all(),
      equivalencias,
      valesAnulados: db
        .select({ id: vales.id })
        .from(vales)
        .where(and(inArray(vales.eventoId, eventosCanjeables), eq(vales.estado, "anulado")))
        .all()
        .map((v) => v.id),
    };
    const version = createHash("sha256").update(JSON.stringify(cuerpo)).digest("hex").slice(0, 16);
    return { version, servidorHora: new Date().toISOString(), ...cuerpo };
  });

  /** El posnet registra una sola vez la clave pública con la que firma los vales. */
  app.post("/api/dispositivo/clave-publica", config, async (req) => {
    const disp = dispositivoDeClave(req);
    const { clavePublica } = z.object({ clavePublica: z.string().trim().min(1).max(200) }).parse(req.body);
    if (!clavePublicaValida(clavePublica)) throw new ErrorApi(400, "La clave pública tiene que ser Ed25519 (SPKI en base64)");
    if (disp.clavePublica !== null) {
      if (disp.clavePublica === clavePublica) return { ok: true };
      // Cambiarla invalidaría los vales ya impresos: para eso se vuelve a vincular el posnet.
      throw new ErrorApi(409, "Este posnet ya registró su clave. Para cambiarla, volvé a vincularlo desde el panel.");
    }
    db.update(dispositivos).set({ clavePublica }).where(eq(dispositivos.id, disp.id)).run();
    return { ok: true };
  });

  /**
   * Sube las operaciones guardadas en el posnet. Cada una se procesa por separado: una mal armada no frena al resto.
   * Devuelve el resultado de cada una y hasta qué secuencia llegó todo sin huecos (lo anterior el posnet ya lo puede borrar).
   */
  app.post(
    "/api/dispositivo/sincronizar",
    { ...config, bodyLimit: 10 * 1024 * 1024 },
    async (req) => {
      const disp = dispositivoDeClave(req, { permitirRevocado: true });
      const { reloj, operaciones: lista } = sincronizacionInput.parse(req.body);
      const recibida = new Date().toISOString();
      db.update(dispositivos)
        .set({ ultimaSincronizacion: recibida, desfaseMs: Date.parse(reloj) - Date.parse(recibida) })
        .where(eq(dispositivos.id, disp.id))
        .run();

      // En orden de secuencia, así la apertura de un turno se procesa antes que sus ventas.
      const seqDe = (o: unknown) => {
        const seq = (o as { seq?: unknown } | null)?.seq;
        return typeof seq === "number" ? seq : Number.MAX_SAFE_INTEGER;
      };
      const resultados = lista
        .map((crudo, i) => ({ crudo, i }))
        .sort((a, b) => seqDe(a.crudo) - seqDe(b.crudo) || a.i - b.i)
        .map(({ crudo, i }) => ({ i, resultado: procesarOperacion(db, disp, crudo, recibida) }))
        .sort((a, b) => a.i - b.i)
        .map((r) => r.resultado);

      // Los vales que se acaban de canjear ya no necesitan reserva: desde ahora figuran como canjeados.
      for (const crudo of lista) {
        const canje = crudo as { tipo?: unknown; qr?: unknown } | null;
        if (canje?.tipo === "canje" && typeof canje.qr === "string") {
          const qr = leerQr(canje.qr);
          if (qr) reservas.delete(claveReserva(disp.cuentaId, qr));
        }
      }

      return { resultados, ultimaSeqContigua: ultimaSeqContigua(disp.id), servidorHora: recibida };
    },
  );

  const ultimaSeqContigua = (dispositivoId: string) => {
    let ultima = 0;
    for (const { seq } of db
      .select({ seq: operaciones.seq })
      .from(operaciones)
      .where(eq(operaciones.dispositivoId, dispositivoId))
      .orderBy(operaciones.seq)
      .all()) {
      if (seq !== ultima + 1) break;
      ultima = seq;
    }
    return ultima;
  };

  /**
   * Consulta un vale antes de entregar, con conexión. No registra el canje (eso lo hace la operación de canje
   * que sube la barra), pero lo reserva un minuto para que otra barra no lo entregue a la vez.
   */
  app.post("/api/dispositivo/canjes/consultar", config, async (req) => {
    const disp = dispositivoDeClave(req);
    const { qr: texto } = z.object({ qr: z.string().min(1).max(1000) }).parse(req.body);
    const qr = leerQr(texto);
    if (!qr) return { entregar: false, motivos: ["qr_invalido"], observaciones: ["qr_invalido"] };

    const ahora = Date.now();
    const evaluacion = evaluarCanje(db, disp, qr, new Date(ahora).toISOString());
    const observaciones = [...evaluacion.observaciones];
    const clave = claveReserva(disp.cuentaId, qr);
    const reserva = reservas.get(clave);
    if (reserva && reserva.hasta > ahora && reserva.dispositivoId !== disp.id) observaciones.push("canje_en_curso");

    const motivos = observaciones.filter((o) => (MOTIVOS_PARA_NO_ENTREGAR as readonly string[]).includes(o));
    const entregar = motivos.length === 0;
    if (entregar) {
      for (const [id, r] of reservas) if (r.hasta <= ahora) reservas.delete(id);
      reservas.set(clave, { dispositivoId: disp.id, hasta: ahora + RESERVA_CANJE_MS });
    }

    const producto =
      evaluacion.productoId === null
        ? null
        : (db
            .select({ id: productos.id, nombre: productos.nombre })
            .from(productos)
            .where(and(eq(productos.id, evaluacion.productoId), eq(productos.eventoId, disp.eventoId)))
            .get() ?? null);
    // Si ya se canjeó, dónde y cuándo, para que la barra se lo pueda decir al cliente.
    const previo = observaciones.includes("canje_duplicado")
      ? canjePrevio(db, disp.cuentaId, qr.contenido.e, qr.contenido.i)
      : undefined;
    const canjePrevioInfo = previo
      ? {
          creada: previo.creada,
          puntoVenta:
            db.select({ nombre: puntosVenta.nombre }).from(puntosVenta).where(eq(puntosVenta.id, previo.puntoVentaId)).get()
              ?.nombre ?? null,
        }
      : null;
    return { entregar, motivos, observaciones, valeId: qr.contenido.i, producto, canjePrevio: canjePrevioInfo };
  });
}
