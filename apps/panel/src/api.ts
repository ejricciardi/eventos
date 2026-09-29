/** Cliente mínimo de la API. Tira un Error con el mensaje del servidor si algo falla. */
export async function api<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
  const res = await fetch(`/api${ruta}`, {
    method: metodo,
    headers: cuerpo === undefined ? undefined : { "Content-Type": "application/json" },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  if (res.status === 204) return undefined as T;
  const datos = await res.json();
  if (!res.ok) throw new Error(datos.error ?? `Error ${res.status}`);
  return datos as T;
}

export const pesos = (centavos: number) =>
  (centavos / 100).toLocaleString("es-AR", { style: "currency", currency: "ARS" });
