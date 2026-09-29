import { sqliteTable, integer, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { MODOS_VENTA, PLATAFORMAS, ROLES } from "@eventos/shared";

export const eventos = sqliteTable("eventos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
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
});

export const staff = sqliteTable(
  "staff",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nombre: text("nombre").notNull(),
    rol: text("rol", { enum: ROLES }).notNull(),
    nfcUid: text("nfc_uid"),
    activo: integer("activo", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [uniqueIndex("staff_nfc_uid_unico").on(t.nfcUid)],
);
