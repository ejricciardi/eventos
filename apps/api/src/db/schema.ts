import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { MODOS_VENTA, PLATAFORMAS, ROLES } from "@eventos/shared";

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
  categoria: text("categoria"),
  precio: integer("precio").notNull(),
  sectorId: integer("sector_id").references(() => sectores.id, { onDelete: "set null" }),
  activo: integer("activo", { mode: "boolean" }).notNull().default(true),
});

export const puntosVenta = sqliteTable("puntos_venta", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  eventoId: eventoId(),
  nombre: text("nombre").notNull(),
  plataforma: text("plataforma", { enum: PLATAFORMAS }).notNull(),
  imprimeVales: integer("imprime_vales", { mode: "boolean" }),
  imprimeTicket: integer("imprime_ticket", { mode: "boolean" }).notNull().default(true),
  // Hash de la clave con la que el posnet se identifica. Sin esto no se puede entrar con NFC.
  claveDispositivoHash: text("clave_dispositivo_hash"),
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
