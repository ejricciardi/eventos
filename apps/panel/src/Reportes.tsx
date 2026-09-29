import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { OBSERVACIONES, type MedioPago } from "@eventos/shared";
import { api, fecha, hora, pesos } from "./api";

// Pantallas de lo que pasa en el evento: cajas, ventas, stock, vales y lo que hay que revisar.
// Se actualizan solas cada tanto, porque los posnets van subiendo lo que venden.

const CADA_MS = 20_000;

const MEDIOS: Record<MedioPago, string> = {
  efectivo: "Efectivo",
  debito: "Débito",
  credito: "Crédito",
  qr: "QR",
  transferencia: "Transferencia",
  cortesia: "Cortesía",
  otro: "Otro",
};

const OPERACIONES: Record<string, string> = {
  apertura_turno: "Apertura de caja",
  venta: "Venta",
  anulacion: "Anulación",
  movimiento_caja: "Retiro o ingreso",
  cierre_turno: "Cierre de caja",
  canje: "Canje de vale",
};

const MOTIVOS: Record<string, string> = {
  error_de_carga: "Error de carga",
  cliente_desiste: "El cliente desistió",
  producto_faltante: "Faltó el producto",
  cobro_fallido: "Falló el cobro",
  otro: "Otro",
};

const observacion = (codigo: string) => OBSERVACIONES[codigo] ?? codigo;

/** Pide una ruta de la API y la vuelve a pedir cada tanto. */
function useDatos<T>(ruta: string | null) {
  const [datos, setDatos] = useState<T | null>(null);
  const [error, setError] = useState("");
  // Solo vale la respuesta del último pedido: una lenta de otra ruta no pisa a la actual.
  const ultimo = useRef(0);
  const recargar = useCallback(async () => {
    if (!ruta) return;
    const n = ++ultimo.current;
    try {
      const d = await api<T>("GET", ruta);
      if (n !== ultimo.current) return;
      setDatos(d);
      setError("");
    } catch (err) {
      if (n === ultimo.current) setError((err as Error).message);
    }
  }, [ruta]);
  useEffect(() => {
    setDatos(null);
    recargar();
    const id = setInterval(recargar, CADA_MS);
    return () => clearInterval(id);
  }, [recargar]);
  return { datos, error, recargar };
}

function Tabla({ titulos, filas, vacio = "Todavía no hay datos." }: { titulos: string[]; filas: ReactNode[][]; vacio?: string }) {
  if (filas.length === 0) return <p className="ayuda">{vacio}</p>;
  return (
    <div className="tabla">
      <table>
        <thead>
          <tr>
            {titulos.map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filas.map((f, i) => (
            <tr key={i}>
              {f.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Cifras({ items }: { items: [string, ReactNode][] }) {
  return (
    <div className="cifras">
      {items.map(([titulo, valor]) => (
        <div key={titulo}>
          <span>{titulo}</span>
          <strong>{valor}</strong>
        </div>
      ))}
    </div>
  );
}

const MensajeError = ({ texto }: { texto: string }) => (texto ? <p className="error">{texto}</p> : null);

export function Reportes({ eventoId, que }: { eventoId: number; que: "caja" | "ventas" | "stock" | "vales" | "revisar" }) {
  const base = `/eventos/${eventoId}`;
  switch (que) {
    case "caja":
      return <Cajas base={base} />;
    case "ventas":
      return <Ventas base={base} />;
    case "stock":
      return <Stock base={base} />;
    case "vales":
      return <Vales base={base} />;
    case "revisar":
      return <Revisar base={base} />;
  }
}

// ---- Cajas y arqueos ----

type Arqueo = {
  turnoId: string;
  puntoVenta: string;
  cajero: string;
  abierto: string;
  cerrado: string | null;
  fondoInicial: number;
  cobrado: Partial<Record<MedioPago, number>>;
  devuelto: Partial<Record<MedioPago, number>>;
  ingresos: number;
  retiros: number;
  ventas: number;
  anuladas: number;
  efectivoEsperado: number;
  efectivoDeclarado: number | null;
  diferencia: number | null;
  estado: "abierto" | "cerrado" | "incompleto";
  difiereDelPosnet: boolean;
  aperturaRecibida: boolean;
};

const ESTADOS_TURNO = { abierto: "Abierta", cerrado: "Cerrada", incompleto: "Cerrada, faltan datos" };

function Cajas({ base }: { base: string }) {
  const { datos, error } = useDatos<Arqueo[]>(`${base}/turnos`);
  // Se guarda el turno elegido y no la fila, así el detalle se actualiza con cada recarga.
  const [elegidoId, setElegidoId] = useState<string | null>(null);
  const lista = datos ?? [];
  const elegido = lista.find((a) => a.turnoId === elegidoId) ?? null;
  const abiertos = lista.filter((a) => a.estado === "abierto").length;
  const diferencias = lista.reduce((s, a) => s + (a.diferencia ?? 0), 0);

  return (
    <>
      <section>
        <h2>Cajas y arqueos</h2>
        <Cifras
          items={[
            ["Cajas abiertas", abiertos],
            ["Cajas cerradas", lista.length - abiertos],
            ["Diferencia total", <span className={diferencias < 0 ? "negativo" : undefined}>{pesos(diferencias)}</span>],
          ]}
        />
        <p className="ayuda">
          Efectivo esperado = fondo inicial + cobrado en efectivo + ingresos − retiros − devoluciones en efectivo. Si una
          caja figura con datos faltantes, el posnet todavía no subió todo lo que hizo: el arqueo puede cambiar.
        </p>
        <Tabla
          titulos={["Punto de venta", "Cajero", "Abrió", "Estado", "Fondo", "Efectivo cobrado", "Otros medios", "Retiros", "Esperado", "Declarado", "Diferencia", ""]}
          vacio="Todavía no se abrió ninguna caja."
          filas={lista.map((a) => {
            const otros = Object.entries(a.cobrado)
              .filter(([m]) => m !== "efectivo")
              .reduce((s, [, v]) => s + (v ?? 0), 0);
            return [
              a.puntoVenta,
              a.cajero,
              a.aperturaRecibida ? hora(a.abierto) : "—",
              <>
                {ESTADOS_TURNO[a.estado]}
                {a.difiereDelPosnet && <span className="alerta"> · el posnet informó otros totales</span>}
              </>,
              pesos(a.fondoInicial),
              pesos(a.cobrado.efectivo ?? 0),
              pesos(otros),
              pesos(a.retiros),
              pesos(a.efectivoEsperado),
              a.efectivoDeclarado === null ? "—" : pesos(a.efectivoDeclarado),
              a.diferencia === null ? "—" : <span className={a.diferencia !== 0 ? "negativo" : "ok"}>{pesos(a.diferencia)}</span>,
              <button className="secundario" onClick={() => setElegidoId(a.turnoId)}>
                Ver
              </button>,
            ];
          })}
        />
        <MensajeError texto={error} />
      </section>
      {elegido && <DetalleTurno base={base} arqueo={elegido} alCerrar={() => setElegidoId(null)} />}
    </>
  );
}

type Venta = {
  id: string;
  numero: number;
  creada: string;
  total: number;
  estado: "confirmada" | "anulada";
  cajero: string;
  puntoVenta: string;
  items: { nombre: string; cantidad: number; subtotal: number }[];
  pagos: { medio: MedioPago; monto: number; verificado: boolean }[];
};

const detalleItems = (v: Venta) => v.items.map((i) => `${i.cantidad} × ${i.nombre}`).join(", ");
const detallePagos = (v: Venta) => v.pagos.map((p) => `${MEDIOS[p.medio]}${p.verificado ? "" : " (sin confirmar)"}`).join(" + ");

function DetalleTurno({ base, arqueo, alCerrar }: { base: string; arqueo: Arqueo; alCerrar: () => void }) {
  const ventas = useDatos<Venta[]>(`${base}/ventas?turnoId=${arqueo.turnoId}&limite=1000`);
  const movimientos = useDatos<{ tipo: string; monto: number; motivo: string; creada: string }[]>(
    `${base}/movimientos-caja?turnoId=${arqueo.turnoId}`,
  );
  return (
    <section>
      <h2>
        Caja de {arqueo.cajero} en {arqueo.puntoVenta}{" "}
        <button className="secundario" onClick={alCerrar}>
          Cerrar
        </button>
      </h2>
      <Cifras
        items={[
          ...Object.entries(arqueo.cobrado).map(([m, v]): [string, string] => [`Cobrado: ${MEDIOS[m as MedioPago]}`, pesos(v ?? 0)]),
          ...Object.entries(arqueo.devuelto).map(([m, v]): [string, string] => [`Devuelto: ${MEDIOS[m as MedioPago]}`, pesos(v ?? 0)]),
        ]}
      />
      <h3>Retiros e ingresos</h3>
      <Tabla
        titulos={["Hora", "Tipo", "Monto", "Motivo"]}
        vacio="Sin retiros ni ingresos."
        filas={(movimientos.datos ?? []).map((m) => [hora(m.creada), m.tipo === "retiro" ? "Retiro" : "Ingreso", pesos(m.monto), m.motivo])}
      />
      <h3>Ventas ({arqueo.ventas}, anuladas {arqueo.anuladas})</h3>
      <TablaVentas lista={ventas.datos ?? []} />
      <MensajeError texto={ventas.error || movimientos.error} />
    </section>
  );
}

/** Ventas en una tabla. El número es el de cada posnet, por eso va junto al punto de venta. */
function TablaVentas({ lista }: { lista: Venta[] }) {
  return (
    <Tabla
      titulos={["Punto de venta", "N°", "Hora", "Cajero", "Detalle", "Pago", "Total", "Estado"]}
      vacio="Sin ventas."
      filas={lista.map((v) => [
        v.puntoVenta,
        v.numero,
        hora(v.creada),
        v.cajero,
        detalleItems(v),
        detallePagos(v),
        pesos(v.total),
        v.estado === "anulada" ? <span className="negativo">Anulada</span> : "OK",
      ])}
    />
  );
}

// ---- Ventas ----

type ReporteVentas = {
  ventas: number;
  importe: number;
  anuladas: number;
  importeAnulado: number;
  porProducto: { productoId: number; nombre: string; cantidad: number; importe: number }[];
  porMedio: { medio: MedioPago; cantidad: number; importe: number }[];
  porPuntoVenta: { puntoVentaId: number; nombre: string | null; ventas: number; importe: number }[];
  porCajero: { usuarioId: number; nombre: string; ventas: number; importe: number }[];
};

type ReporteAnulaciones = {
  porCajero: { usuarioId: number; nombre: string; cantidad: number; importe: number; porcentaje: number | null }[];
  detalle: {
    id: string;
    numero: number | null;
    total: number | null;
    motivo: string;
    detalle: string | null;
    cajero: string;
    autorizadoPor: string | null;
    minutosDesdeLaVenta: number | null;
    creada: string;
  }[];
};

function Ventas({ base }: { base: string }) {
  const { datos: r, error } = useDatos<ReporteVentas>(`${base}/reportes/ventas`);
  const anulaciones = useDatos<ReporteAnulaciones>(`${base}/reportes/anulaciones`);
  const ultimas = useDatos<Venta[]>(`${base}/ventas?limite=30`);
  if (!r) return <MensajeError texto={error} />;
  return (
    <>
      <section>
        <h2>Ventas</h2>
        <Cifras
          items={[
            ["Vendido", pesos(r.importe)],
            ["Ventas", r.ventas],
            ["Ticket promedio", pesos(r.ventas ? Math.round(r.importe / r.ventas) : 0)],
            ["Anuladas", `${r.anuladas} (${pesos(r.importeAnulado)})`],
          ]}
        />
        <h3>Por medio de pago</h3>
        <Tabla titulos={["Medio", "Cobros", "Importe"]} filas={r.porMedio.map((m) => [MEDIOS[m.medio], m.cantidad, pesos(m.importe)])} />
        <h3>Por producto</h3>
        <Tabla titulos={["Producto", "Unidades", "Importe"]} filas={r.porProducto.map((p) => [p.nombre, p.cantidad, pesos(p.importe)])} />
        <h3>Por punto de venta</h3>
        <Tabla
          titulos={["Punto de venta", "Ventas", "Importe"]}
          filas={r.porPuntoVenta.map((p) => [p.nombre ?? `Punto ${p.puntoVentaId}`, p.ventas, pesos(p.importe)])}
        />
        <h3>Por cajero</h3>
        <Tabla titulos={["Cajero", "Ventas", "Importe"]} filas={r.porCajero.map((c) => [c.nombre, c.ventas, pesos(c.importe)])} />
      </section>
      <section>
        <h2>Anulaciones</h2>
        <Tabla
          titulos={["Cajero", "Anulaciones", "Importe", "Sobre lo que vendió"]}
          vacio="No hubo anulaciones."
          filas={(anulaciones.datos?.porCajero ?? []).map((c) => [
            c.nombre,
            c.cantidad,
            pesos(c.importe),
            c.porcentaje === null ? "—" : `${c.porcentaje} %`,
          ])}
        />
        {(anulaciones.datos?.detalle.length ?? 0) > 0 && (
          <Tabla
            titulos={["Hora", "Venta", "Total", "Motivo", "Cajero", "Autorizó", "Minutos después"]}
            filas={anulaciones.datos!.detalle.map((a) => [
              hora(a.creada),
              a.numero ?? "No llegó",
              a.total === null ? "—" : pesos(a.total),
              `${MOTIVOS[a.motivo] ?? a.motivo}${a.detalle ? `: ${a.detalle}` : ""}`,
              a.cajero,
              a.autorizadoPor ?? "—",
              a.minutosDesdeLaVenta ?? "—",
            ])}
          />
        )}
      </section>
      <section>
        <h2>Últimas ventas</h2>
        <TablaVentas lista={ultimas.datos ?? []} />
      </section>
      <MensajeError texto={error || anulaciones.error || ultimas.error} />
    </>
  );
}

// ---- Stock ----

type FilaStock = {
  productoId: number;
  nombre: string;
  controlaStock: boolean;
  cargado: number;
  ajustes: number;
  mermas: number;
  vendido: number;
  actual: number;
  valesEmitidos: number;
  canjeados: number;
  pendientesDeEntrega: number;
};

type MovimientoStock = { id: number; producto: string; tipo: string; cantidad: number; usuario: string; nota: string | null; creado: string };

const TIPOS_STOCK: Record<string, string> = { carga: "Carga", merma: "Merma (rotura, pérdida)", ajuste: "Ajuste por conteo" };

function Stock({ base }: { base: string }) {
  const stock = useDatos<FilaStock[]>(`${base}/reportes/stock`);
  const movimientos = useDatos<MovimientoStock[]>(`${base}/stock/movimientos`);
  const [error, setError] = useState("");
  const [tipo, setTipo] = useState("carga");

  const cargar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const datos = new FormData(form);
    try {
      await api("POST", `${base}/stock`, {
        productoId: Number(datos.get("productoId")),
        tipo,
        cantidad: Number(datos.get("cantidad")),
        nota: String(datos.get("nota") ?? "") || undefined,
      });
      form.reset();
      setError("");
      await Promise.all([stock.recargar(), movimientos.recargar()]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const lista = stock.datos ?? [];
  return (
    <>
      <section>
        <h2>Stock</h2>
        <p className="ayuda">
          Actual = cargado + ajustes − mermas − vendido. Con vales, lo vendido que todavía no se entregó figura aparte.
          Los productos que controlan stock se muestran agotados en el posnet al llegar a cero.
        </p>
        <Tabla
          titulos={["Producto", "Cargado", "Ajustes", "Mermas", "Vendido", "Actual", "Vales sin entregar"]}
          filas={lista.map((s) => [
            s.controlaStock ? s.nombre : `${s.nombre} (no controla)`,
            s.cargado,
            s.ajustes,
            s.mermas,
            s.vendido,
            <span className={s.controlaStock && s.actual <= 0 ? "negativo" : undefined}>{s.actual}</span>,
            s.pendientesDeEntrega,
          ])}
        />
        <h3>Cargar movimiento</h3>
        <form onSubmit={cargar}>
          <label>
            Producto
            <select name="productoId" required>
              {lista.map((s) => (
                <option key={s.productoId} value={s.productoId}>
                  {s.nombre}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tipo
            <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
              {Object.entries(TIPOS_STOCK).map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            {tipo === "ajuste" ? "Cantidad (+ suma, − resta)" : "Cantidad"}
            <input name="cantidad" type="number" required min={tipo === "ajuste" ? undefined : 1} step={1} />
          </label>
          <label>
            Nota
            <input name="nota" maxLength={200} />
          </label>
          <button>Cargar</button>
        </form>
        <MensajeError texto={error || stock.error} />
      </section>
      <section>
        <h2>Movimientos</h2>
        <Tabla
          titulos={["Fecha", "Producto", "Tipo", "Cantidad", "Quién", "Nota"]}
          vacio="Sin movimientos cargados."
          filas={(movimientos.datos ?? []).map((m) => [
            fecha(m.creado),
            m.producto,
            TIPOS_STOCK[m.tipo] ?? m.tipo,
            m.cantidad,
            m.usuario,
            m.nota ?? "",
          ])}
        />
      </section>
    </>
  );
}

// ---- Vales ----

type ReporteVales = {
  emitidos: number;
  anulados: number;
  canjeados: number;
  pendientes: number;
  alertas: { id: string; valeId: string; creada: string; puntoVenta: string | null; observaciones: string[] }[];
};

function Vales({ base }: { base: string }) {
  const { datos: r, error } = useDatos<ReporteVales>(`${base}/reportes/vales`);
  if (!r) return <MensajeError texto={error} />;
  return (
    <section>
      <h2>Vales</h2>
      <Cifras
        items={[
          ["Vendidos", r.emitidos],
          ["Canjeados", r.canjeados],
          ["Sin canjear", r.pendientes],
          ["Anulados", r.anulados],
        ]}
      />
      <h3>Canjes con alertas</h3>
      <p className="ayuda">Vales canjeados dos veces, vencidos, de otro sector o con firma inválida (posible vale falso).</p>
      <Tabla
        titulos={["Hora", "Dónde", "Vale", "Qué pasó"]}
        vacio="Ningún canje con problemas."
        filas={r.alertas.map((a) => [
          fecha(a.creada),
          a.puntoVenta ?? "—",
          <code>{a.valeId.slice(0, 8)}</code>,
          a.observaciones.map(observacion).join(" · "),
        ])}
      />
      <MensajeError texto={error} />
    </section>
  );
}

// ---- Para revisar ----

type ReporteObservaciones = {
  operaciones: {
    id: string;
    tipo: string;
    estado: "ok" | "invalida";
    error: string | null;
    observaciones: string[];
    creada: string;
    puntoVenta: string;
  }[];
  conflictos: { id: number; operacionId: string; seq: number | null; recibida: string }[];
};

type Sincronizacion = {
  dispositivoId: string;
  puntoVenta: string;
  revocado: string | null;
  ultimaSincronizacion: string | null;
  desfaseMs: number | null;
  operaciones: number;
  ultimaSeq: number;
  faltantes: number[];
};

function Revisar({ base }: { base: string }) {
  const obs = useDatos<ReporteObservaciones>(`${base}/reportes/observaciones`);
  const sinc = useDatos<Sincronizacion[]>(`${base}/reportes/sincronizacion`);
  return (
    <>
      <section>
        <h2>Posnets</h2>
        <p className="ayuda">
          Cada posnet numera lo que hace. Si faltan números, hay operaciones que todavía no subió (por ejemplo, porque
          está sin conexión).
        </p>
        <Tabla
          titulos={["Punto de venta", "Estado", "Último contacto", "Reloj", "Operaciones", "Faltan"]}
          vacio="No hay posnets vinculados."
          filas={(sinc.datos ?? []).map((s) => [
            s.puntoVenta,
            s.revocado ? "Desvinculado" : "Vinculado",
            s.ultimaSincronizacion ? fecha(s.ultimaSincronizacion) : "Nunca",
            s.desfaseMs === null || Math.abs(s.desfaseMs) < 60_000 ? (
              "OK"
            ) : (
              <span className="alerta">
                {s.desfaseMs > 0 ? "adelanta" : "atrasa"} {Math.round(Math.abs(s.desfaseMs) / 60_000)} min
              </span>
            ),
            s.operaciones,
            s.faltantes.length === 0 ? "—" : <span className="negativo">{s.faltantes.join(", ")}</span>,
          ])}
        />
      </section>
      <section>
        <h2>Operaciones observadas</h2>
        <p className="ayuda">
          Lo que hicieron los posnets se registra siempre, aunque algo no cierre. Acá está lo que conviene mirar.
        </p>
        <Tabla
          titulos={["Hora", "Punto de venta", "Operación", "Qué pasó"]}
          vacio="Nada para revisar."
          filas={(obs.datos?.operaciones ?? []).map((o) => [
            fecha(o.creada),
            o.puntoVenta,
            OPERACIONES[o.tipo] ?? o.tipo,
            o.estado === "invalida" ? (
              <span className="negativo">Rechazada: {o.error}</span>
            ) : (
              o.observaciones.map(observacion).join(" · ")
            ),
          ])}
        />
        {(obs.datos?.conflictos.length ?? 0) > 0 && (
          <p className="alerta">
            {obs.datos!.conflictos.length} operaciones llegaron con un número ya usado y otros datos. Puede ser un
            posnet reinstalado sin volver a vincularlo.
          </p>
        )}
        <MensajeError texto={obs.error || sinc.error} />
      </section>
    </>
  );
}
