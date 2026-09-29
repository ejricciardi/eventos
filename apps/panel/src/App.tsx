import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  MODOS_VENTA,
  PLATAFORMAS,
  ROLES,
  ROLES_CONFIGURACION,
  VALIDEZ_VALES,
  type Cuenta,
  type Evento,
  type Usuario,
} from "@eventos/shared";
import { alVencerSesion, api, fecha, guardarToken, hayToken, pesos } from "./api";
import { Acceso } from "./Acceso";
import { Reportes } from "./Reportes";

type Opcion = { valor: string; texto: string };
type Campo = {
  nombre: string;
  titulo: string;
  tipo?: "texto" | "numero" | "pesos" | "select" | "fecha" | "clave";
  opciones?: Opcion[];
  opcional?: boolean;
  textoVacio?: string;
  mostrar?: (fila: Record<string, any>) => string;
  /** Solo se muestra en la tabla: no se carga en el formulario. */
  soloLectura?: boolean;
};

/**
 * Convierte lo que se tipea en el formulario al formato que espera la API.
 * Vacío = que use su valor por defecto (al crear) o que no cambie (al editar),
 * salvo en un desplegable opcional al editar, donde vacío es "ninguno".
 */
function convertir(campo: Campo, valor: string, editando: boolean): unknown {
  if (valor === "") return editando && campo.tipo === "select" && campo.opcional ? null : undefined;
  switch (campo.tipo) {
    case "numero":
      return Number(valor);
    case "pesos":
      return Math.round(leerPesos(valor) * 100);
    case "fecha":
      return new Date(valor).toISOString();
    case "select":
      if (valor === "true" || valor === "false") return valor === "true";
      return /^\d+$/.test(valor) ? Number(valor) : valor;
    default:
      return valor;
  }
}

/**
 * Lee un importe escrito como en Argentina: "3.500" es tres mil quinientos y "3.500,50" lleva centavos.
 * También acepta "3500.50" (punto decimal, sin separador de miles).
 */
export function leerPesos(valor: string): number {
  const v = valor.replace(/[$\s]/g, "");
  if (v.includes(",")) return Number(v.replace(/\./g, "").replace(",", "."));
  if (/^\d{1,3}(\.\d{3})+$/.test(v)) return Number(v.replace(/\./g, ""));
  return Number(v);
}

/** Valor con el que arranca un campo al editar una fila. */
function valorInicial(campo: Campo, fila: Record<string, any> | null): string {
  const v = fila?.[campo.nombre];
  if (v === null || v === undefined || campo.tipo === "clave") return "";
  if (campo.tipo === "pesos") return String(v / 100);
  if (campo.tipo === "fecha") return fechaLocal(v);
  return String(v);
}

/** ISO → valor de un input datetime-local (hora del navegador). */
export const fechaLocal = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/** Tabla con alta, edición y baja, reutilizada para cada recurso del evento. */
function Recurso({
  titulo,
  ruta,
  campos,
  alCambiar,
  soloAlta = false,
  acciones,
  ayuda,
}: {
  titulo: string;
  ruta: string;
  campos: Campo[];
  alCambiar?: () => void;
  soloAlta?: boolean;
  /** Botones extra por fila (por ejemplo, vincular un posnet). */
  acciones?: (fila: Record<string, any>, recargar: () => Promise<void>) => ReactNode;
  ayuda?: ReactNode;
}) {
  const [filas, setFilas] = useState<Record<string, any>[]>([]);
  const [error, setError] = useState("");
  const [editando, setEditando] = useState<Record<string, any> | null>(null);
  const editables = campos.filter((c) => !c.soloLectura);

  const cargar = useCallback(() => api<Record<string, any>[]>("GET", ruta).then(setFilas), [ruta]);
  useEffect(() => {
    cargar().catch((e) => setError(e.message));
  }, [cargar]);

  const crear = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const datos = new FormData(form);
    const cuerpo: Record<string, unknown> = {};
    for (const c of editables) {
      const texto = String(datos.get(c.nombre) ?? "");
      // Al editar solo se manda lo que cambió: así no se pisa nada que el usuario no tocó.
      if (editando && texto === valorInicial(c, editando)) continue;
      const v = convertir(c, texto, editando !== null);
      if (v !== undefined) cuerpo[c.nombre] = v;
    }
    try {
      if (editando) await api("PATCH", `${ruta}/${editando.id}`, cuerpo);
      else await api("POST", ruta, cuerpo);
      form.reset();
      setEditando(null);
      setError("");
      await cargar();
      alCambiar?.();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const borrar = async (id: number) => {
    try {
      await api("DELETE", `${ruta}/${id}`);
      setError("");
      await cargar();
      alCambiar?.();
    } catch (err) {
      setError((err as Error).message);
    }
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
                  <div className="acciones">
                    {acciones?.(f, cargar)}
                    <button className="secundario" onClick={() => setEditando(f)}>
                      Editar
                    </button>
                    <button className="secundario" onClick={() => borrar(f.id)}>
                      Borrar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ayuda && <p className="ayuda">{ayuda}</p>}
      {/* La key reinicia el formulario al cambiar de fila, así toma los valores de la que se edita. */}
      <form onSubmit={crear} key={editando?.id ?? "nuevo"} className={editando ? "editando" : undefined}>
        {editando && <p className="ayuda">Editando «{editando.nombre}». Lo que dejes vacío no cambia.</p>}
        {editables.map((c) => (
          <label key={c.nombre}>
            {c.titulo}
            {c.tipo === "select" ? (
              <select name={c.nombre} defaultValue={valorInicial(c, editando)}>
                {c.opcional && <option value="">{c.textoVacio ?? "(ninguno)"}</option>}
                {/* Si la lista todavía no cargó, el valor actual igual figura, para no cambiarlo sin querer. */}
                {editando &&
                  valorInicial(c, editando) !== "" &&
                  !c.opciones!.some((o) => o.valor === valorInicial(c, editando)) && (
                    <option value={valorInicial(c, editando)}>(el actual)</option>
                  )}
                {c.opciones!.map((o) => (
                  <option key={o.valor} value={o.valor}>
                    {o.texto}
                  </option>
                ))}
              </select>
            ) : (
              <input
                name={c.nombre}
                type={c.tipo === "fecha" ? "datetime-local" : c.tipo === "clave" ? "password" : "text"}
                autoComplete={c.tipo === "clave" ? "new-password" : undefined}
                inputMode={c.tipo === "numero" || c.tipo === "pesos" ? "decimal" : undefined}
                required={!c.opcional && !editando}
                defaultValue={valorInicial(c, editando)}
              />
            )}
          </label>
        ))}
        <button>{editando ? "Guardar" : "Agregar"}</button>
        {editando && (
          <button type="button" className="secundario" onClick={() => setEditando(null)}>
            Cancelar
          </button>
        )}
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

const opciones = (valores: readonly string[]): Opcion[] => valores.map((v) => ({ valor: v, texto: v }));

const PESTANAS = [
  { id: "configuracion", texto: "Configuración" },
  { id: "caja", texto: "Cajas y arqueos" },
  { id: "ventas", texto: "Ventas" },
  { id: "stock", texto: "Stock" },
  { id: "vales", texto: "Vales" },
  { id: "revisar", texto: "Para revisar" },
] as const;
type Pestana = (typeof PESTANAS)[number]["id"];

function PantallaEvento({ evento, alCambiar, rol }: { evento: Evento; alCambiar: () => void; rol: Usuario["rol"] }) {
  const [pestana, setPestana] = useState<Pestana>("configuracion");
  // Los reportes son para supervisores y administradores.
  const veReportes = (ROLES_CONFIGURACION as readonly string[]).includes(rol);
  return (
    <>
      <section>
        <h2>{evento.nombre}</h2>
        <p>
          {evento.lugar ?? "Sin lugar"} · {fecha(evento.inicio)} a {fecha(evento.fin)}
        </p>
        {veReportes && (
          <nav className="pestanas">
            {PESTANAS.map((p) => (
              <button key={p.id} className={pestana === p.id ? "activo" : ""} onClick={() => setPestana(p.id)}>
                {p.texto}
              </button>
            ))}
          </nav>
        )}
      </section>
      {pestana === "configuracion" || !veReportes ? (
        <ConfiguracionEvento evento={evento} alCambiar={alCambiar} />
      ) : (
        <Reportes eventoId={evento.id} que={pestana} />
      )}
    </>
  );
}

const VALIDEZ: Record<(typeof VALIDEZ_VALES)[number], string> = {
  fin_evento: "Vencen al terminar el evento",
  fecha: "Vencen en una fecha y hora",
  sin_vencimiento: "No vencen (se canjean en otros eventos)",
};

/** Modo de venta, validez de los vales y plazo de anulación del evento. */
function OpcionesEvento({ evento, alCambiar }: { evento: Evento; alCambiar: () => void }) {
  const [validez, setValidez] = useState(evento.valesValidez);
  const [error, setError] = useState("");
  const [guardado, setGuardado] = useState(false);

  const guardar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const datos = new FormData(e.currentTarget);
    const vencimiento = String(datos.get("valesVencimiento") ?? "");
    try {
      await api("PATCH", `/eventos/${evento.id}`, {
        modoVenta: datos.get("modoVenta"),
        valesValidez: validez,
        valesVencimiento: validez === "fecha" && vencimiento ? new Date(vencimiento).toISOString() : null,
        minutosAnulacionCajero: Number(datos.get("minutosAnulacionCajero")),
      });
      setError("");
      setGuardado(true);
      alCambiar();
    } catch (err) {
      setError((err as Error).message);
      setGuardado(false);
    }
  };

  return (
    <section>
      <h2>Cómo se vende</h2>
      <form onSubmit={guardar} onChange={() => setGuardado(false)}>
        <label>
          Modo de venta
          <select name="modoVenta" defaultValue={evento.modoVenta}>
            <option value="vales">Con vales de consumo</option>
            <option value="directo">Directo (sin vales, comanda al sector)</option>
          </select>
        </label>
        <label>
          Vales
          <select value={validez} onChange={(e) => setValidez(e.target.value as typeof validez)}>
            {VALIDEZ_VALES.map((v) => (
              <option key={v} value={v}>
                {VALIDEZ[v]}
              </option>
            ))}
          </select>
        </label>
        {validez === "fecha" && (
          <label>
            Vencen el
            <input
              name="valesVencimiento"
              type="datetime-local"
              required
              defaultValue={evento.valesVencimiento ? fechaLocal(evento.valesVencimiento) : ""}
            />
          </label>
        )}
        <label>
          Minutos para que el cajero anule solo
          <input
            name="minutosAnulacionCajero"
            type="number"
            min={0}
            max={240}
            required
            defaultValue={evento.minutosAnulacionCajero}
          />
        </label>
        <button>Guardar</button>
        {guardado && <span className="ok">Guardado</span>}
      </form>
      {validez === "sin_vencimiento" && (
        <p className="ayuda">
          Un vale de este evento se puede canjear en otro evento tuyo que venda el mismo producto: se reconoce por el
          código del producto o, si no tiene, por el nombre.
        </p>
      )}
      <p className="ayuda">Pasado el plazo de anulación, hace falta la tarjeta de un supervisor.</p>
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function ConfiguracionEvento({ evento, alCambiar }: { evento: Evento; alCambiar: () => void }) {
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
  const siNo: Opcion[] = [
    { valor: "true", texto: "Sí" },
    { valor: "false", texto: "No" },
  ];

  return (
    <>
      <OpcionesEvento evento={evento} alCambiar={alCambiar} />
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
        ayuda="Un producto que ya se vendió no se puede borrar: editalo y ponelo como no disponible."
        campos={[
          { nombre: "nombre", titulo: "Nombre" },
          { nombre: "codigo", titulo: "Código", opcional: true, mostrar: (f) => f.codigo ?? "—" },
          { nombre: "categoria", titulo: "Categoría", opcional: true, mostrar: (f) => f.categoria ?? "—" },
          { nombre: "precio", titulo: "Precio ($)", tipo: "pesos", mostrar: (f) => pesos(f.precio) },
          {
            nombre: "sectorId",
            titulo: "Sector",
            tipo: "select",
            opciones: sectores,
            opcional: true,
            mostrar: (f) => nombreDe(sectores, f.sectorId),
          },
          {
            nombre: "controlaStock",
            titulo: "Controla stock",
            tipo: "select",
            opciones: [...siNo].reverse(),
            mostrar: (f) => (f.controlaStock ? "Sí" : "No"),
          },
          {
            nombre: "activo",
            titulo: "Disponible",
            tipo: "select",
            opciones: siNo,
            mostrar: (f) => (f.activo ? "Sí" : "No"),
          },
        ]}
      />
      <Recurso
        titulo="Puntos de venta"
        ruta={`${base}/puntos-venta`}
        ayuda="Una caja cobra; un puesto de canje (una barra) lee los vales. Si le asignás un sector, solo canjea los vales de ese sector."
        acciones={(f, recargar) => (
          <VincularPosnet ruta={`${base}/puntos-venta/${f.id}`} fila={f} alCambiar={recargar} />
        )}
        campos={[
          { nombre: "nombre", titulo: "Nombre" },
          { nombre: "plataforma", titulo: "Posnet", tipo: "select", opciones: opciones(PLATAFORMAS) },
          {
            nombre: "tipo",
            titulo: "Tipo",
            tipo: "select",
            opciones: [
              { valor: "caja", texto: "Caja" },
              { valor: "canje", texto: "Canje de vales" },
            ],
            mostrar: (f) => (f.tipo === "canje" ? "Canje de vales" : "Caja"),
          },
          {
            nombre: "sectorId",
            titulo: "Sector",
            tipo: "select",
            opciones: sectores,
            opcional: true,
            textoVacio: "Todos",
            mostrar: (f) => (f.sectorId ? nombreDe(sectores, f.sectorId) : "Todos"),
          },
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
          {
            nombre: "vistaProductos",
            titulo: "Productos en el posnet",
            tipo: "select",
            opciones: [
              { valor: "lista", texto: "Lista" },
              { valor: "fotos", texto: "Con fotos" },
            ],
            mostrar: (f) => (f.vistaProductos === "fotos" ? "Con fotos" : "Lista"),
          },
          {
            nombre: "ultimoContacto",
            titulo: "Último contacto",
            soloLectura: true,
            mostrar: (f) => (f.ultimoContacto ? fecha(f.ultimoContacto) : f.dispositivoVinculado ? "Nunca" : "Sin posnet"),
          },
        ]}
      />
    </>
  );
}

/** Genera la clave que se carga en la app del posnet. Se muestra una sola vez. */
function VincularPosnet({
  ruta,
  fila,
  alCambiar,
}: {
  ruta: string;
  fila: Record<string, any>;
  alCambiar: () => Promise<void>;
}) {
  const [clave, setClave] = useState<string | null>(null);
  const [error, setError] = useState("");

  const vincular = async () => {
    if (fila.dispositivoVinculado && !confirm("El posnet que está vinculado va a dejar de funcionar. ¿Seguimos?"))
      return;
    try {
      const { claveDispositivo } = await api<{ claveDispositivo: string }>("POST", `${ruta}/dispositivo`);
      setClave(claveDispositivo);
      setError("");
      await alCambiar();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <button className="secundario" onClick={vincular}>
        {fila.dispositivoVinculado ? "Volver a vincular" : "Vincular posnet"}
      </button>
      {clave && (
        <div className="aviso">
          Cargá esta clave en la app del posnet. No se vuelve a mostrar: <code>{clave}</code>
        </div>
      )}
      {error && <span className="error">{error}</span>}
    </>
  );
}

function PantallaUsuarios() {
  return (
    <Recurso
      titulo="Usuarios de la cuenta"
      ruta="/usuarios"
      ayuda="Quien ya vendió o autorizó algo no se puede borrar: desactivalo."
      campos={[
        { nombre: "nombre", titulo: "Nombre" },
        { nombre: "usuario", titulo: "Usuario" },
        { nombre: "rol", titulo: "Rol", tipo: "select", opciones: opciones(ROLES) },
        {
          nombre: "clave",
          titulo: "Clave (para el panel)",
          tipo: "clave",
          opcional: true,
          mostrar: (f) => (f.tieneClave ? "Sí" : "Solo tarjeta"),
        },
        { nombre: "nfcUid", titulo: "UID de la tarjeta NFC", opcional: true, mostrar: (f) => f.nfcUid ?? "—" },
        {
          nombre: "activo",
          titulo: "Activo",
          tipo: "select",
          opciones: [
            { valor: "true", texto: "Sí" },
            { valor: "false", texto: "No" },
          ],
          mostrar: (f) => (f.activo ? "Sí" : "No"),
        },
      ]}
    />
  );
}

function PantallaEventos({ alElegir }: { alElegir: (id: number) => void }) {
  const [eventos, setEventos] = useState<Evento[]>([]);
  const cargar = () => api<Evento[]>("GET", "/eventos").then(setEventos);
  useEffect(() => {
    cargar().catch(() => {});
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

type Yo = { usuario: Usuario; cuenta: Cuenta };

export function App() {
  const [yo, setYo] = useState<Yo | null>(null);
  const [cargando, setCargando] = useState(hayToken());
  const [pantalla, setPantalla] = useState<"eventos" | "usuarios">("eventos");
  const [eventoId, setEventoId] = useState<number | null>(null);
  const [evento, setEvento] = useState<Evento | null>(null);

  const cargarYo = useCallback(() => {
    if (!hayToken()) return setCargando(false);
    api<Yo>("GET", "/yo")
      .then(setYo)
      .catch(() => setYo(null))
      .finally(() => setCargando(false));
  }, []);

  // Al terminar la sesión (salir o vencida) se limpia todo, para que quien entre después no vea la pantalla anterior.
  const limpiar = useCallback(() => {
    setYo(null);
    setEventoId(null);
    setEvento(null);
    setPantalla("eventos");
  }, []);

  useEffect(() => {
    alVencerSesion(limpiar);
    cargarYo();
  }, [cargarYo, limpiar]);

  const cargarEvento = useCallback(() => {
    if (eventoId) api<Evento>("GET", `/eventos/${eventoId}`).then(setEvento, () => setEvento(null));
    else setEvento(null);
  }, [eventoId]);
  useEffect(cargarEvento, [cargarEvento]);

  const salir = async () => {
    await api("POST", "/auth/salir").catch(() => {});
    guardarToken(null);
    limpiar();
  };

  if (cargando) return null;
  if (!yo) return <Acceso alEntrar={cargarYo} />;

  return (
    <>
      <header>
        <strong>{yo.cuenta.nombre}</strong>
        <button
          className={pantalla === "eventos" ? "activo" : ""}
          onClick={() => (setPantalla("eventos"), setEventoId(null))}
        >
          Eventos
        </button>
        {yo.usuario.rol === "admin" && (
          <button className={pantalla === "usuarios" ? "activo" : ""} onClick={() => setPantalla("usuarios")}>
            Usuarios
          </button>
        )}
        <span className="espacio" />
        <span className="quien">
          {yo.usuario.nombre} ({yo.usuario.rol})
        </span>
        <button onClick={salir}>Salir</button>
      </header>
      <main>
        {pantalla === "usuarios" ? (
          <PantallaUsuarios />
        ) : evento ? (
          <PantallaEvento evento={evento} alCambiar={cargarEvento} rol={yo.usuario.rol} />
        ) : (
          <PantallaEventos alElegir={setEventoId} />
        )}
      </main>
    </>
  );
}
