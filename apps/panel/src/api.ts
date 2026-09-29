const CLAVE_TOKEN = "eventos.token";

// El token se guarda en el navegador para no pedir la clave en cada recarga.
// Si el almacenamiento no está disponible (modo privado, bloqueado), la sesión dura lo que la pestaña.
let token: string | null = (() => {
  try {
    return localStorage.getItem(CLAVE_TOKEN);
  } catch {
    return null;
  }
})();

let alVencer: () => void = () => {};

export const hayToken = () => token !== null;

export function guardarToken(nuevo: string | null) {
  token = nuevo;
  try {
    if (nuevo) localStorage.setItem(CLAVE_TOKEN, nuevo);
    else localStorage.removeItem(CLAVE_TOKEN);
  } catch {
    // Sin almacenamiento: queda solo en memoria.
  }
}

/** Qué hacer cuando la API dice que la sesión ya no vale (volver al login). */
export const alVencerSesion = (fn: () => void) => {
  alVencer = fn;
};

/** Cliente mínimo de la API. Tira un Error con el mensaje del servidor si algo falla. */
export async function api<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (cuerpo !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${ruta}`, {
    method: metodo,
    headers,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  if (res.status === 204) return undefined as T;
  const datos = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    guardarToken(null);
    alVencer();
  }
  if (!res.ok) {
    // Si la API explica qué campo está mal, se muestra eso en lugar de un "Datos inválidos" genérico.
    const detalle = Object.values((datos.detalles ?? {}) as Record<string, string[]>).flat()[0];
    throw new Error(detalle ?? datos.error ?? `Error ${res.status}`);
  }
  return datos as T;
}

export const pesos = (centavos: number) =>
  (centavos / 100).toLocaleString("es-AR", { style: "currency", currency: "ARS" });

export const fecha = (iso: string) =>
  new Date(iso).toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short", hour12: false });

export const hora = (iso: string) => new Date(iso).toLocaleTimeString("es-AR", { timeStyle: "short", hour12: false });
