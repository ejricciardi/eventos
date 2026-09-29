import { z } from "zod";

// Operaciones que genera el posnet. Se guardan en el dispositivo y se suben cuando hay conexión,
// así que cada una lleva su propio id, un número de secuencia del dispositivo y la hora del dispositivo.
// El servidor las toma como hechos: solo rechaza las mal formadas; lo raro lo marca como observación.

export const MEDIOS_PAGO = ["efectivo", "debito", "credito", "qr", "transferencia", "cortesia", "otro"] as const;
export const MOTIVOS_ANULACION = ["error_de_carga", "cliente_desiste", "producto_faltante", "cobro_fallido", "otro"] as const;
export const TIPOS_MOVIMIENTO_CAJA = ["retiro", "ingreso"] as const;
export const TIPOS_MOVIMIENTO_STOCK = ["carga", "ajuste", "merma"] as const;

/** Tope de cualquier importe, en centavos ($1.000 millones). Evita que un dato absurdo rompa las sumas de los reportes. */
export const MONTO_MAXIMO = 100_000_000_000;

const uuid = z.string().uuid();
const monto = z.number().int().nonnegative().max(MONTO_MAXIMO);
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
    .min(1)
    .max(200),
  pagos: z.array(pagoInput).min(1).max(10),
  // Un vale por unidad. El qr es el contenido firmado que se imprimió.
  vales: z
    .array(z.object({ valeId: uuid, item: z.number().int().nonnegative(), qr: z.string().min(1).max(1000) }))
    .max(1000)
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
  valesRecuperados: z.array(uuid).max(1000).default([]),
  devoluciones: z
    .array(z.object({ medio: z.enum(MEDIOS_PAGO), monto: monto, idExterno: z.string().trim().max(100).optional() }))
    .max(10)
    .default([]),
});

export const movimientoCajaOp = z.object({
  ...base,
  tipo: z.literal("movimiento_caja"),
  movimientoId: uuid,
  turnoId: uuid,
  movimiento: z.enum(TIPOS_MOVIMIENTO_CAJA),
  monto: z.number().int().positive().max(MONTO_MAXIMO),
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

export const movimientoStockInput = z
  .object({
    productoId: z.number().int().positive(),
    // carga: entra mercadería. merma: se rompió o se perdió. ajuste: corrige el stock tras un conteo.
    tipo: z.enum(TIPOS_MOVIMIENTO_STOCK),
    // Carga y merma van en positivo (la merma resta). El ajuste puede ser positivo o negativo.
    cantidad: z.number().int().min(-100000).max(100000),
    sectorId: z.number().int().positive().nullable().default(null),
    nota: z.string().trim().max(200).optional(),
  })
  .refine((m) => (m.tipo === "ajuste" ? m.cantidad !== 0 : m.cantidad > 0), {
    message: "La cantidad tiene que ser mayor que cero (en un ajuste, distinta de cero)",
    path: ["cantidad"],
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

/** Qué significa cada observación que el servidor anota en una operación (para el panel y el posnet). */
export const OBSERVACIONES: Record<string, string> = {
  dispositivo_revocado: "Llegó de un posnet ya desvinculado",
  usuario_desconocido: "El usuario no es de esta cuenta",
  usuario_inactivo: "El usuario estaba desactivado",
  autorizacion_invalida: "Quien autorizó no es supervisor",
  turno_desconocido: "El turno todavía no llegó",
  turno_de_otro_evento: "El turno es de otro evento",
  turno_de_otro_dispositivo: "El turno se abrió en otro posnet",
  turno_en_puesto_de_canje: "Se abrió caja en un puesto de canje",
  otro_turno_abierto: "Había otro turno abierto en el posnet",
  turno_repetido: "La apertura del turno llegó dos veces",
  venta_repetida: "La venta llegó dos veces",
  venta_anulada_antes_de_llegar: "La anulación llegó antes que la venta",
  movimiento_repetido: "El retiro o ingreso llegó dos veces",
  canje_repetido: "El canje llegó dos veces",
  venta_en_puesto_de_canje: "Venta hecha en un puesto de canje",
  cajero_distinto: "Vendió alguien distinto del cajero del turno",
  turno_cerrado: "Operación posterior al cierre del turno",
  producto_desconocido: "Producto que no existe en el evento",
  producto_inactivo: "Producto desactivado",
  precio_distinto: "Precio distinto del actual (posnet sin conexión o precio cambiado)",
  falta_autorizacion: "Faltó la autorización de un supervisor",
  pago_no_verificado: "Cobro sin confirmar con la plataforma",
  pago_externo_repetido: "El mismo cobro de Clover o Mercado Pago aparece dos veces",
  vale_inconsistente: "El vale no coincide con la venta",
  firma_invalida: "Firma inválida: posible vale falso",
  vale_repetido: "El vale ya existía",
  venta_desconocida: "Anulación de una venta que no llegó",
  venta_ya_anulada: "La venta ya estaba anulada",
  anulada_en_otro_dispositivo: "Anulada en otro posnet",
  fuera_de_plazo: "El cajero anuló fuera de plazo sin supervisor",
  vale_no_recuperado: "No se recuperaron todos los vales",
  anulacion_con_vale_canjeado: "Se anuló con vales ya canjeados",
  devolucion_distinta: "Lo devuelto no coincide con el total",
  devolucion_otro_medio: "Se devolvió por un medio distinto del cobro",
  turno_ya_cerrado: "El turno ya estaba cerrado",
  cierre_por_otro: "Cerró el turno otra persona",
  vale_de_otra_cuenta: "Vale de otra cuenta",
  vale_de_otro_evento: "Vale de otro evento",
  producto_no_equivalente: "No hay un producto equivalente en este evento",
  vale_vencido: "Vale vencido",
  otro_sector: "Vale de otro sector",
  vale_sin_venta: "La venta del vale todavía no llegó",
  vale_anulado: "Vale anulado",
  canje_duplicado: "Vale ya canjeado",
  canje_en_curso: "Otra barra lo está canjeando",
  qr_invalido: "No es un vale válido",
};
