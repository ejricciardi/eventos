import { sqliteTable, integer, text, uniqueIndex, index, primaryKey } from "drizzle-orm/sqlite-core";
import {
  MEDIOS_PAGO,
  MODOS_VENTA,
  MOTIVOS_ANULACION,
  PLATAFORMAS,
  ROLES,
  TIPOS_MOVIMIENTO_CAJA,
  TIPOS_MOVIMIENTO_STOCK,
  TIPOS_PUNTO_VENTA,
  VALIDEZ_VALES,
  VISTAS_PRODUCTOS,
} from "@eventos/shared";

/** Cuenta de un organizador. Todo lo demás cuelga de una cuenta. */
export const cuentas = sqliteTable("cuentas", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  nombre: text("nombre").notNull(),
  creada: text("creada").notNull(),
});

export const eventos = sqliteTable("eventos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cuentaId: integer("cuenta_id")
    .notNull()
    .references(() => cuentas.id, { onDelete: "cascade" }),
  nombre: text("nombre").notNull(),
  lugar: text("lugar"),
  inicio: text("inicio").notNull(),
  fin: text("fin").notNull(),
  modoVenta: text("modo_venta", { enum: MODOS_VENTA }).notNull().default("vales"),
  valesValidez: text("vales_validez", { enum: VALIDEZ_VALES }).notNull().default("fin_evento"),
  valesVencimiento: text("vales_vencimiento"),
  minutosAnulacionCajero: integer("minutos_anulacion_cajero").notNull().default(5),
});

const eventoId = () =>
  integer("evento_id")
    .notNull()
    .references(() => eventos.id, { onDelete: "cascade" });

export const impresoras = sqliteTable("impresoras", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventoId: eventoId(),
  nombre: text("nombre").notNull(),
  host: text("host").notNull(),
  puerto: integer("puerto").notNull().default(9100),
  anchoPapel: integer("ancho_papel").notNull().default(80),
});

export const sectores = sqliteTable("sectores", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventoId: eventoId(),
  nombre: text("nombre").notNull(),
  impresoraId: integer("impresora_id").references(() => impresoras.id, { onDelete: "set null" }),
});

export const productos = sqliteTable("productos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventoId: eventoId(),
  nombre: text("nombre").notNull(),
  codigo: text("codigo"),
  categoria: text("categoria"),
  precio: integer("precio").notNull(),
  sectorId: integer("sector_id").references(() => sectores.id, { onDelete: "set null" }),
  activo: integer("activo", { mode: "boolean" }).notNull().default(true),
  controlaStock: integer("controla_stock", { mode: "boolean" }).notNull().default(false),
});

export const puntosVenta = sqliteTable("puntos_venta", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventoId: eventoId(),
  nombre: text("nombre").notNull(),
  plataforma: text("plataforma", { enum: PLATAFORMAS }).notNull(),
  imprimeVales: integer("imprime_vales", { mode: "boolean" }),
  imprimeTicket: integer("imprime_ticket", { mode: "boolean" }).notNull().default(true),
  tipo: text("tipo", { enum: TIPOS_PUNTO_VENTA }).notNull().default("caja"),
  sectorId: integer("sector_id").references(() => sectores.id, { onDelete: "set null" }),
  vistaProductos: text("vista_productos", { enum: VISTAS_PRODUCTOS }).notNull().default("lista"),
});

/**
 * Un posnet vinculado a un punto de venta. Al volver a vincular, el anterior queda revocado:
 * ya no entra ni baja configuración, pero puede terminar de subir lo que vendió.
 */
export const dispositivos = sqliteTable("dispositivos", {
  id: text("id").primaryKey(),
  puntoVentaId: integer("punto_venta_id")
    .notNull()
    .references(() => puntosVenta.id, { onDelete: "cascade" }),
  // Hash de la clave con la que el posnet se identifica.
  claveHash: text("clave_hash").notNull().unique(),
  // Clave pública Ed25519 (SPKI en base64) con la que se verifican los vales que firma.
  clavePublica: text("clave_publica"),
  creado: text("creado").notNull(),
  revocado: text("revocado"),
  ultimaSincronizacion: text("ultima_sincronizacion"),
  // Última vez que el posnet habló con el servidor por cualquier motivo (bajar configuración, subir, consultar).
  ultimoContacto: text("ultimo_contacto"),
  // Cuánto adelanta (+) o atrasa (-) el reloj del posnet respecto del servidor.
  desfaseMs: integer("desfase_ms"),
});

export const usuarios = sqliteTable(
  "usuarios",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    cuentaId: integer("cuenta_id")
      .notNull()
      .references(() => cuentas.id, { onDelete: "cascade" }),
    nombre: text("nombre").notNull(),
    usuario: text("usuario").notNull(),
    claveHash: text("clave_hash"),
    rol: text("rol", { enum: ROLES }).notNull(),
    nfcUid: text("nfc_uid"),
    // Hash lento del UID (ver hashNfc): es lo que baja al posnet para validar la tarjeta sin conexión.
    nfcHash: text("nfc_hash"),
    activo: integer("activo", { mode: "boolean" }).notNull().default(true),
  },
  // El usuario es único en todo el sistema porque el login no pide la cuenta.
  // La tarjeta es única dentro de cada cuenta: la misma persona puede trabajar para dos organizadores.
  (t) => [
    uniqueIndex("usuarios_usuario_unico").on(t.usuario),
    uniqueIndex("usuarios_nfc_uid_unico").on(t.cuentaId, t.nfcUid),
  ],
);

export const sesiones = sqliteTable(
  "sesiones",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // Se guarda el hash del token, nunca el token.
    tokenHash: text("token_hash").notNull(),
    usuarioId: integer("usuario_id")
      .notNull()
      .references(() => usuarios.id, { onDelete: "cascade" }),
    origen: text("origen", { enum: ["clave", "nfc"] }).notNull(),
    puntoVentaId: integer("punto_venta_id").references(() => puntosVenta.id, { onDelete: "cascade" }),
    expira: text("expira").notNull(),
  },
  (t) => [uniqueIndex("sesiones_token_unico").on(t.tokenHash)],
);

// ---- Operaciones que suben los posnets ----
// Desde acá, nada se borra en cascada: si un evento, punto de venta o posnet tiene operaciones, no se puede borrar.

const eventoOp = () =>
  integer("evento_id")
    .notNull()
    .references(() => eventos.id, { onDelete: "restrict" });
const dispositivoOp = () =>
  text("dispositivo_id")
    .notNull()
    .references(() => dispositivos.id, { onDelete: "restrict" });

/** Registro de todo lo que subió cada posnet, tal cual llegó, con lo que el servidor observó. */
export const operaciones = sqliteTable(
  "operaciones",
  {
    id: text("id").primaryKey(),
    dispositivoId: dispositivoOp(),
    eventoId: eventoOp(),
    seq: integer("seq").notNull(),
    tipo: text("tipo").notNull(),
    usuarioId: integer("usuario_id"),
    payload: text("payload").notNull(),
    hash: text("hash").notNull(),
    estado: text("estado", { enum: ["ok", "invalida"] }).notNull(),
    error: text("error"),
    observaciones: text("observaciones", { mode: "json" }).$type<string[]>().notNull().default([]),
    creada: text("creada").notNull(),
    recibida: text("recibida").notNull(),
  },
  (t) => [uniqueIndex("operaciones_dispositivo_seq").on(t.dispositivoId, t.seq), index("operaciones_evento").on(t.eventoId)],
);

/** Operaciones que llegaron con un id o una secuencia ya usados pero con otros datos. */
export const conflictos = sqliteTable("conflictos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  operacionId: text("operacion_id").notNull(),
  dispositivoId: dispositivoOp(),
  eventoId: eventoOp(),
  seq: integer("seq"),
  payload: text("payload").notNull(),
  recibida: text("recibida").notNull(),
});

export const turnos = sqliteTable("turnos", {
  id: text("id").primaryKey(),
  eventoId: eventoOp(),
  dispositivoId: dispositivoOp(),
  puntoVentaId: integer("punto_venta_id").notNull(),
  usuarioId: integer("usuario_id").notNull(),
  fondoInicial: integer("fondo_inicial").notNull(),
  entregadoPorId: integer("entregado_por_id"),
  abierto: text("abierto").notNull(),
  cerrado: text("cerrado"),
  cerradoPorId: integer("cerrado_por_id"),
  efectivoDeclarado: integer("efectivo_declarado"),
  cantidadVentasDeclarada: integer("cantidad_ventas_declarada"),
  totalesDeclarados: text("totales_declarados", { mode: "json" }).$type<Record<string, number>>(),
  // Secuencia de la operación de cierre y posnet que la hizo: todo lo anterior de ese posnet tiene que haber llegado.
  seqCierre: integer("seq_cierre"),
  dispositivoCierreId: text("dispositivo_cierre_id"),
  // false si el turno se conoció por su cierre y la apertura todavía no llegó.
  aperturaRecibida: integer("apertura_recibida", { mode: "boolean" }).notNull().default(true),
});

export const ventas = sqliteTable(
  "ventas",
  {
    id: text("id").primaryKey(),
    eventoId: eventoOp(),
    dispositivoId: dispositivoOp(),
    puntoVentaId: integer("punto_venta_id").notNull(),
    // Sin clave foránea: una venta puede llegar antes que la apertura de su turno.
    turnoId: text("turno_id").notNull(),
    usuarioId: integer("usuario_id").notNull(),
    numero: integer("numero").notNull(),
    total: integer("total").notNull(),
    conVales: integer("con_vales", { mode: "boolean" }).notNull(),
    estado: text("estado", { enum: ["confirmada", "anulada"] }).notNull(),
    autorizadoPorId: integer("autorizado_por_id"),
    creada: text("creada").notNull(),
  },
  (t) => [index("ventas_turno").on(t.turnoId), index("ventas_evento").on(t.eventoId)],
);

export const ventaItems = sqliteTable(
  "venta_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ventaId: text("venta_id")
      .notNull()
      .references(() => ventas.id, { onDelete: "restrict" }),
    // Sin clave foránea: el producto pudo borrarse mientras el posnet estaba sin conexión.
    productoId: integer("producto_id").notNull(),
    nombre: text("nombre").notNull(),
    precioUnitario: integer("precio_unitario").notNull(),
    cantidad: integer("cantidad").notNull(),
    subtotal: integer("subtotal").notNull(),
    sectorId: integer("sector_id"),
  },
  (t) => [index("venta_items_venta").on(t.ventaId), index("venta_items_producto").on(t.productoId)],
);

export const pagos = sqliteTable(
  "pagos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ventaId: text("venta_id")
      .notNull()
      .references(() => ventas.id, { onDelete: "restrict" }),
    medio: text("medio", { enum: MEDIOS_PAGO }).notNull(),
    monto: integer("monto").notNull(),
    recibido: integer("recibido"),
    idExterno: text("id_externo"),
    autorizacion: text("autorizacion"),
    ultimos4: text("ultimos4"),
    verificado: integer("verificado", { mode: "boolean" }).notNull(),
  },
  (t) => [index("pagos_venta").on(t.ventaId)],
);

/**
 * Vales emitidos. El id lo genera el posnet y viaja en el QR, así que cualquiera que vea un vale lo conoce:
 * se identifica junto con el evento, para que un posnet de otra cuenta no pueda ocupar ese id.
 */
export const vales = sqliteTable(
  "vales",
  {
    id: text("id").notNull(),
    eventoId: eventoOp(),
    ventaId: text("venta_id")
      .notNull()
      .references(() => ventas.id, { onDelete: "restrict" }),
    productoId: integer("producto_id").notNull(),
    sectorId: integer("sector_id"),
    dispositivoId: dispositivoOp(),
    qr: text("qr").notNull(),
    firmaValida: integer("firma_valida", { mode: "boolean" }).notNull(),
    estado: text("estado", { enum: ["emitido", "anulado"] }).notNull(),
    emitido: text("emitido").notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventoId, t.id] }), index("vales_venta").on(t.ventaId)],
);

export const anulaciones = sqliteTable("anulaciones", {
  id: text("id").primaryKey(),
  eventoId: eventoOp(),
  dispositivoId: dispositivoOp(),
  // Sin clave foránea: se registra aunque la venta todavía no haya llegado.
  ventaId: text("venta_id").notNull(),
  turnoId: text("turno_id").notNull(),
  usuarioId: integer("usuario_id").notNull(),
  autorizadoPorId: integer("autorizado_por_id"),
  motivo: text("motivo", { enum: MOTIVOS_ANULACION }).notNull(),
  detalle: text("detalle"),
  valesRecuperados: text("vales_recuperados", { mode: "json" }).$type<string[]>().notNull(),
  creada: text("creada").notNull(),
});

export const devoluciones = sqliteTable(
  "devoluciones",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    anulacionId: text("anulacion_id")
      .notNull()
      .references(() => anulaciones.id, { onDelete: "restrict" }),
    turnoId: text("turno_id").notNull(),
    medio: text("medio", { enum: MEDIOS_PAGO }).notNull(),
    monto: integer("monto").notNull(),
    idExterno: text("id_externo"),
  },
  (t) => [index("devoluciones_turno").on(t.turnoId)],
);

export const movimientosCaja = sqliteTable(
  "movimientos_caja",
  {
    id: text("id").primaryKey(),
    eventoId: eventoOp(),
    dispositivoId: dispositivoOp(),
    turnoId: text("turno_id").notNull(),
    tipo: text("tipo", { enum: TIPOS_MOVIMIENTO_CAJA }).notNull(),
    monto: integer("monto").notNull(),
    motivo: text("motivo").notNull(),
    usuarioId: integer("usuario_id").notNull(),
    autorizadoPorId: integer("autorizado_por_id"),
    creada: text("creada").notNull(),
  },
  (t) => [index("movimientos_caja_turno").on(t.turnoId)],
);

/** Canjes de vales hechos en las barras. Puede llegar un canje de un vale cuya venta todavía no subió. */
export const canjes = sqliteTable(
  "canjes",
  {
    id: text("id").primaryKey(),
    // Operación del posnet que trajo el canje, con sus observaciones.
    operacionId: text("operacion_id").notNull(),
    // Evento donde se canjeó (el de la barra).
    eventoId: eventoOp(),
    dispositivoId: dispositivoOp(),
    puntoVentaId: integer("punto_venta_id").notNull(),
    valeId: text("vale_id").notNull(),
    // Datos del vale leídos del QR.
    eventoValeId: integer("evento_vale_id").notNull(),
    productoValeId: integer("producto_vale_id").notNull(),
    // Producto equivalente en el evento donde se canjeó (el mismo si es del mismo evento).
    productoId: integer("producto_id"),
    firmaValida: integer("firma_valida", { mode: "boolean" }).notNull(),
    usuarioId: integer("usuario_id").notNull(),
    creada: text("creada").notNull(),
  },
  (t) => [
    index("canjes_vale").on(t.valeId),
    index("canjes_evento").on(t.eventoId),
    index("canjes_operacion").on(t.operacionId),
  ],
);

/** Cargas, ajustes y mermas de stock hechos desde el panel. Lo vendido sale de las ventas. */
export const movimientosStock = sqliteTable(
  "movimientos_stock",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventoId: eventoOp(),
    productoId: integer("producto_id")
      .notNull()
      .references(() => productos.id, { onDelete: "restrict" }),
    sectorId: integer("sector_id"),
    tipo: text("tipo", { enum: TIPOS_MOVIMIENTO_STOCK }).notNull(),
    cantidad: integer("cantidad").notNull(),
    usuarioId: integer("usuario_id")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    nota: text("nota"),
    creado: text("creado").notNull(),
  },
  (t) => [index("movimientos_stock_evento").on(t.eventoId)],
);
