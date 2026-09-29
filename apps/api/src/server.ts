import { abrirDb } from "./db/index.js";
import { crearApp } from "./app.js";

const puerto = Number(process.env.PUERTO ?? 3000);
const app = crearApp(abrirDb(process.env.DB_PATH ?? "eventos.db"));

// 0.0.0.0 para que los posnets de la red local lleguen cuando corre como servidor del evento.
app.listen({ port: puerto, host: "0.0.0.0" }).then((url) => console.log(`API escuchando en ${url}`));
