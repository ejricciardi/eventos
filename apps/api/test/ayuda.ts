import { expect } from "vitest";
import { abrirDb, type Db } from "../src/db/index.js";
import { crearApp, type OpcionesApp } from "../src/app.js";

// Ayudas para las pruebas: cada archivo de pruebas tiene su propia base en memoria.

export let db: Db;
export let app: ReturnType<typeof crearApp>;

export type Metodo = "GET" | "POST" | "PATCH" | "DELETE";

export const pedir = async (
  method: Metodo,
  url: string,
  { token, payload, headers = {} }: { token?: string; payload?: unknown; headers?: Record<string, string> } = {},
) => {
  const res = await app.inject({
    method,
    url,
    payload: payload as any,
    headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers,
  });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};

/** Cliente con sesión: pedir() con el token ya puesto. */
export const como = (token: string) => (method: Metodo, url: string, payload?: unknown, headers?: Record<string, string>) =>
  pedir(method, url, { token, payload, headers });

export const iniciar = (opciones: OpcionesApp = {}) => {
  db = abrirDb(":memory:");
  app = crearApp(db, opciones);
};

export const registrar = async (usuario = "edu", cuenta = "Producciones Edu") => {
  const res = await pedir("POST", "/api/registro", {
    payload: { cuenta, nombre: "Edu", usuario, clave: "clave-segura-1" },
  });
  expect(res.status).toBe(201);
  return res.body as { token: string; usuario: { id: number }; cuenta: { id: number } };
};

export const login = async (usuario: string, clave: string) =>
  pedir("POST", "/api/auth/login", { payload: { usuario, clave } });

export const nuevoEvento = async (api: ReturnType<typeof como>, extra = {}) => {
  const res = await api("POST", "/api/eventos", {
    nombre: "Fiesta de prueba",
    inicio: "2026-11-01T20:00:00-03:00",
    fin: "2026-11-02T05:00:00-03:00",
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body;
};

/** Crea un usuario en la cuenta del admin y devuelve un cliente logueado con usuario y clave. */
export const crearUsuario = async (admin: ReturnType<typeof como>, datos: Record<string, unknown>) => {
  const res = await admin("POST", "/api/usuarios", { clave: "otra-clave-1", ...datos });
  expect(res.status).toBe(201);
  return res.body;
};

/** Vincula un posnet a un punto de venta nuevo y devuelve su clave de dispositivo. */
export const vincularPosnet = async (
  admin: ReturnType<typeof como>,
  eventoId: number,
  datosPv: Record<string, unknown> = {},
) => {
  const pv = (
    await admin("POST", `/api/eventos/${eventoId}/puntos-venta`, { nombre: "Caja 1", plataforma: "clover", ...datosPv })
  ).body;
  const res = await admin("POST", `/api/eventos/${eventoId}/puntos-venta/${pv.id}/dispositivo`);
  expect(res.status).toBe(200);
  return { pv, claveDispositivo: res.body.claveDispositivo as string, dispositivoId: res.body.dispositivoId as string };
};

export const loginNfc = (claveDispositivo: string | undefined, nfcUid: string) =>
  pedir("POST", "/api/auth/nfc", {
    payload: { nfcUid },
    headers: claveDispositivo ? { "x-clave-dispositivo": claveDispositivo } : {},
  });

