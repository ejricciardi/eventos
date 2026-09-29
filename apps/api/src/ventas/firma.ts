import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import type { ContenidoVale } from "@eventos/shared";

// El QR de un vale es "<contenido en base64url>.<firma en base64url>". La firma es Ed25519 sobre el
// texto del contenido (tal cual va en el QR) y la hace el posnet con su clave privada, que nunca sale de él.
// Cualquier barra puede verificarla sin conexión con la clave pública del posnet, pero nadie puede fabricar un vale.

const contenidoVale = z.object({
  v: z.literal(1),
  e: z.number().int().positive(),
  i: z.string().uuid(),
  p: z.number().int().positive(),
  s: z.number().int().positive().nullable(),
  d: z.string().uuid(),
  t: z.string().datetime({ offset: true }),
});

export type QrLeido = { contenido: ContenidoVale; texto: string; firma: Buffer };

/** Lee un QR de vale. Devuelve null si no tiene el formato esperado. */
export function leerQr(qr: string): QrLeido | null {
  const partes = qr.split(".");
  if (partes.length !== 2) return null;
  const [texto, firma] = partes;
  try {
    const json = JSON.parse(Buffer.from(texto, "base64url").toString("utf8"));
    const contenido = contenidoVale.safeParse(json);
    if (!contenido.success) return null;
    return { contenido: contenido.data, texto, firma: Buffer.from(firma, "base64url") };
  } catch {
    return null;
  }
}

/** Valida una clave pública Ed25519 en formato SPKI (DER en base64). */
export function clavePublicaValida(clavePublica: string): boolean {
  try {
    return createPublicKey({ key: Buffer.from(clavePublica, "base64"), format: "der", type: "spki" }).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function firmaValida(qr: QrLeido, clavePublica: string | null | undefined): boolean {
  if (!clavePublica) return false;
  try {
    const clave = createPublicKey({ key: Buffer.from(clavePublica, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(qr.texto, "utf8"), clave, qr.firma);
  } catch {
    return false;
  }
}
