import { beforeEach, describe, expect, it } from "vitest";
import { abrirDb } from "../src/db/index.js";
import { crearApp } from "../src/app.js";

let app: ReturnType<typeof crearApp>;

const pedir = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as any });
  return { status: res.statusCode, body: res.body ? res.json() : undefined };
};

const nuevoEvento = async (extra = {}) =>
  (
    await pedir("POST", "/api/eventos", {
      nombre: "Fiesta de prueba",
      inicio: "2026-11-01T20:00:00-03:00",
      fin: "2026-11-02T05:00:00-03:00",
      ...extra,
    })
  ).body;

beforeEach(() => {
  app = crearApp(abrirDb(":memory:"));
});

describe("eventos", () => {
  it("crea un evento con modo vales por defecto", async () => {
    const evento = await nuevoEvento();
    expect(evento).toMatchObject({ id: 1, modoVenta: "vales" });
    expect((await pedir("GET", "/api/eventos")).body).toHaveLength(1);
  });

  it("rechaza fechas invertidas y datos inválidos", async () => {
    expect(
      (
        await pedir("POST", "/api/eventos", {
          nombre: "X",
          inicio: "2026-11-02T00:00:00Z",
          fin: "2026-11-01T00:00:00Z",
        })
      ).status,
    ).toBe(400);
    expect((await pedir("POST", "/api/eventos", { nombre: "" })).status).toBe(400);
  });

  it("cambia el modo de venta sin tocar lo demás", async () => {
    const evento = await nuevoEvento();
    const { body } = await pedir("PATCH", `/api/eventos/${evento.id}`, { modoVenta: "directo" });
    expect(body).toMatchObject({ modoVenta: "directo", nombre: "Fiesta de prueba" });
  });

  it("al borrar un evento se borran sus productos", async () => {
    const evento = await nuevoEvento();
    await pedir("POST", `/api/eventos/${evento.id}/productos`, { nombre: "Cerveza", precio: 350000 });
    expect((await pedir("DELETE", `/api/eventos/${evento.id}`)).status).toBe(204);
    expect((await pedir("GET", `/api/eventos/${evento.id}/productos`)).status).toBe(404);
  });
});

describe("configuración del evento", () => {
  it("arma impresora, sector y producto enlazados", async () => {
    const evento = await nuevoEvento();
    const imp = (await pedir("POST", `/api/eventos/${evento.id}/impresoras`, { nombre: "Barra", host: "192.168.0.50" }))
      .body;
    expect(imp).toMatchObject({ puerto: 9100, anchoPapel: 80 });
    const sector = (await pedir("POST", `/api/eventos/${evento.id}/sectores`, { nombre: "Barra", impresoraId: imp.id }))
      .body;
    const prod = (
      await pedir("POST", `/api/eventos/${evento.id}/productos`, {
        nombre: "Fernet",
        precio: 500000,
        sectorId: sector.id,
      })
    ).body;
    expect(prod).toMatchObject({ sectorId: sector.id, activo: true });
  });

  it("un sector puede no tener impresora", async () => {
    const evento = await nuevoEvento();
    const { status, body } = await pedir("POST", `/api/eventos/${evento.id}/sectores`, { nombre: "Cocina" });
    expect(status).toBe(201);
    expect(body.impresoraId).toBeNull();
  });

  it("no deja usar un sector de otro evento", async () => {
    const a = await nuevoEvento();
    const b = await nuevoEvento({ nombre: "Otro" });
    const sectorB = (await pedir("POST", `/api/eventos/${b.id}/sectores`, { nombre: "Cocina" })).body;
    const res = await pedir("POST", `/api/eventos/${a.id}/productos`, {
      nombre: "Pancho",
      precio: 200000,
      sectorId: sectorB.id,
    });
    expect(res.status).toBe(400);
  });

  it("no deja editar un producto desde otro evento", async () => {
    const a = await nuevoEvento();
    const b = await nuevoEvento({ nombre: "Otro" });
    const prod = (await pedir("POST", `/api/eventos/${a.id}/productos`, { nombre: "Agua", precio: 100000 })).body;
    expect((await pedir("PATCH", `/api/eventos/${b.id}/productos/${prod.id}`, { precio: 1 })).status).toBe(404);
  });

  it("crea puntos de venta para Clover y Mercado Pago", async () => {
    const evento = await nuevoEvento();
    for (const plataforma of ["clover", "mercadopago"]) {
      expect(
        (await pedir("POST", `/api/eventos/${evento.id}/puntos-venta`, { nombre: `Caja ${plataforma}`, plataforma }))
          .status,
      ).toBe(201);
    }
    expect(
      (await pedir("POST", `/api/eventos/${evento.id}/puntos-venta`, { nombre: "Caja", plataforma: "posnet-x" }))
        .status,
    ).toBe(400);
  });
});

describe("staff y login NFC", () => {
  it("loguea con la tarjeta sin importar mayúsculas", async () => {
    await pedir("POST", "/api/staff", { nombre: "Ana", rol: "cajero", nfcUid: "04a1b2c3d4" });
    const { status, body } = await pedir("POST", "/api/staff/login-nfc", { nfcUid: "04A1B2C3D4" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ nombre: "Ana", rol: "cajero" });
  });

  it("rechaza tarjetas desconocidas, repetidas o de staff inactivo", async () => {
    const ana = (await pedir("POST", "/api/staff", { nombre: "Ana", rol: "cajero", nfcUid: "04A1B2C3" })).body;
    expect((await pedir("POST", "/api/staff", { nombre: "Beto", rol: "cajero", nfcUid: "04a1b2c3" })).status).toBe(409);
    expect((await pedir("POST", "/api/staff/login-nfc", { nfcUid: "DEADBEEF" })).status).toBe(401);
    await pedir("PATCH", `/api/staff/${ana.id}`, { activo: false });
    expect((await pedir("POST", "/api/staff/login-nfc", { nfcUid: "04A1B2C3" })).status).toBe(401);
  });
});
