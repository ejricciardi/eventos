# Eventos

Sistema de gestión de ventas para eventos: se configura desde un panel web y se cobra con posnets **Clover** y **Mercado Pago Point Smart**.

## Qué hace

- **Panel de administración:** configura el evento, los productos, los puntos de venta, los sectores (cocina, barra) y las impresoras.
- **App de caja** (Android) para Clover y Mercado Pago: cobra, imprime tickets y vales de consumo, y manda comandas.
- **Modo de venta por evento:**
  - `vales`: se imprime un vale con QR por producto, que se canjea en el sector.
  - `directo`: se imprime el ticket y la comanda va derecho al sector.
- **Comandas** a impresoras térmicas de red (ESC/POS: Epson, 3nstar, etc.). La impresora de cada sector es opcional.
- **Cuentas:** cada organizador tiene su cuenta, con sus eventos y su gente. Una cuenta no ve los datos de otra.
- **Acceso:** usuario y clave para el panel; tarjeta NFC en el posnet (plan B: credencial con QR). Con tarjeta se opera, pero no se cambia la configuración.
- **Ventas y caja:** el cajero arma un pedido con varios productos y lo cobra con cualquier medio (efectivo, débito, crédito, QR, transferencia, cortesía). Turnos de caja con fondo inicial, retiros e ingresos, anulaciones y arqueo por cajero.
- **Vales:** uno por unidad, con QR firmado por el posnet que lo emitió (no se pueden falsificar). Se canjean en los puestos de canje (barras); cada puesto puede canjear solo los de su sector. Por evento se elige si vencen al terminar, en una fecha, o nunca (en ese caso se canjean en otros eventos de la cuenta que vendan el mismo producto).
- **Stock y reportes:** cargas, mermas y ajustes; reportes de ventas (por producto, medio de pago, punto de venta y cajero), stock, vales, anulaciones y lo que conviene revisar.
- **Funciona sin internet:** cada posnet guarda las ventas localmente y sincroniza cuando vuelve la conexión. En eventos grandes, un servidor local en la red del lugar reparte comandas y valida QR.
- **A futuro:** app para celulares con promociones, QR de consumo y entradas.

## Arquitectura

```
                 ┌──────────────────────────┐
                 │  Nube: API + panel web   │
                 └────────────▲─────────────┘
                              │ sincroniza cuando hay internet
                 ┌────────────┴─────────────┐
                 │ Servidor local (opcional)│  misma API, en la red del evento
                 └──▲──────────▲─────────▲──┘
                    │          │         │
             Posnet Clover  Posnet MP  Impresoras ESC/POS
             (app de caja: núcleo común + adaptador por plataforma)
```

## Estructura

| Carpeta | Qué es |
|---|---|
| `apps/api` | API (Node + Fastify + SQLite). Corre en la nube o como servidor local. |
| `apps/panel` | Panel de administración (React + Vite). |
| `apps/caja` | App Android para los posnets (pendiente). |

## Cómo correrlo

Requiere Node 22.

```bash
npm install
npm run dev:api     # API en http://localhost:3000 (base SQLite en apps/api/eventos.db)
npm run dev:panel   # Panel en http://localhost:5173
npm test            # tests de la API
```

La primera vez que abrís el panel te pide crear la cuenta y tu usuario administrador.

Variables de la API:

| Variable | Qué hace |
|---|---|
| `DB_PATH` | Archivo de la base SQLite (por defecto `eventos.db`). |
| `PUERTO` | Puerto de la API (por defecto 3000). |
| `REGISTRO_ABIERTO=1` | Permite crear más cuentas además de la primera. |
| `TRUST_PROXY=1` | Usar cuando la API corre detrás de un proxy (en la nube), para limitar los intentos de acceso por la IP real. |

Para que un posnet entre con tarjeta, en el panel tocá **Vincular posnet** en su punto de venta y cargá esa clave en la app del posnet.

## Cómo sincroniza el posnet

El posnet trabaja siempre contra su propia base y sube lo que hizo cuando tiene conexión. Se identifica con la clave de vinculación en el header `x-clave-dispositivo`.

| Ruta | Para qué |
|---|---|
| `GET /api/dispositivo/configuracion` | Todo lo que necesita para vender y canjear sin conexión: evento, productos (con stock), sectores, impresoras, personal (la tarjeta viaja como hash scrypt), claves públicas para verificar vales y vales anulados. |
| `POST /api/dispositivo/clave-publica` | Registra una sola vez la clave Ed25519 con la que firma los vales. |
| `POST /api/dispositivo/sincronizar` | Sube operaciones: apertura y cierre de turno, venta, anulación, retiro o ingreso, canje. |
| `POST /api/dispositivo/canjes/consultar` | Con conexión, revisa un vale antes de entregar y lo reserva un minuto para que otra barra no lo entregue a la vez. |

Cada operación lleva un id propio, un número correlativo del posnet y la hora del posnet. El servidor las toma como hechos: si llega dos veces no se duplica, y si algo no cierra (un precio viejo, un vale ya canjeado, una anulación fuera de plazo) la guarda igual y la marca para revisar. Solo rechaza lo mal armado, como pagos que no suman el total. Con los números correlativos el panel muestra qué posnet tiene operaciones sin subir, y el arqueo de una caja queda como incompleto hasta que llega todo.

Si cambiás `apps/api/src/db/schema.ts`, generá la migración con `npm run db:generate -w @eventos/api`.
