import { useEffect, useState, type FormEvent } from "react";
import type { Sesion } from "@eventos/shared";
import { api, guardarToken } from "./api";

/** Pantalla de entrada: usuario y clave, o crear la cuenta si todavía no hay ninguna. */
export function Acceso({ alEntrar }: { alEntrar: () => void }) {
  const [registroAbierto, setRegistroAbierto] = useState(false);
  const [modo, setModo] = useState<"login" | "registro">("login");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ abierto: boolean }>("GET", "/registro")
      .then(({ abierto }) => {
        setRegistroAbierto(abierto);
        if (abierto) setModo("registro");
      })
      .catch(() => {});
  }, []);

  const enviar = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const datos = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const sesion = await api<Sesion>("POST", modo === "login" ? "/auth/login" : "/registro", datos);
      guardarToken(sesion.token);
      alEntrar();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="acceso">
      <section>
        <h2>{modo === "login" ? "Entrar" : "Crear la cuenta"}</h2>
        <form onSubmit={enviar} className="vertical">
          {modo === "registro" && (
            <>
              <label>
                Nombre de la cuenta (tu productora u organización)
                <input name="cuenta" required />
              </label>
              <label>
                Tu nombre
                <input name="nombre" required />
              </label>
            </>
          )}
          <label>
            Usuario
            <input name="usuario" autoComplete="username" required autoFocus />
          </label>
          <label>
            Clave
            <input
              name="clave"
              type="password"
              autoComplete={modo === "login" ? "current-password" : "new-password"}
              minLength={modo === "registro" ? 8 : undefined}
              required
            />
          </label>
          <button>{modo === "login" ? "Entrar" : "Crear cuenta"}</button>
        </form>
        {error && <p className="error">{error}</p>}
        {registroAbierto && (
          <p>
            <button className="enlace" onClick={() => (setModo(modo === "login" ? "registro" : "login"), setError(""))}>
              {modo === "login" ? "Crear una cuenta nueva" : "Ya tengo cuenta"}
            </button>
          </p>
        )}
      </section>
    </main>
  );
}
