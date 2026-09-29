import { z } from "zod";

// Operaciones que genera el posnet. Se guardan en el dispositivo y se suben cuando hay conexión,
// así que cada una lleva su propio id, un número de secuencia del dispositivo y la hora del dispositivo.
// El servidor las toma como hechos: solo rechaza las mal formadas; lo raro lo marca como observación.

export const MEDIOS_PAGO = ["efectivo", "debito", "credito", "qr", "transferencia", "cortesia", "otro"] as const;
export const MOTIVOS_ANULACION = ["error_de_carga", "cliente_desiste", "producto_faltante", "cobro_fallido", "otro"] as const;
export const TIPOS_MOVIMIENTO_CAJA = ["retiro", "ingreso"] as const;
export const TIPOS_MOVIMIENTO_STOCK = ["carga", "ajuste", "merma"] as const;

const uuid = z.string().uuid();
const monto = z.number().int().nonnegative();
const idUsuario = z.number().int().positive();

const base = {
  id: uuid,
  // Secuencia del dispositivo: 1, 2, 3... sin saltos. Sirve para saber si falta subir algo.
  seq: z.number().int().positive(),
  creada: z.string().datetime({ offset: true }),
};

export const pagoInput = z
  .object({
    medio: z.enum(MEDIOS_PAGO),
    monto: monto,
    // Efectivo: lo que entregó el cliente (el vuelto es recibido - monto).
    recibido: monto.optional(),
    // Datos que devuelve Clover o Mercado Pago, para conciliar con la liquidación.
    idExterno: z.string().trim().max(100).optional(),
    autorizacion: z.string().trim().max(50).optional(),
    ultimos4: z
      .string()
      .regex(/^\d{4}$/)
      .optional(),
    // false si el posnet no pudo confirmar el cobro con la plataforma (por ejemplo, sin conexión).
    verificado: z.boolean().default(true),
  })
  .refine((p) => p.recibido === undefined || (p.medio === "efectivo" && p.recibido >= p.monto), {
    message: "Recibido solo va en efectivo y no puede ser menor que el monto",
  });

export const aperturaTurnoOp = z.object({
  ...base,
  tipo: z.literal("apertura_turno"),
  turnoId: uuid,
  usuarioId: idUsuario,
  fondoInicial: monto,
  // Quien entrega el fondo (supervisor o tesorería).
  entregadoPorId: idUsuario.optional(),
});

export const ventaOp = z.object({
  ...base,
  tipo: z.literal("venta"),
  ventaId: uuid,
  turnoId: uuid,
  usuarioId: idUsuario,
  numero: z.number().int().positive(),
  items: z
    .array(
      z.object({
        productoId: z.number().int().positive(),
        // Nombre y precio tal como los cobró el posnet (pudo estar sin conexión con precios viejos).
        nombre: z.string().trim().min(1).max(120),
        precioUnitario: monto,
        cantidad: z.number().int().positive().max(1000),
      }),
    )
    .min(1),
  pagos: z.array(pagoInput).min(1),
  // Un vale por unidad. El qr es el contenido firmado que se imprimió.
  vales: z
    .array(z.object({ valeId: uuid, item: z.number().int().nonnegative(), qr: z.string().min(1).max(1000) }))
    .default([]),
  // Supervisor que autorizó una cortesía o una transferencia.
  autorizadoPorId: idUsuario.optional(),
});

export const anulacionOp = z.object({
  ...base,
  tipo: z.literal("anulacion"),
  ventaId: uuid,
  // Turno donde se devolvió la plata (puede no ser el de la venta).
  turnoId: uuid,
  usuarioId: idUsuario,
  autorizadoPorId: idUsuario.optional(),
  motivo: z.enum(MOTIVOS_ANULACION),
  detalle: z.string().trim().max(200).optional(),
  valesRecuperados: z.array(uuid).default([]),
  devoluciones: z
    .array(z.object({ medio: z.enum(MEDIOS_PAGO), monto: monto, idExterno: z.string().trim().max(100).optional() }))
    .default([]),
});

export const movimientoCajaOp = z.object({
  ...base,
  tipo: z.literal("movimiento_caja"),
  movimientoId: uuid,
  turnoId: uuid,
  movimiento: z.enum(TIPOS_MOVIMIENTO_CAJA),
  monto: z.number().int().positive(),
  motivo: z.string().trim().min(1).max(200),
  usuarioId: idUsuario,
  autorizadoPorId: idUsuario.optional(),
});

export const cierreTurnoOp = z.object({
  ...base,
  tipo: z.literal("cierre_turno"),
  turnoId: uuid,
  usuarioId: idUsuario,
  efectivoDeclarado: monto,
  // Lo que el posnet cree tener, para detectar operaciones que no llegaron.
  cantidadVentas: z.number().int().nonnegative(),
  totalesPorMedio: z.record(z.enum(MEDIOS_PAGO), monto).default({}),
});

export const canjeOp = z.object({
  ...base,
  tipo: z.literal("canje"),
  canjeId: uuid,
  qr: z.string().min(1).max(1000),
  usuarioId: idUsuario,
});

export const operacionInput = z.discriminatedUnion("tipo", [
  aperturaTurnoOp,
  ventaOp,
  anulacionOp,
  movimientoCajaOp,
  cierreTurnoOp,
  canjeOp,
]);

export const sincronizacionInput = z.object({
  // Hora del dispositivo al enviar, para calcular cuánto atrasa o adelanta su reloj.
  reloj: z.string().datetime({ offset: true }),
  // Se aceptan sin validar acá: cada una se valida por separado para que una mala no frene al resto.
  operaciones: z.array(z.unknown()).max(500),
});

export const movimientoStockInput = z.object({
  productoId: z.number().int().positive(),
  tipo: z.enum(TIPOS_MOVIMIENTO_STOCK),
  // Positivo suma, negativo resta. Una carga siempre es positiva.
  cantidad: z.number().int().refine((n) => n !== 0, "La cantidad no puede ser cero"),
  sectorId: z.number().int().positive().nullable().default(null),
  nota: z.string().trim().max(200).optional(),
});

export type MedioPago = (typeof MEDIOS_PAGO)[number];
export type Operacion = z.infer<typeof operacionInput>;
export type VentaOp = z.infer<typeof ventaOp>;
export type AnulacionOp = z.infer<typeof anulacionOp>;

/** Estado de una operación subida: ok, repetida (ya estaba), en conflicto (mismo id con otros datos) o inválida. */
export type ResultadoOperacion = {
  id: string | null;
  estado: "ok" | "repetida" | "conflicto" | "invalida";
  error?: string;
  observaciones?: string[];
};

/** Contenido del QR de un vale, firmado por el posnet que lo emitió. */
export type ContenidoVale = {
  v: 1;
  // evento, vale, producto, sector, dispositivo emisor y hora de emisión
  e: number;
  i: string;
  p: number;
  s: number | null;
  d: string;
  t: string;
};
