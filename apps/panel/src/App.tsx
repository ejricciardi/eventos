import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MODOS_VENTA, PLATAFORMAS, ROLES, type Evento, type Staff } from "@eventos/shared";
import { api, pesos } from "./api";

type Opcion = { valor: string; texto: string };
type Campo = {
  nombre: string;
  titulo: string;
  tipo?: "texto" | "numero" | "pesos" | "select" | "fecha";
  opciones?: Opcion[];
  opcional?: boolean;
  textoVacio?: string;
  mostrar?: (fila: Record<string, any>) => string;
};

/** Convierte lo que se tipea en el formulario al formato que espera la API. Vacío = que use su valor por defecto. */
function convertir(campo: Campo, valor: string): unknown {
  if (valor === "") return undefined;
  switch (campo.tipo) {
    case "numero":
      return Number(valor);
    case "pesos":
      return Math.round(Number(valor.replace(",", ".")) * 100);
    case "fecha":
      return new Date(valor).toISOString();
    case "select":
      if (valor === "true" || valor === "false") return valor === "true";
      return /^\d+$/.test(valor) ? Number(valor) : valor;
    default:
      return valor;
  }
}

/** Tabla con alta y baja, reutilizada para cada recurso del evento. */
function Recurso({
  titulo,
  ruta,
  campos,
  alCambiar,
  soloAlta = false,
}: {
  titulo: string;
  ruta: string;
  campos: Campo[];
  alCambiar?: () => void;
  soloAlta?: boolean;
}) {
  const [filas, setFilas] = useState<Record<string, any>[]>([]);
  const [error, setError] = useState("");

  const cargar = useCallback(() => api<Record<string, any>[]>("GET", ruta).then(setFilas), [ruta]);
  useEffect(() => {
    cargar().catch((e) => setError(e.message));
  }, [cargar]);

  const crear = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const datos = new FormData(form);
    const cuerpo: Record<string, unknown> = {};
    for (const c of campos) {
      const v = convertir(c, String(datos.get(c.nombre) ?? ""));
      if (v !== undefined) cuerpo[c.nombre] = v;
    }
    try {
      await api("POST", ruta, cuerpo);
      form.reset();
      setError("");
      await cargar();
      alCambiar?.();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const borrar = async (id: number) => {
    await api("DELETE", `${ruta}/${id}`);
    await cargar();
    alCambiar?.();
  };

  return (
    <section>
      <h2>{titulo}</h2>
      {!soloAlta && (
        <table>
          <thead>
            <tr>
              {campos.map((c) => (
                <th key={c.nombre}>{c.titulo}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {filas.map((f) => (
              <tr key={f.id}>
                {campos.map((c) => (
                  <td key={c.nombre}>{c.mostrar ? c.mostrar(f) : String(f[c.nombre] ?? "—")}</td>
                ))}
                <td>
                  <button className="secundario" onClick={() => borrar(f.id)}>
                    Borrar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={crear}>
        {campos.map((c) => (
          <label key={c.nombre}>
            {c.titulo}
            {c.tipo === "select" ? (
              <select name={c.nombre} defaultValue="">
                {c.opcional && <option value="">{c.textoVacio ?? "(ninguno)"}</option>}
                {c.opciones!.map((o) => (
                  <option key={o.valor} value={o.valor}>
                    {o.texto}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name={c.nombre}
                type={c.tipo === "fecha" ? "datetime-local" : "text"}
                inputMode={c.tipo === "numero" || c.tipo === "pesos" ? "decimal" : undefined}
                required={!c.opcional}
              />
            )}
          </label>
        ))}
        <button>Agregar</button>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", hour12: false });

const opciones = (valores: readonly string[]): Opcion[] => valores.map((v) => ({ valor: v, texto: v }));

function PantallaEvento({ evento, alCambiar }: { evento: Evento; alCambiar: () => void }) {
  const base = `/eventos/${evento.id}`;
  // Impresoras y sectores alimentan los desplegables de los otros recursos.
  const [impresoras, setImpresoras] = useState<Opcion[]>([]);
  const [sectores, setSectores] = useState<Opcion[]>([]);
  const refrescar = useCallback(() => {
    api<{ id: number; nombre: string }[]>("GET", `${base}/impresoras`).then((l) =>
      setImpresoras(l.map((i) => ({ valor: String(i.id), texto: i.nombre }))),
    );
    api<{ id: number; nombre: string }[]>("GET", `${base}/sectores`).then((l) =>
      setSectores(l.map((s) => ({ valor: String(s.id), texto: s.nombre }))),
    );
  }, [base]);
  useEffect(refrescar, [refrescar]);

  const nombreDe = (lista: Opcion[], id: unknown) => lista.find((o) => o.valor === String(id))?.texto ?? "—";

  const cambiarModo = async (modoVenta: string) => {
    await api("PATCH", base, { modoVenta });
    alCambiar();
  };

  return (
    <>
      <section>
        <h2>{evento.nombre}</h2>
        <p>
          {evento.lugar ?? "Sin lugar"} · {fecha(evento.inicio)} a {fecha(evento.fin)}
        </p>
        <label>
          Modo de venta
          <select value={evento.modoVenta} onChange={(e) => cambiarModo(e.target.value)}>
            <option value="vales">Con vales de consumo</option>
            <option value="directo">Directo (sin vales, comanda al sector)</option>
          </select>
        </label>
      </section>
      <Recurso
        titulo="Impresoras de comandas"
        ruta={`${base}/impresoras`}
        alCambiar={refrescar}
        campos={[
          { nombre: "nombre", titulo: "Nombre" },
          { nombre: "host", titulo: "IP" },
          { nombre: "puerto", titulo: "Puerto", tipo: "numero", opcional: true },
          { nombre: "anchoPapel", titulo: "Papel (mm)", tipo: "select", opciones: opciones(["80", "58"]) },
        ]}
      />
      <Recurso
        titulo="Sectores (cocina, barra…)"
        ruta={`${base}/sectores`}
        alCambiar={refrescar}
        campos={[
          { nombre: "nombre", titulo: "Nombre" },
          {
            nombre: "impresoraId",
            titulo: "Impresora",
            tipo: "select",
            opciones: impresoras,
            opcional: true,
            mostrar: (f) => (f.impresoraId ? nombreDe(impresoras, f.impresoraId) : "Ticket del posnet"),
          },
        ]}
      />
      <Recurso
        titulo="Productos"
        ruta={`${base}/productos`}
        campos={[
          { nombre: "nombre", titulo: "Nombre" },
          { nombre: "categoria", titulo: "Categoría", opcional: true },
          { nombre: "precio", titulo: "Precio ($)", tipo: "pesos", mostrar: (f) => pesos(f.precio) },
          {
            nombre: "sectorId",
            titulo: "Sector",
            tipo: "select",
            opciones: sectores,
            opcional: true,
            mostrar: (f) => nombreDe(sectores, f.sectorId),
          },
        ]}
      />
      <Recurso
        titulo="Puntos de venta"
        ruta={`${base}/puntos-venta`}
        campos={[
          { nombre: "nombre", titulo: "Nombre" },
          { nombre: "plataforma", titulo: "Posnet", tipo: "select", opciones: opciones(PLATAFORMAS) },
          {
            nombre: "imprimeVales",
            titulo: "Vales",
            tipo: "select",
            opcional: true,
            textoVacio: "Según el evento",
            opciones: [
              { valor: "true", texto: "Siempre" },
              { valor: "false", texto: "Nunca" },
            ],
            mostrar: (f) => (f.imprimeVales === null ? "Según el evento" : f.imprimeVales ? "Siempre" : "Nunca"),
          },
        ]}
      />
    </>
  );
}

function PantallaEventos({ alElegir }: { alElegir: (id: number) => void }) {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const cargar = () => api<Evento[]>("GET", "/eventos").then(setEventos);
  useEffect(() => {
    cargar();
  }, []);

  return (
    <>
      <section>
        <h2>Eventos</h2>
        <ul className="lista-eventos">
          {eventos.map((e) => (
            <li key={e.id} onClick={() => alElegir(e.id)}>
              <strong>{e.nombre}</strong> · {new Date(e.inicio).toLocaleDateString("es-AR")} · modo {e.modoVenta}
            </li>
          ))}
          {eventos.length === 0 && <li>Todavía no hay eventos.</li>}
        </ul>
      </section>
      <Recurso
        titulo="Nuevo evento"
        ruta="/eventos"
        soloAlta
        alCambiar={cargar}
        campos={[
          { nombre: "nombre", titulo: "Nombre" },
          { nombre: "lugar", titulo: "Lugar", opcional: true },
          { nombre: "inicio", titulo: "Inicio", tipo: "fecha" },
          { nombre: "fin", titulo: "Fin", tipo: "fecha" },
          { nombre: "modoVenta", titulo: "Modo", tipo: "select", opciones: opciones(MODOS_VENTA) },
        ]}
      />
    </>
  );
}

export function App() {
  const [pantalla, setPantalla] = useState<"eventos" | "staff">("eventos");
  const [eventoId, setEventoId] = useState<number | null>(null);
  const [evento, setEvento] = useState<Evento | null>(null);

  const cargarEvento = useCallback(() => {
    if (eventoId) api<Evento>("GET", `/eventos/${eventoId}`).then(setEvento);
    else setEvento(null);
  }, [eventoId]);
  useEffect(cargarEvento, [cargarEvento]);

  return (
    <>
      <header>
        <strong>Eventos</strong>
        <button
          className={pantalla === "eventos" ? "activo" : ""}
          onClick={() => (setPantalla("eventos"), setEventoId(null))}
        >
          Eventos
        </button>
        <button className={pantalla === "staff" ? "activo" : ""} onClick={() => setPantalla("staff")}>
          Staff
        </button>
      </header>
      <main>
        {pantalla === "staff" ? (
          <Recurso
            titulo="Staff (login con tarjeta NFC)"
            ruta="/staff"
            campos={[
              { nombre: "nombre", titulo: "Nombre" },
              { nombre: "rol", titulo: "Rol", tipo: "select", opciones: opciones(ROLES) },
              {
                nombre: "nfcUid",
                titulo: "UID de la tarjeta",
                opcional: true,
                mostrar: (f: Partial<Staff>) => f.nfcUid ?? "—",
              },
            ]}
          />
        ) : evento ? (
          <PantallaEvento evento={evento} alCambiar={cargarEvento} />
        ) : (
          <PantallaEventos alElegir={setEventoId} />
        )}
      </main>
    </>
  );
}
