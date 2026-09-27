/** Request-shaped helpers: client IP, ASN hints, cookies, device fingerprint. */

export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("fly-client-ip") ??
    "0.0.0.0"
  );
}

/**
 * ASN of the caller. Real deployments read this from the edge (Cloudflare sends
 * it); absent that we fall back to a coarse hint so the integrity scanner can
 * still cluster datacentre traffic during development.
 */
export function clientAsn(headers: Headers): string {
  const asn = headers.get("cf-asn") ?? headers.get("x-asn");
  if (asn) return asn;
  const ip = clientIp(headers);
  return isPrivateIp(ip) ? "private" : `unknown:${ip.split(".").slice(0, 2).join(".")}`;
}

export function isPrivateIp(ip: string) {
  return (
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    ip.startsWith("127.") ||
    ip === "0.0.0.0" ||
    ip === "::1" ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

/** ASNs known to be datacentre/VPN ranges — clustered votes from these get flagged. */
const DATACENTRE_ASNS = new Set([
  "16509", // AWS
  "14618", // AWS
  "15169", // Google
  "396982", // Google Cloud
  "8075", // Microsoft
  "14061", // DigitalOcean
  "16276", // OVH
  "24940", // Hetzner
  "63949", // Akamai/Linode
  "20473", // Vultr
  "13335", // Cloudflare
  "9009", // M247
  "51167", // Contabo
]);

export function isDatacentreAsn(asn: string | null | undefined) {
  if (!asn) return false;
  return DATACENTRE_ASNS.has(asn.replace(/^AS/i, ""));
}

export function readCookie(headers: Headers, name: string): string | null {
  const raw = headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export interface CookieOptions {
  maxAge: number;
  sameSite?: "Lax" | "None" | "Strict";
  secure?: boolean;
}

export function buildCookie(name: string, value: string, opts: CookieOptions) {
  const sameSite = opts.sameSite ?? "Lax";
  // SameSite=None requires Secure; the preview runs the app inside an iframe.
  const secure = opts.secure ?? sameSite === "None";
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    `SameSite=${sameSite}`,
    `Max-Age=${opts.maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function expiredCookie(name: string) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Device fingerprint. The client sends a stable random id it persists locally; we
 * mix in UA + accept-language so clearing local storage does not fully reset it.
 * Advisory only — it feeds rate limits and fraud clustering, never vote validity.
 */
export function deviceFingerprint(headers: Headers): string {
  const clientFp = headers.get("x-nr-device") ?? "";
  const ua = headers.get("user-agent") ?? "";
  const lang = headers.get("accept-language") ?? "";
  const basis = `${clientFp}|${ua.slice(0, 120)}|${lang.slice(0, 40)}`;
  let h = 2166136261;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + (clientFp ? `-${clientFp.slice(0, 12)}` : "");
}
