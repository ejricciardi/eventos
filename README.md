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

Si cambiás `apps/api/src/db/schema.ts`, generá la migración con `npm run db:generate -w @eventos/api`.
