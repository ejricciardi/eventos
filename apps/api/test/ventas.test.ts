import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { hashNfc } from "../src/seguridad.js";
import { como, crearUsuario, iniciar, loginNfc, nuevoEvento, pedir, registrar, vincularPosnet } from "./ayuda.js";

type Api = ReturnType<typeof como>;

// Hora base de las operaciones (durante el evento de prueba) y minutos después.
const HORA = Date.parse("2026-11-02T00:00:00.000Z");
const a = (minutos: number) => new Date(HORA + minutos * 60_000).toISOString();

/** Simula la app del posnet: numera sus operaciones, firma vales y sube lo que tiene. */
class Posnet {
  seq = 0;
  numero = 0;
  private claves = generateKeyPairSync("ed25519");
  constructor(
    public clave: string,
    public id: string,
    public eventoId: number,
  ) {}

  get clavePublica() {
    return this.claves.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  }

  pedir(method: "GET" | "POST", url: string, payload?: unknown) {
    return pedir(method, url, { payload, headers: { "x-clave-dispositivo": this.clave } });
  }

  registrarClave() {
    return this.pedir("POST", "/api/dispositivo/clave-publica", { clavePublica: this.clavePublica });
  }

  // Operación tal como la arma el posnet. Se tipa suelta para poder armar también operaciones mal hechas.
  op(tipo: string, datos: Record<string, unknown>, minuto = 0): Record<string, any> {
    return { id: randomUUID(), seq: ++this.seq, creada: a(minuto), tipo, ...datos };
  }

  vale(productoId: number, sectorId: number | null, minuto = 0, firmante: KeyObject = this.claves.privateKey) {
    const valeId = randomUUID();
    const contenido = { v: 1, e: this.eventoId, i: valeId, p: productoId, s: sectorId, d: this.id, t: a(minuto) };
    const texto = Buffer.from(JSON.stringify(contenido)).toString("base64url");
    const firma = sign(null, Buffer.from(texto), firmante).toString("base64url");
    return { valeId, qr: `${texto}.${firma}` };
  }

  /** Arma una venta. Con `conVales`, un vale firmado por unidad. */
  venta(
    turnoId: string,
    usuarioId: number,
    items: { producto: { id: number; nombre: string; precio: number; sectorId: number | null }; cantidad: number }[],
    { medio = "efectivo", minuto = 0, conVales = false, extra = {} as Record<string, unknown> } = {},
  ) {
    const total = items.reduce((s, i) => s + i.producto.precio * i.cantidad, 0);
    const vales = conVales
      ? items.flatMap((i, item) =>
          Array.from({ length: i.cantidad }, () => ({ ...this.vale(i.producto.id, i.producto.sectorId, minuto), item })),
        )
      : [];
    return this.op(
      "venta",
      {
        ventaId: randomUUID(),
        turnoId,
        usuarioId,
        numero: ++this.numero,
        items: items.map((i) => ({
          productoId: i.producto.id,
          nombre: i.producto.nombre,
          precioUnitario: i.producto.precio,
          cantidad: i.cantidad,
        })),
        pagos: [{ medio, monto: total }],
        vales,
        ...extra,
      },
      minuto,
    );
  }

  async subir(...operaciones: unknown[]) {
    const res = await this.pedir("POST", "/api/dispositivo/sincronizar", { reloj: new Date().toISOString(), operaciones });
    expect(res.status).toBe(200);
    return res.body as {
      resultados: { id: string | null; estado: string; error?: string; observaciones?: string[] }[];
      ultimaSeqContigua: number;
    };
  }

  consultar(qr: string) {
    return this.pedir("POST", "/api/dispositivo/canjes/consultar", { qr });
  }
}

/** Evento con barra y cocina, un cajero, un supervisor, una caja y una barra que canjea. */
async function armarEvento(extraEvento: Record<string, unknown> = {}) {
  const registro = await registrar();
  const admin = como(registro.token);
  const evento = await nuevoEvento(admin, extraEvento);
  const base = `/api/eventos/${evento.id}`;
  const barra = (await admin("POST", `${base}/sectores`, { nombre: "Barra" })).body;
  const cocina = (await admin("POST", `${base}/sectores`, { nombre: "Cocina" })).body;
  const cerveza = (
    await admin("POST", `${base}/productos`, { nombre: "Cerveza", codigo: "CERV", precio: 300000, sectorId: barra.id, controlaStock: true })
  ).body;
  const hamburguesa = (await admin("POST", `${base}/productos`, { nombre: "Hamburguesa", precio: 800000, sectorId: cocina.id }))
    .body;
  const cajero = await crearUsuario(admin, { nombre: "Ana", usuario: "ana", rol: "cajero", nfcUid: "04A1B2C3" });
  const supervisor = await crearUsuario(admin, { nombre: "Sergio", usuario: "sergio", rol: "supervisor", nfcUid: "05A1B2C3" });
  const caja = await vincularPosnet(admin, evento.id);
  const posnet = new Posnet(caja.claveDispositivo, caja.dispositivoId, evento.id);
  expect((await posnet.registrarClave()).status).toBe(200);
  const puestoBarra = await vincularPosnet(admin, evento.id, { nombre: "Barra 1", tipo: "canje", sectorId: barra.id });
  const lectorBarra = new Posnet(puestoBarra.claveDispositivo, puestoBarra.dispositivoId, evento.id);
  return { registro, admin, evento, base, barra, cocina, cerveza, hamburguesa, cajero, supervisor, caja, posnet, puestoBarra, lectorBarra };
}

/** Abre un turno en el posnet y devuelve su id y la operación. */
const abrirTurno = (posnet: Posnet, usuarioId: number, fondoInicial = 1000000, minuto = 0) => {
  const turnoId = randomUUID();
  return { turnoId, op: posnet.op("apertura_turno", { turnoId, usuarioId, fondoInicial }, minuto) };
};

beforeEach(() => iniciar());

describe("posnet vinculado", () => {
  it("baja la configuración para trabajar sin conexión, sin UID de tarjetas ni claves", async () => {
    const e = await armarEvento();
    const res = await e.posnet.pedir("GET", "/api/dispositivo/configuracion");
    expect(res.status).toBe(200);
    const c = res.body;
    expect(c.evento).toMatchObject({ id: e.evento.id, modoVenta: "vales", vencimientoVales: e.evento.fin });
    expect(c.puntoVenta).toMatchObject({ id: e.caja.pv.id, imprimeVales: true, tipo: "caja", vistaProductos: "lista" });
    expect(c.productos.map((p: { nombre: string }) => p.nombre)).toEqual(["Cerveza", "Hamburguesa"]);
    const ana = c.personal.find((p: { id: number }) => p.id === e.cajero.id);
    expect(ana.nfcHash).toBe(await hashNfc(e.registro.cuenta.id, "04A1B2C3"));
    expect(JSON.stringify(c)).not.toContain("04A1B2C3");
    expect(JSON.stringify(c)).not.toContain("claveHash");
    expect(c.clavesPublicas).toEqual([{ dispositivoId: e.posnet.id, eventoId: e.evento.id, clavePublica: e.posnet.clavePublica }]);
    expect(c.version).toMatch(/^[0-9a-f]{16}$/);
  });

  it("sin clave o con una inventada no entra", async () => {
    await armarEvento();
    expect((await pedir("GET", "/api/dispositivo/configuracion")).status).toBe(401);
    const trucho = new Posnet("inventada", randomUUID(), 1);
    expect((await trucho.pedir("GET", "/api/dispositivo/configuracion")).status).toBe(401);
  });

  it("la clave pública se registra una sola vez y tiene que ser Ed25519", async () => {
    const e = await armarEvento();
    expect((await e.posnet.registrarClave()).status).toBe(200);
    const otra = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect((await e.posnet.pedir("POST", "/api/dispositivo/clave-publica", { clavePublica: otra })).status).toBe(409);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" });
    expect(
      (await e.lectorBarra.pedir("POST", "/api/dispositivo/clave-publica", { clavePublica: rsa.toString("base64") })).status,
    ).toBe(400);
  });

  it("al volver a vincular, el posnet anterior ya no baja configuración pero termina de subir lo que vendió", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    await e.admin("POST", `${e.base}/puntos-venta/${e.caja.pv.id}/dispositivo`);
    expect((await e.posnet.pedir("GET", "/api/dispositivo/configuracion")).status).toBe(401);
    expect((await loginNfc(e.posnet.clave, "04A1B2C3")).status).toBe(401);
    const { resultados } = await e.posnet.subir(op, e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]));
    expect(resultados.map((r) => r.estado)).toEqual(["ok", "ok"]);
    expect(resultados[1].observaciones).toContain("dispositivo_revocado");
  });
});

describe("ventas, turnos y arqueo", () => {
  it("un turno completo en efectivo cierra con el arqueo justo", async () => {
    const e = await armarEvento();
    const { turnoId, op: apertura } = abrirTurno(e.posnet, e.cajero.id, 1000000);
    const v1 = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 2 }, { producto: e.hamburguesa, cantidad: 1 }], {
      conVales: true,
      minuto: 5,
    });
    const v2 = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }], { medio: "debito", minuto: 6 });
    const retiro = e.posnet.op(
      "movimiento_caja",
      { movimientoId: randomUUID(), turnoId, movimiento: "retiro", monto: 500000, motivo: "Retiro a tesorería", usuarioId: e.cajero.id, autorizadoPorId: e.supervisor.id },
      30,
    );
    const cierre = e.posnet.op(
      "cierre_turno",
      { turnoId, usuarioId: e.cajero.id, efectivoDeclarado: 1900000, cantidadVentas: 2, totalesPorMedio: { efectivo: 1400000, debito: 300000 } },
      60,
    );
    const { resultados, ultimaSeqContigua } = await e.posnet.subir(apertura, v1, v2, retiro, cierre);
    expect(resultados.every((r) => r.estado === "ok" && r.observaciones?.length === 0)).toBe(true);
    expect(ultimaSeqContigua).toBe(5);

    const [arqueo] = (await e.admin("GET", `${e.base}/turnos`)).body;
    expect(arqueo).toMatchObject({
      turnoId,
      cajero: "Ana",
      estado: "cerrado",
      fondoInicial: 1000000,
      cobrado: { efectivo: 1400000, debito: 300000 },
      retiros: 500000,
      efectivoEsperado: 1900000,
      efectivoDeclarado: 1900000,
      diferencia: 0,
      ventas: 2,
      difiereDelPosnet: false,
    });

    const reporte = (await e.admin("GET", `${e.base}/reportes/ventas`)).body;
    expect(reporte).toMatchObject({ ventas: 2, importe: 1700000, anuladas: 0 });
    expect(reporte.porProducto).toEqual([
      { productoId: e.cerveza.id, nombre: "Cerveza", cantidad: 3, importe: 900000 },
      { productoId: e.hamburguesa.id, nombre: "Hamburguesa", cantidad: 1, importe: 800000 },
    ]);
    expect((await e.admin("GET", `${e.base}/reportes/vales`)).body).toMatchObject({ emitidos: 3, canjeados: 0, pendientes: 3 });

    const ventas = (await e.admin("GET", `${e.base}/ventas?turnoId=${turnoId}`)).body;
    expect(ventas).toHaveLength(2);
    expect(ventas.find((v: { numero: number }) => v.numero === 1).items).toHaveLength(2);
  });

  it("si falta plata en la caja, el arqueo muestra la diferencia", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id, 0);
    await e.posnet.subir(
      op,
      e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]),
      e.posnet.op("cierre_turno", { turnoId, usuarioId: e.cajero.id, efectivoDeclarado: 250000, cantidadVentas: 1, totalesPorMedio: { efectivo: 300000 } }),
    );
    const [arqueo] = (await e.admin("GET", `${e.base}/turnos`)).body;
    expect(arqueo).toMatchObject({ estado: "cerrado", efectivoEsperado: 300000, diferencia: -50000 });
  });

  it("subir dos veces lo mismo no duplica; mismo id con otros datos queda en conflicto", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    const venta = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]);
    await e.posnet.subir(op, venta);
    const otra = await e.posnet.subir(op, venta, { ...venta, numero: 99 }, { ...e.posnet.op("apertura_turno", { turnoId: randomUUID(), usuarioId: e.cajero.id, fondoInicial: 0 }), seq: 1 });
    expect(otra.resultados.map((r) => r.estado)).toEqual(["repetida", "repetida", "conflicto", "conflicto"]);
    expect((await e.admin("GET", `${e.base}/reportes/ventas`)).body.ventas).toBe(1);
    expect((await e.admin("GET", `${e.base}/reportes/observaciones`)).body.conflictos).toHaveLength(2);
  });

  it("una operación mal armada se rechaza sin frenar a las demás", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    const mal = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]);
    mal.pagos = [{ medio: "efectivo", monto: 1 }];
    const buena = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]);
    const { resultados, ultimaSeqContigua } = await e.posnet.subir(op, mal, "cualquier cosa", buena);
    expect(resultados.map((r) => r.estado)).toEqual(["ok", "invalida", "invalida", "ok"]);
    expect(resultados[1].error).toContain("no suman");
    // La inválida quedó registrada, así que no aparece como faltante.
    expect(ultimaSeqContigua).toBe(3);
    const obs = (await e.admin("GET", `${e.base}/reportes/observaciones`)).body;
    expect(obs.operaciones.map((o: { estado: string }) => o.estado)).toEqual(["invalida"]);
  });

  it("una venta hecha sin conexión con un precio viejo se guarda igual, con observación", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    await e.admin("PATCH", `${e.base}/productos/${e.cerveza.id}`, { precio: 350000 });
    const { resultados } = await e.posnet.subir(op, e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 2 }]));
    expect(resultados[1]).toMatchObject({ estado: "ok", observaciones: ["precio_distinto"] });
    expect((await e.admin("GET", `${e.base}/reportes/ventas`)).body.importe).toBe(600000);
  });

  it("si el cierre llega antes que las ventas, el arqueo queda incompleto hasta que llegan", async () => {
    const e = await armarEvento();
    const { turnoId, op: apertura } = abrirTurno(e.posnet, e.cajero.id, 0);
    const venta = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]);
    const cierre = e.posnet.op("cierre_turno", { turnoId, usuarioId: e.cajero.id, efectivoDeclarado: 300000, cantidadVentas: 1, totalesPorMedio: { efectivo: 300000 } });
    const primera = await e.posnet.subir(cierre);
    expect(primera.ultimaSeqContigua).toBe(0);
    let [arqueo] = (await e.admin("GET", `${e.base}/turnos`)).body;
    expect(arqueo).toMatchObject({ estado: "incompleto", aperturaRecibida: false, difiereDelPosnet: true });
    const sinc = (await e.admin("GET", `${e.base}/reportes/sincronizacion`)).body;
    expect(sinc.find((s: { dispositivoId: string }) => s.dispositivoId === e.posnet.id).faltantes).toEqual([1, 2]);

    const segunda = await e.posnet.subir(venta, apertura);
    expect(segunda.resultados.map((r) => r.estado)).toEqual(["ok", "ok"]);
    expect(segunda.ultimaSeqContigua).toBe(3);
    [arqueo] = (await e.admin("GET", `${e.base}/turnos`)).body;
    expect(arqueo).toMatchObject({ estado: "cerrado", diferencia: 0, difiereDelPosnet: false });
  });

  it("un retiro sin supervisor queda observado", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    const retiro = e.posnet.op("movimiento_caja", { movimientoId: randomUUID(), turnoId, movimiento: "retiro", monto: 1000, motivo: "x", usuarioId: e.cajero.id });
    const { resultados } = await e.posnet.subir(op, retiro);
    expect(resultados[1].observaciones).toEqual(["falta_autorizacion"]);
  });

  it("una cortesía necesita supervisor y un usuario de otra cuenta queda observado", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    const cortesia = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }], { medio: "cortesia" });
    const autorizada = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }], {
      medio: "cortesia",
      extra: { autorizadoPorId: e.supervisor.id },
    });
    const ajena = e.posnet.venta(turnoId, 9999, [{ producto: e.cerveza, cantidad: 1 }]);
    const { resultados } = await e.posnet.subir(op, cortesia, autorizada, ajena);
    expect(resultados[1].observaciones).toEqual(["falta_autorizacion"]);
    expect(resultados[2].observaciones).toEqual([]);
    expect(resultados[3].observaciones).toEqual(expect.arrayContaining(["usuario_desconocido", "cajero_distinto"]));
  });
});

describe("anulaciones", () => {
  const anular = (e: Awaited<ReturnType<typeof armarEvento>>, venta: Record<string, any>, turnoId: string, minuto: number, extra = {}) =>
    e.posnet.op(
      "anulacion",
      {
        ventaId: venta.ventaId,
        turnoId,
        usuarioId: e.cajero.id,
        motivo: "error_de_carga",
        valesRecuperados: venta.vales.map((v: { valeId: string }) => v.valeId),
        devoluciones: [{ medio: "efectivo", monto: venta.items.reduce((s: number, i: any) => s + i.precioUnitario * i.cantidad, 0) }],
        ...extra,
      },
      minuto,
    );

  it("el cajero anula dentro del plazo: se anulan los vales, vuelve el stock y sale la plata de la caja", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id, 0);
    const venta = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 2 }], { conVales: true, minuto: 10 });
    const { resultados } = await e.posnet.subir(op, venta, anular(e, venta, turnoId, 12));
    expect(resultados[2]).toMatchObject({ estado: "ok", observaciones: [] });

    const [arqueo] = (await e.admin("GET", `${e.base}/turnos`)).body;
    expect(arqueo).toMatchObject({ cobrado: { efectivo: 600000 }, devuelto: { efectivo: 600000 }, efectivoEsperado: 0, anuladas: 1 });
    expect((await e.admin("GET", `${e.base}/reportes/vales`)).body).toMatchObject({ emitidos: 0, anulados: 2 });
    const stock = (await e.admin("GET", `${e.base}/reportes/stock`)).body.find((s: { productoId: number }) => s.productoId === e.cerveza.id);
    expect(stock.vendido).toBe(0);
    const anulaciones = (await e.admin("GET", `${e.base}/reportes/anulaciones`)).body;
    expect(anulaciones.detalle[0]).toMatchObject({ cajero: "Ana", minutosDesdeLaVenta: 2, motivo: "error_de_carga" });

    // La barra ya sabe que esos vales no sirven.
    const config = (await e.lectorBarra.pedir("GET", "/api/dispositivo/configuracion")).body;
    expect(config.valesAnulados).toHaveLength(2);
    const consulta = (await e.lectorBarra.consultar(venta.vales[0].qr)).body;
    expect(consulta).toMatchObject({ entregar: false, motivos: ["vale_anulado"] });
  });

  it("fuera de plazo y sin supervisor queda observada; con supervisor no", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id, 0);
    const v1 = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]);
    const v2 = e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]);
    const { resultados } = await e.posnet.subir(
      op,
      v1,
      v2,
      anular(e, v1, turnoId, 30),
      anular(e, v2, turnoId, 30, { autorizadoPorId: e.supervisor.id }),
    );
    expect(resultados[3].observaciones).toEqual(["fuera_de_plazo"]);
    expect(resultados[4].observaciones).toEqual([]);
  });
});

describe("canje de vales en la barra", () => {
  const vender = async (e: Awaited<ReturnType<typeof armarEvento>>, producto = e.cerveza, cantidad = 1) => {
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    const venta = e.posnet.venta(turnoId, e.cajero.id, [{ producto, cantidad }], { conVales: true });
    await e.posnet.subir(op, venta);
    return venta.vales as { valeId: string; qr: string }[];
  };
  const canje = (lector: Posnet, qr: string, usuarioId: number, minuto = 20) =>
    lector.op("canje", { canjeId: randomUUID(), qr, usuarioId }, minuto);

  it("consulta, entrega y un segundo intento avisa dónde y cuándo se canjeó", async () => {
    const e = await armarEvento();
    const [vale] = await vender(e);
    const consulta = (await e.lectorBarra.consultar(vale.qr)).body;
    expect(consulta).toMatchObject({ entregar: true, motivos: [], producto: { id: e.cerveza.id, nombre: "Cerveza" } });

    // Mientras la barra 1 entrega, otra barra no puede canjear el mismo vale.
    const otra = await vincularPosnet(e.admin, e.evento.id, { nombre: "Barra 2", tipo: "canje", sectorId: e.barra.id });
    const barra2 = new Posnet(otra.claveDispositivo, otra.dispositivoId, e.evento.id);
    expect((await barra2.consultar(vale.qr)).body).toMatchObject({ entregar: false, motivos: ["canje_en_curso"] });

    const { resultados } = await e.lectorBarra.subir(canje(e.lectorBarra, vale.qr, e.cajero.id));
    expect(resultados[0]).toMatchObject({ estado: "ok", observaciones: [] });
    const segunda = (await barra2.consultar(vale.qr)).body;
    expect(segunda).toMatchObject({ entregar: false, motivos: ["canje_duplicado"], canjePrevio: { puntoVenta: "Barra 1", creada: a(20) } });

    // Si igual se entregó sin conexión, el canje doble queda registrado como alerta.
    const doble = await barra2.subir(canje(barra2, vale.qr, e.cajero.id, 25));
    expect(doble.resultados[0].observaciones).toEqual(["canje_duplicado"]);
    const reporte = (await e.admin("GET", `${e.base}/reportes/vales`)).body;
    expect(reporte).toMatchObject({ emitidos: 1, canjeados: 1, pendientes: 0 });
    expect(reporte.alertas).toHaveLength(1);
    expect(reporte.alertas[0]).toMatchObject({ puntoVenta: "Barra 2", observaciones: ["canje_duplicado"] });
  });

  it("rechaza vales de otro sector, con firma falsa o inventados", async () => {
    const e = await armarEvento();
    const [hamburguesa] = await vender(e, e.hamburguesa);
    expect((await e.lectorBarra.consultar(hamburguesa.qr)).body.motivos).toEqual(["otro_sector"]);

    const falsificador = generateKeyPairSync("ed25519").privateKey;
    const falso = e.posnet.vale(e.cerveza.id, e.barra.id, 0, falsificador);
    const res = (await e.lectorBarra.consultar(falso.qr)).body;
    expect(res.entregar).toBe(false);
    expect(res.motivos).toContain("firma_invalida");

    expect((await e.lectorBarra.consultar("no-es-un-vale")).body).toMatchObject({ entregar: false, motivos: ["qr_invalido"] });
  });

  it("un vale firmado que todavía no subió su venta se puede entregar (queda anotado)", async () => {
    const e = await armarEvento();
    const vale = e.posnet.vale(e.cerveza.id, e.barra.id);
    const res = (await e.lectorBarra.consultar(vale.qr)).body;
    expect(res).toMatchObject({ entregar: true, observaciones: ["vale_sin_venta"] });
  });

  it("con vencimiento en una fecha, un canje posterior queda observado como vencido", async () => {
    const e = await armarEvento({ valesValidez: "fecha", valesVencimiento: "2026-11-01T23:30:00-03:00" });
    const [vale] = await vender(e);
    // a(20) = 21:20 hora argentina: todavía vale. a(200) = 00:20: vencido.
    const { resultados } = await e.lectorBarra.subir(canje(e.lectorBarra, vale.qr, e.cajero.id, 20));
    expect(resultados[0].observaciones).toEqual([]);
    const [otro] = await vender(e);
    const tarde = await e.lectorBarra.subir(canje(e.lectorBarra, otro.qr, e.cajero.id, 200));
    expect(tarde.resultados[0].observaciones).toEqual(["vale_vencido"]);
  });

  it("un vale sin vencimiento se canjea en otro evento de la cuenta por el mismo producto", async () => {
    const e = await armarEvento({ valesValidez: "sin_vencimiento" });
    const [vale] = await vender(e);

    const otro = await nuevoEvento(e.admin, { nombre: "Otra fiesta" });
    const base = `/api/eventos/${otro.id}`;
    const barra = (await e.admin("POST", `${base}/sectores`, { nombre: "Barra" })).body;
    const cerveza = (await e.admin("POST", `${base}/productos`, { nombre: "Cerveza rubia", codigo: "cerv", precio: 400000, sectorId: barra.id }))
      .body;
    const puesto = await vincularPosnet(e.admin, otro.id, { nombre: "Barra nueva", tipo: "canje", sectorId: barra.id });
    const lector = new Posnet(puesto.claveDispositivo, puesto.dispositivoId, otro.id);

    const config = (await lector.pedir("GET", "/api/dispositivo/configuracion")).body;
    expect(config.equivalencias).toContainEqual({ eventoId: e.evento.id, productoValeId: e.cerveza.id, productoId: cerveza.id });
    expect(config.clavesPublicas.map((c: { dispositivoId: string }) => c.dispositivoId)).toContain(e.posnet.id);

    const consulta = (await lector.consultar(vale.qr)).body;
    expect(consulta).toMatchObject({ entregar: true, producto: { id: cerveza.id, nombre: "Cerveza rubia" } });
  });

  it("un vale que vence no sirve en otro evento", async () => {
    const e = await armarEvento();
    const [vale] = await vender(e);
    const otro = await nuevoEvento(e.admin, { nombre: "Otra fiesta" });
    const puesto = await vincularPosnet(e.admin, otro.id, { nombre: "Barra nueva", tipo: "canje" });
    const lector = new Posnet(puesto.claveDispositivo, puesto.dispositivoId, otro.id);
    expect((await lector.consultar(vale.qr)).body.motivos).toContain("vale_de_otro_evento");
  });

  it("un vale de otra cuenta no sirve", async () => {
    const e = await armarEvento();
    const [vale] = await vender(e);
    iniciar({ registroAbierto: true });
    const e2 = await armarEvento();
    const res = (await e2.lectorBarra.consultar(vale.qr)).body;
    expect(res.entregar).toBe(false);
  });
});

describe("stock", () => {
  it("carga, merma y ventas; el posnet ve el producto agotado", async () => {
    const e = await armarEvento();
    expect((await e.admin("POST", `${e.base}/stock`, { productoId: e.cerveza.id, tipo: "carga", cantidad: 10 })).status).toBe(201);
    expect((await e.admin("POST", `${e.base}/stock`, { productoId: e.cerveza.id, tipo: "merma", cantidad: 2, nota: "Se rompieron" })).status).toBe(201);
    expect((await e.admin("POST", `${e.base}/stock`, { productoId: e.cerveza.id, tipo: "merma", cantidad: -2 })).status).toBe(400);
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    await e.posnet.subir(op, e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 8 }]));

    const stock = (await e.admin("GET", `${e.base}/reportes/stock`)).body.find((s: { productoId: number }) => s.productoId === e.cerveza.id);
    expect(stock).toMatchObject({ cargado: 10, mermas: 2, vendido: 8, actual: 0 });
    const config = (await e.posnet.pedir("GET", "/api/dispositivo/configuracion")).body;
    expect(config.productos.find((p: { id: number }) => p.id === e.cerveza.id)).toMatchObject({ stock: 0, agotado: true });
    expect(config.productos.find((p: { id: number }) => p.id === e.hamburguesa.id)).toMatchObject({ stock: null, agotado: false });

    const movimientos = (await e.admin("GET", `${e.base}/stock/movimientos`)).body;
    expect(movimientos.map((m: { tipo: string; cantidad: number }) => [m.tipo, m.cantidad])).toEqual([
      ["merma", -2],
      ["carga", 10],
    ]);
  });

  it("no acepta productos de otro evento", async () => {
    const e = await armarEvento();
    const otro = await nuevoEvento(e.admin);
    const res = await e.admin("POST", `/api/eventos/${otro.id}/stock`, { productoId: e.cerveza.id, tipo: "carga", cantidad: 1 });
    expect(res.status).toBe(400);
  });
});

describe("permisos y borrados", () => {
  it("el cajero no ve reportes; el supervisor sí, aunque entre con tarjeta", async () => {
    const e = await armarEvento();
    const cajero = como((await loginNfc(e.caja.claveDispositivo, "04A1B2C3")).body.token);
    expect((await cajero("GET", `${e.base}/reportes/ventas`)).status).toBe(403);
    expect((await cajero("POST", `${e.base}/stock`, { productoId: e.cerveza.id, tipo: "carga", cantidad: 1 })).status).toBe(403);
    const supervisor = como((await loginNfc(e.caja.claveDispositivo, "05A1B2C3")).body.token);
    expect((await supervisor("GET", `${e.base}/reportes/ventas`)).status).toBe(200);
    expect((await supervisor("GET", `${e.base}/turnos`)).status).toBe(200);
  });

  it("no se borra lo que ya tiene ventas: producto, usuario, punto de venta ni evento", async () => {
    const e = await armarEvento();
    const { turnoId, op } = abrirTurno(e.posnet, e.cajero.id);
    await e.posnet.subir(op, e.posnet.venta(turnoId, e.cajero.id, [{ producto: e.cerveza, cantidad: 1 }]));
    const borrar = async (url: string) => (await e.admin("DELETE", url)).status;
    expect(await borrar(`${e.base}/productos/${e.cerveza.id}`)).toBe(409);
    expect(await borrar(`/api/usuarios/${e.cajero.id}`)).toBe(409);
    expect(await borrar(`${e.base}/puntos-venta/${e.caja.pv.id}`)).toBe(409);
    expect(await borrar(`/api/eventos/${e.evento.id}`)).toBe(409);
    // Lo que no se usó se borra normalmente.
    expect(await borrar(`${e.base}/productos/${e.hamburguesa.id}`)).toBe(204);
    expect(await borrar(`/api/usuarios/${e.supervisor.id}`)).toBe(204);
  });

  it("el vencimiento por fecha pide una fecha posterior al inicio", async () => {
    const admin = como((await registrar()).token);
    const base = { nombre: "X", inicio: "2026-11-01T20:00:00-03:00", fin: "2026-11-02T05:00:00-03:00" };
    expect((await admin("POST", "/api/eventos", { ...base, valesValidez: "fecha" })).status).toBe(400);
    expect(
      (await admin("POST", "/api/eventos", { ...base, valesValidez: "fecha", valesVencimiento: "2026-10-01T00:00:00-03:00" })).status,
    ).toBe(400);
    expect(
      (await admin("POST", "/api/eventos", { ...base, valesValidez: "fecha", valesVencimiento: "2026-12-31T23:59:00-03:00" })).status,
    ).toBe(201);
  });
});
