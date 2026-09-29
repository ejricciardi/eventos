import { z } from "zod";

// Los montos se guardan en centavos para no arrastrar errores de punto flotante.
const centavos = z.number().int().nonnegative();
const texto = z.string().trim().min(1).max(120);

/**
 * Hasta cuándo sirve un vale:
 * - fin_evento: hasta que termina el evento.
 * - fecha: hasta la fecha y hora de valesVencimiento.
 * - sin_vencimiento: no vence y se puede canjear en otros eventos de la cuenta que vendan el mismo producto.
 */
export const VALIDEZ_VALES = ["fin_evento", "fecha", "sin_vencimiento"] as const;

/** Cómo se vende en el evento: con vales canjeables o con comanda directa al sector. */
export const MODOS_VENTA = ["vales", "directo"] as const;
export const PLATAFORMAS = ["clover", "mercadopago", "otro"] as const;
export const ROLES = ["cajero", "despacho", "supervisor", "admin"] as const;
/** Roles que pueden cambiar la configuración de los eventos. */
export const ROLES_CONFIGURACION = ["supervisor", "admin"] as const;

export const eventoInput = z.object({
  nombre: texto,
  lugar: z.string().trim().max(200).optional(),
  inicio: z.string().datetime({ offset: true }),
  fin: z.string().datetime({ offset: true }),
  modoVenta: z.enum(MODOS_VENTA).default("vales"),
  // Hasta cuándo sirven los vales. Se evalúa al canjear con la configuración vigente,
  // así un cambio vale también para los vales ya impresos.
  valesValidez: z.enum(VALIDEZ_VALES).default("fin_evento"),
  // Solo para validez "fecha".
  valesVencimiento: z.string().datetime({ offset: true }).nullable().default(null),
  // Minutos en los que el cajero puede anular solo; después hace falta un supervisor.
  minutosAnulacionCajero: z.number().int().min(0).max(240).default(5),
});

export const impresoraInput = z.object({
  nombre: texto,
  // Impresoras térmicas de red que hablan ESC/POS (Epson, 3nstar, etc.).
  host: z.string().trim().min(1),
  puerto: z.number().int().min(1).max(65535).default(9100),
  anchoPapel: z.union([z.literal(58), z.literal(80)]).default(80),
});

export const sectorInput = z.object({
  nombre: texto,
  // Sin impresora, la comanda sale en el ticket del posnet.
  impresoraId: z.number().int().positive().nullable().default(null),
});

export const productoInput = z.object({
  nombre: texto,
  // Código del producto en tu catálogo. Sirve para reconocer el mismo producto en otro evento
  // (por ejemplo, al canjear un vale sin vencimiento). Si no hay código, se compara por nombre.
  codigo: z.string().trim().max(40).nullable().default(null),
  categoria: z.string().trim().max(60).optional(),
  precio: centavos,
  sectorId: z.number().int().positive().nullable().default(null),
  activo: z.boolean().default(true),
  // Si controla stock, el posnet avisa cuando se agota (no bloquea: sin conexión no se puede frenar).
  controlaStock: z.boolean().default(false),
});

/** Un punto de venta es una caja que cobra o un puesto de canje de vales (una barra). */
export const TIPOS_PUNTO_VENTA = ["caja", "canje"] as const;
export const VISTAS_PRODUCTOS = ["lista", "fotos"] as const;

export const puntoVentaInput = z.object({
  nombre: texto,
  plataforma: z.enum(PLATAFORMAS),
  // null = usar lo que define el modo de venta del evento.
  imprimeVales: z.boolean().nullable().default(null),
  imprimeTicket: z.boolean().default(true),
  tipo: z.enum(TIPOS_PUNTO_VENTA).default("caja"),
  // Para un puesto de canje: el sector cuyos vales canjea.
  sectorId: z.number().int().positive().nullable().default(null),
  vistaProductos: z.enum(VISTAS_PRODUCTOS).default("lista"),
});

const nfcUid = z
  .string()
  .trim()
  .regex(/^[0-9A-Fa-f]{8,20}$/, "UID NFC en hexadecimal")
  .transform((s) => s.toUpperCase());

// Clave de acceso al panel. Solo se recibe, nunca se devuelve.
const clave = z.string().min(8, "La clave tiene que tener al menos 8 caracteres").max(200);

const nombreUsuario = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,40}$/, "Usuario de 3 a 40 caracteres: letras, números, punto, guion o guion bajo");

export const usuarioInput = z.object({
  nombre: texto,
  usuario: nombreUsuario,
  rol: z.enum(ROLES),
  // Opcional: hay staff que solo entra con tarjeta en el posnet.
  clave: clave.optional(),
  // UID de la tarjeta NFC con la que entra al posnet.
  nfcUid: nfcUid.nullable().default(null),
  activo: z.boolean().default(true),
});

/** Crea la cuenta del organizador junto con su primer usuario administrador. */
export const registroInput = z.object({
  cuenta: texto,
  nombre: texto,
  usuario: nombreUsuario,
  clave,
});

export const loginInput = z.object({
  usuario: z.string().trim().toLowerCase().min(1),
  clave: z.string().min(1),
});

export const loginNfcInput = z.object({ nfcUid });

export type EventoInput = z.infer<typeof eventoInput>;
export type ImpresoraInput = z.infer<typeof impresoraInput>;
export type SectorInput = z.infer<typeof sectorInput>;
export type ProductoInput = z.infer<typeof productoInput>;
export type PuntoVentaInput = z.infer<typeof puntoVentaInput>;
export type UsuarioInput = z.infer<typeof usuarioInput>;

export type Evento = EventoInput & { id: number; cuentaId: number };
export type Impresora = ImpresoraInput & { id: number; eventoId: number };
export type Sector = SectorInput & { id: number; eventoId: number };
export type Producto = ProductoInput & { id: number; eventoId: number };
export type PuntoVenta = PuntoVentaInput & { id: number; eventoId: number; dispositivoVinculado: boolean };
/** Usuario tal como lo devuelve la API: sin la clave. */
export type Usuario = Omit<UsuarioInput, "clave"> & { id: number; cuentaId: number; tieneClave: boolean };
export type Cuenta = { id: number; nombre: string };
export type Sesion = { token: string; expira: string; usuario: Usuario; cuenta: Cuenta };

/** Decide si un punto de venta imprime vales, según su configuración y la del evento. */
export function imprimeVales(evento: Pick<Evento, "modoVenta">, pv: Pick<PuntoVenta, "imprimeVales">): boolean {
  return pv.imprimeVales ?? evento.modoVenta === "vales";
}

/** Fecha y hora desde la que un vale del evento está vencido, o null si no vence. */
export function vencimientoVales(evento: Pick<Evento, "valesValidez" | "valesVencimiento" | "fin">): string | null {
  if (evento.valesValidez === "sin_vencimiento") return null;
  if (evento.valesValidez === "fecha" && evento.valesVencimiento) return evento.valesVencimiento;
  return evento.fin;
}

/** Clave para reconocer el mismo producto en dos eventos: el código, o el nombre normalizado si no hay código. */
export function claveProducto(p: { codigo?: string | null; nombre: string }): string {
  if (p.codigo) return `codigo:${p.codigo.trim().toUpperCase()}`;
  return `nombre:${p.nombre.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export * from "./operaciones";
