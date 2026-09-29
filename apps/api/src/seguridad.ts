import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  clave: string,
  sal: Buffer,
  largo: number,
  opciones: object,
) => Promise<Buffer>;

// Parámetros de scrypt. Se guardan junto al hash para poder subirlos más adelante sin romper las claves viejas.
const N = 16384;
const R = 8;
const P = 1;
const LARGO = 32;

/** Hash de una clave con scrypt y sal aleatoria: "scrypt$N$r$p$sal$hash" en base64url. */
export async function hashearClave(clave: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await scryptAsync(clave, sal, LARGO, { N, r: R, p: P });
  return ["scrypt", N, R, P, sal.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verificarClave(clave: string, guardado: string): Promise<boolean> {
  const [algoritmo, n, r, p, sal, hash] = guardado.split("$");
  if (algoritmo !== "scrypt" || !sal || !hash) return false;
  const esperado = Buffer.from(hash, "base64url");
  const calculado = await scryptAsync(clave, Buffer.from(sal, "base64url"), esperado.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(calculado, esperado);
}

// Hash con el que se compara cuando el usuario no existe, para que la respuesta tarde lo mismo.
let hashFicticio: Promise<string> | undefined;
export const claveFicticia = () => (hashFicticio ??= hashearClave(randomBytes(16).toString("hex")));

/** Token aleatorio para sesiones y dispositivos. Se entrega una sola vez; en la base queda su hash. */
export const generarToken = () => randomBytes(32).toString("base64url");

// Los tokens ya son aleatorios de 256 bits, así que alcanza con SHA-256 (sin sal) para guardarlos.
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Parámetros con los que el posnet calcula el hash de una tarjeta para validarla sin conexión.
 * El UID de una tarjeta es corto (4 a 7 bytes), así que se usa scrypt: si alguien saca la lista de un posnet,
 * probar todos los UID posibles deja de ser cuestión de segundos. La sal es por cuenta.
 */
export const parametrosNfc = (cuentaId: number) => ({
  algoritmo: "scrypt" as const,
  N,
  r: R,
  p: P,
  largo: LARGO,
  sal: `eventos-nfc:${cuentaId}`,
});

/** Hash de un UID de tarjeta (en mayúsculas), en hexadecimal. */
export async function hashNfc(cuentaId: number, nfcUid: string): Promise<string> {
  const { sal } = parametrosNfc(cuentaId);
  const hash = await scryptAsync(nfcUid.toUpperCase(), Buffer.from(sal, "utf8"), LARGO, { N, r: R, p: P });
  return hash.toString("hex");
}
