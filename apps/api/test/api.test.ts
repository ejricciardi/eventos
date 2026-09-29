import { beforeEach, describe, expect, it } from "vitest";
import { sesiones } from "../src/db/schema.js";
import { app, como, crearUsuario, db, iniciar, login, loginNfc, nuevoEvento, pedir, registrar, vincularPosnet } from "./ayuda.js";

beforeEach(() => iniciar());

describe("registro y acceso con usuario y clave", () => {
  it("la primera cuenta se registra y queda logueada como admin", async () => {
    const { token } = await registrar();
    const { body } = await como(token)("GET", "/api/yo");
    expect(body).toMatchObject({ usuario: { usuario: "edu", rol: "admin", tieneClave: true }, origen: "clave" });
    expect(JSON.stringify(body)).not.toContain("claveHash");
  });

  it("después de la primera cuenta el registro se cierra, salvo que se habilite", async () => {
    await registrar();
    expect((await pedir("GET", "/api/registro")).body).toEqual({ abierto: false });
    const res = await pedir("POST", "/api/registro", {
      payload: { cuenta: "Otra", nombre: "X", usuario: "otro", clave: "clave-segura-2" },
    });
    expect(res.status).toBe(403);

    iniciar({ registroAbierto: true });
    await registrar("uno", "Uno");
    await registrar("dos", "Dos");
  });

  it("entra con usuario y clave, sin importar mayúsculas en el usuario", async () => {
    await registrar();
    const res = await login("EDU", "clave-segura-1");
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
  });

  it("rechaza clave incorrecta, usuario inexistente y usuarios sin clave", async () => {
    const { token } = await registrar();
    await crearUsuario(como(token), {
      nombre: "Ana",
      usuario: "ana",
      rol: "cajero",
      clave: undefined,
      nfcUid: "04A1B2C3",
    });
    expect((await login("edu", "clave-mala")).status).toBe(401);
    expect((await login("nadie", "clave-segura-1")).status).toBe(401);
    expect((await login("ana", "cualquier-cosa")).status).toBe(401);
  });

  it("sin sesión, con token inventado o vencido no deja pasar", async () => {
    const { token } = await registrar();
    expect((await pedir("GET", "/api/eventos")).status).toBe(401);
    expect((await pedir("GET", "/api/eventos", { token: "inventado" })).status).toBe(401);
    db.update(sesiones).set({ expira: "2000-01-01T00:00:00.000Z" }).run();
    expect((await pedir("GET", "/api/eventos", { token })).status).toBe(401);
  });

  it("al salir, el token deja de valer", async () => {
    const { token } = await registrar();
    expect((await como(token)("POST", "/api/auth/salir")).status).toBe(204);
    expect((await como(token)("GET", "/api/yo")).status).toBe(401);
  });

  it("limita los intentos de login por usuario, sin bloquear a los demás de la misma IP", async () => {
    const admin = como((await registrar()).token);
    await crearUsuario(admin, { nombre: "Ana", usuario: "ana", rol: "supervisor" });
    const estados = [];
    for (let i = 0; i < 11; i++) estados.push((await login("edu", "clave-mala")).status);
    expect(estados.slice(0, 10).every((e) => e === 401)).toBe(true);
    expect(estados.at(-1)).toBe(429);
    expect((await login("ana", "otra-clave-1")).status).toBe(200);
  });

  it("detrás de un proxy (trustProxy) cuenta los intentos por IP real del cliente", async () => {
    iniciar({ trustProxy: true });
    await registrar();
    const desde = (ip: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/login",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": ip },
        payload: { usuario: "edu", clave: "clave-mala" },
      });
    for (let i = 0; i < 10; i++) await desde("198.51.100.66");
    expect((await desde("198.51.100.66")).statusCode).toBe(429);
    expect((await desde("203.0.113.20")).statusCode).toBe(401);
  });
});

describe("usuarios de la cuenta", () => {
  it("el admin crea usuarios y nunca ve el hash de la clave", async () => {
    const admin = como((await registrar()).token);
    const ana = await crearUsuario(admin, { nombre: "Ana", usuario: "ana", rol: "cajero" });
    expect(ana).toMatchObject({ usuario: "ana", tieneClave: true, nfcUid: null });
    const lista = (await admin("GET", "/api/usuarios")).body;
    expect(lista).toHaveLength(2);
    expect(JSON.stringify(lista)).not.toMatch(/claveHash|scrypt/);
  });

  it("usuario y tarjeta no se pueden repetir", async () => {
    const admin = como((await registrar()).token);
    await crearUsuario(admin, { nombre: "Ana", usuario: "ana", rol: "cajero", nfcUid: "04a1b2c3" });
    expect((await admin("POST", "/api/usuarios", { nombre: "Otra", usuario: "ana", rol: "cajero" })).status).toBe(409);
    expect(
      (await admin("POST", "/api/usuarios", { nombre: "Beto", usuario: "beto", rol: "cajero", nfcUid: "04A1B2C3" }))
        .status,
    ).toBe(409);
  });

  it("la misma tarjeta puede estar en dos cuentas distintas", async () => {
    iniciar({ registroAbierto: true });
    const adminA = como((await registrar("cuenta-a", "A")).token);
    const adminB = como((await registrar("cuenta-b", "B")).token);
    await crearUsuario(adminA, { nombre: "Ana", usuario: "ana-a", rol: "cajero", nfcUid: "04A1B2C3" });
    const res = await adminB("POST", "/api/usuarios", {
      nombre: "Ana",
      usuario: "ana-b",
      rol: "cajero",
      nfcUid: "04a1b2c3",
    });
    expect(res.status).toBe(201);
  });

  it("el admin no se puede quitar el acceso a sí mismo", async () => {
    const { token, usuario } = await registrar();
    const admin = como(token);
    expect((await admin("PATCH", `/api/usuarios/${usuario.id}`, { rol: "cajero" })).status).toBe(400);
    expect((await admin("PATCH", `/api/usuarios/${usuario.id}`, { activo: false })).status).toBe(400);
    expect((await admin("DELETE", `/api/usuarios/${usuario.id}`)).status).toBe(400);
  });

  it("cambiar la clave o desactivar a alguien le cierra las sesiones", async () => {
    const admin = como((await registrar()).token);
    const ana = await crearUsuario(admin, { nombre: "Ana", usuario: "ana", rol: "supervisor" });
    const tokenAna = (await login("ana", "otra-clave-1")).body.token;
    await admin("PATCH", `/api/usuarios/${ana.id}`, { clave: "clave-nueva-1" });
    expect((await como(tokenAna)("GET", "/api/yo")).status).toBe(401);
    expect((await login("ana", "clave-nueva-1")).status).toBe(200);

    await admin("PATCH", `/api/usuarios/${ana.id}`, { activo: false });
    expect((await login("ana", "clave-nueva-1")).status).toBe(401);
  });

  it("solo el admin maneja usuarios; supervisor configura eventos; cajero solo mira", async () => {
    const admin = como((await registrar()).token);
    await crearUsuario(admin, { nombre: "Sol", usuario: "sol", rol: "supervisor" });
    await crearUsuario(admin, { nombre: "Caro", usuario: "caro", rol: "cajero" });
    const supervisor = como((await login("sol", "otra-clave-1")).body.token);
    const cajero = como((await login("caro", "otra-clave-1")).body.token);

    expect((await supervisor("GET", "/api/usuarios")).status).toBe(403);
    const evento = await nuevoEvento(supervisor);
    expect((await cajero("GET", `/api/eventos/${evento.id}`)).status).toBe(200);
    expect((await cajero("PATCH", `/api/eventos/${evento.id}`, { nombre: "Otro" })).status).toBe(403);
    expect((await cajero("POST", `/api/eventos/${evento.id}/productos`, { nombre: "X", precio: 1 })).status).toBe(403);
  });
});

describe("aislamiento entre cuentas", () => {
  it("una cuenta no ve ni toca los eventos, recursos ni usuarios de otra", async () => {
    iniciar({ registroAbierto: true });
    const a = await registrar("cuenta-a", "Cuenta A");
    const b = await registrar("cuenta-b", "Cuenta B");
    const adminA = como(a.token);
    const adminB = como(b.token);

    const eventoA = await nuevoEvento(adminA);
    const prodA = (await adminA("POST", `/api/eventos/${eventoA.id}/productos`, { nombre: "Agua", precio: 100000 }))
      .body;
    const anaA = await crearUsuario(adminA, { nombre: "Ana", usuario: "ana", rol: "cajero" });

    expect((await adminB("GET", "/api/eventos")).body).toEqual([]);
    expect((await adminB("GET", `/api/eventos/${eventoA.id}`)).status).toBe(404);
    expect((await adminB("PATCH", `/api/eventos/${eventoA.id}`, { nombre: "Hackeado" })).status).toBe(404);
    expect((await adminB("DELETE", `/api/eventos/${eventoA.id}`)).status).toBe(404);
    expect((await adminB("GET", `/api/eventos/${eventoA.id}/productos`)).status).toBe(404);
    expect((await adminB("PATCH", `/api/eventos/${eventoA.id}/productos/${prodA.id}`, { precio: 1 })).status).toBe(404);
    expect((await adminB("GET", "/api/usuarios")).body.map((u: any) => u.usuario)).toEqual(["cuenta-b"]);
    expect((await adminB("PATCH", `/api/usuarios/${anaA.id}`, { clave: "robada-123" })).status).toBe(404);
    expect((await adminB("DELETE", `/api/usuarios/${anaA.id}`)).status).toBe(404);

    // Un sector de B no se puede asignar a un producto de A aunque se conozca su id.
    const eventoB = await nuevoEvento(adminB);
    const sectorB = (await adminB("POST", `/api/eventos/${eventoB.id}/sectores`, { nombre: "Barra" })).body;
    expect(
      (await adminA("PATCH", `/api/eventos/${eventoA.id}/productos/${prodA.id}`, { sectorId: sectorB.id })).status,
    ).toBe(400);
  });
});

describe("acceso con tarjeta NFC desde el posnet", () => {
  it("con un posnet vinculado, la tarjeta abre sesión en ese punto de venta", async () => {
    const admin = como((await registrar()).token);
    await crearUsuario(admin, { nombre: "Ana", usuario: "ana", rol: "cajero", nfcUid: "04a1b2c3d4" });
    const evento = await nuevoEvento(admin);
    const { pv, claveDispositivo } = await vincularPosnet(admin, evento.id);

    const res = await loginNfc(claveDispositivo, "04A1B2C3D4");
    expect(res.status).toBe(200);
    const yo = (await como(res.body.token)("GET", "/api/yo")).body;
    expect(yo).toMatchObject({ usuario: { usuario: "ana" }, origen: "nfc", puntoVentaId: pv.id });
  });

  it("el punto de venta no expone la clave del dispositivo", async () => {
    const admin = como((await registrar()).token);
    const evento = await nuevoEvento(admin);
    await vincularPosnet(admin, evento.id);
    const lista = (await admin("GET", `/api/eventos/${evento.id}/puntos-venta`)).body;
    expect(lista[0].dispositivoVinculado).toBe(true);
    expect(JSON.stringify(lista)).not.toContain("claveDispositivo");
  });

  it("sin posnet vinculado, con tarjeta desconocida o de otra cuenta no entra", async () => {
    iniciar({ registroAbierto: true });
    const adminA = como((await registrar("cuenta-a", "A")).token);
    const adminB = como((await registrar("cuenta-b", "B")).token);
    await crearUsuario(adminB, { nombre: "Beto", usuario: "beto", rol: "cajero", nfcUid: "BBBBBBBB" });
    const evento = await nuevoEvento(adminA);
    const { claveDispositivo } = await vincularPosnet(adminA, evento.id);

    expect((await loginNfc(undefined, "BBBBBBBB")).status).toBe(401);
    expect((await loginNfc("clave-inventada", "BBBBBBBB")).status).toBe(401);
    expect((await loginNfc(claveDispositivo, "DEADBEEF")).status).toBe(401);
    expect((await loginNfc(claveDispositivo, "BBBBBBBB")).status).toBe(401);
  });

  it("en el cambio de turno entran muchos cajeros por la misma IP sin trabarse", async () => {
    const admin = como((await registrar()).token);
    const evento = await nuevoEvento(admin);
    const posnets = [];
    for (let i = 0; i < 4; i++) posnets.push((await vincularPosnet(admin, evento.id)).claveDispositivo);
    for (let i = 0; i < 40; i++) {
      const uid = (0x10000000 + i).toString(16).toUpperCase();
      await crearUsuario(admin, { nombre: `Cajero ${i}`, usuario: `cajero${i}`, rol: "cajero", nfcUid: uid });
    }
    const estados = [];
    for (let i = 0; i < 40; i++) {
      estados.push((await loginNfc(posnets[i % 4], (0x10000000 + i).toString(16).toUpperCase())).status);
    }
    expect(new Set(estados)).toEqual(new Set([200]));
  });

  it("un usuario desactivado no entra con su tarjeta", async () => {
    const admin = como((await registrar()).token);
    const ana = await crearUsuario(admin, { nombre: "Ana", usuario: "ana", rol: "cajero", nfcUid: "04A1B2C3" });
    const evento = await nuevoEvento(admin);
    const { claveDispositivo } = await vincularPosnet(admin, evento.id);
    await admin("PATCH", `/api/usuarios/${ana.id}`, { activo: false });
    expect((await loginNfc(claveDispositivo, "04A1B2C3")).status).toBe(401);
  });

  it("con tarjeta no se puede cambiar la configuración, aunque sea admin", async () => {
    const { token, usuario } = await registrar();
    const admin = como(token);
    await admin("PATCH", `/api/usuarios/${usuario.id}`, { nfcUid: "AAAAAAAA" });
    const evento = await nuevoEvento(admin);
    const { claveDispositivo } = await vincularPosnet(admin, evento.id);
    const porTarjeta = como((await loginNfc(claveDispositivo, "AAAAAAAA")).body.token);

    expect((await porTarjeta("GET", `/api/eventos/${evento.id}/productos`)).status).toBe(200);
    expect((await porTarjeta("PATCH", `/api/eventos/${evento.id}`, { nombre: "X" })).status).toBe(403);
    expect((await porTarjeta("GET", "/api/usuarios")).status).toBe(403);
  });

  it("volver a vincular el posnet invalida la clave vieja y sus sesiones", async () => {
    const admin = como((await registrar()).token);
    await crearUsuario(admin, { nombre: "Ana", usuario: "ana", rol: "cajero", nfcUid: "04A1B2C3" });
    const evento = await nuevoEvento(admin);
    const { pv, claveDispositivo } = await vincularPosnet(admin, evento.id);
    const tokenAna = (await loginNfc(claveDispositivo, "04A1B2C3")).body.token;

    const nueva = (await admin("POST", `/api/eventos/${evento.id}/puntos-venta/${pv.id}/dispositivo`)).body
      .claveDispositivo;
    expect((await como(tokenAna)("GET", "/api/yo")).status).toBe(401);
    expect((await loginNfc(claveDispositivo, "04A1B2C3")).status).toBe(401);
    expect((await loginNfc(nueva, "04A1B2C3")).status).toBe(200);

    await admin("DELETE", `/api/eventos/${evento.id}/puntos-venta/${pv.id}/dispositivo`);
    expect((await loginNfc(nueva, "04A1B2C3")).status).toBe(401);
  });
});

describe("eventos y su configuración", () => {
  let admin: ReturnType<typeof como>;
  beforeEach(async () => {
    admin = como((await registrar()).token);
  });

  it("crea un evento con modo vales por defecto", async () => {
    const evento = await nuevoEvento(admin);
    expect(evento).toMatchObject({ modoVenta: "vales" });
    expect((await admin("GET", "/api/eventos")).body).toHaveLength(1);
  });

  it("rechaza fechas invertidas y datos inválidos", async () => {
    expect(
      (
        await admin("POST", "/api/eventos", {
          nombre: "X",
          inicio: "2026-11-02T00:00:00Z",
          fin: "2026-11-01T00:00:00Z",
        })
      ).status,
    ).toBe(400);
    expect((await admin("POST", "/api/eventos", { nombre: "" })).status).toBe(400);
  });

  it("cambia el modo de venta sin tocar lo demás", async () => {
    const evento = await nuevoEvento(admin);
    const { body } = await admin("PATCH", `/api/eventos/${evento.id}`, { modoVenta: "directo" });
    expect(body).toMatchObject({ modoVenta: "directo", nombre: "Fiesta de prueba" });
  });

  it("al borrar un evento se borran sus productos", async () => {
    const evento = await nuevoEvento(admin);
    await admin("POST", `/api/eventos/${evento.id}/productos`, { nombre: "Cerveza", precio: 350000 });
    expect((await admin("DELETE", `/api/eventos/${evento.id}`)).status).toBe(204);
    expect((await admin("GET", `/api/eventos/${evento.id}/productos`)).status).toBe(404);
  });

  it("arma impresora, sector y producto enlazados", async () => {
    const evento = await nuevoEvento(admin);
    const imp = (await admin("POST", `/api/eventos/${evento.id}/impresoras`, { nombre: "Barra", host: "192.168.0.50" }))
      .body;
    expect(imp).toMatchObject({ puerto: 9100, anchoPapel: 80 });
    const sector = (await admin("POST", `/api/eventos/${evento.id}/sectores`, { nombre: "Barra", impresoraId: imp.id }))
      .body;
    const prod = (
      await admin("POST", `/api/eventos/${evento.id}/productos`, {
        nombre: "Fernet",
        precio: 500000,
        sectorId: sector.id,
      })
    ).body;
    expect(prod).toMatchObject({ sectorId: sector.id, activo: true });
  });

  it("un sector puede no tener impresora", async () => {
    const evento = await nuevoEvento(admin);
    const { status, body } = await admin("POST", `/api/eventos/${evento.id}/sectores`, { nombre: "Cocina" });
    expect(status).toBe(201);
    expect(body.impresoraId).toBeNull();
  });

  it("no deja usar un sector de otro evento", async () => {
    const a = await nuevoEvento(admin);
    const b = await nuevoEvento(admin, { nombre: "Otro" });
    const sectorB = (await admin("POST", `/api/eventos/${b.id}/sectores`, { nombre: "Cocina" })).body;
    const res = await admin("POST", `/api/eventos/${a.id}/productos`, {
      nombre: "Pancho",
      precio: 200000,
      sectorId: sectorB.id,
    });
    expect(res.status).toBe(400);
  });

  it("no deja editar un producto desde otro evento", async () => {
    const a = await nuevoEvento(admin);
    const b = await nuevoEvento(admin, { nombre: "Otro" });
    const prod = (await admin("POST", `/api/eventos/${a.id}/productos`, { nombre: "Agua", precio: 100000 })).body;
    expect((await admin("PATCH", `/api/eventos/${b.id}/productos/${prod.id}`, { precio: 1 })).status).toBe(404);
  });

  it("crea puntos de venta para Clover y Mercado Pago", async () => {
    const evento = await nuevoEvento(admin);
    for (const plataforma of ["clover", "mercadopago"]) {
      const res = await admin("POST", `/api/eventos/${evento.id}/puntos-venta`, {
        nombre: `Caja ${plataforma}`,
        plataforma,
      });
      expect(res.status).toBe(201);
      expect(res.body.dispositivoVinculado).toBe(false);
    }
    expect(
      (await admin("POST", `/api/eventos/${evento.id}/puntos-venta`, { nombre: "Caja", plataforma: "posnet-x" }))
        .status,
    ).toBe(400);
  });
});
