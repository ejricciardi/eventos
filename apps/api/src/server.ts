import { abrirDb } from "./db/index.js";
import { crearApp } from "./app.js";

const puerto = Number(process.env.PUERTO ?? 3000);
const app = crearApp(abrirDb(process.env.DB_PATH ?? "eventos.db"), {
  // Con la primera cuenta creada el registro se cierra, salvo que se habilite a propósito.
  registroAbierto: process.env.REGISTRO_ABIERTO === "1",
  // En la nube la API va detrás de un proxy: TRUST_PROXY=1 para ver la IP real de cada cliente.
  trustProxy: process.env.TRUST_PROXY === "1",
});

// 0.0.0.0 para que los posnets de la red local lleguen cuando corre como servidor del evento.
app.listen({ port: puerto, host: "0.0.0.0" }).then((url) => console.log(`API escuchando en ${url}`));
