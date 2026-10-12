/** Request-shaped helpers: client IP, ASN hints, cookies, device fingerprint. */

/**
 * The caller's IP, read only from what our own edge sets — never from a value
 * the client can choose. Every rate limit and fraud signal keys off this.
 *
 *   CLIENT_IP_HEADER   name of a header the edge overwrites on every request
 *                      (e.g. `cf-connecting-ip` behind Cloudflare). When set,
 *                      it is the only source.
 *   TRUSTED_PROXY_HOPS how many proxies sit in front of the app (default 1).
 *                      Each proxy appends the address it saw to
 *                      X-Forwarded-For, so the client address is that many
 *                      entries from the RIGHT. Anything further left was
 *                      written by the client and is ignored.
 */
export function clientIp(headers: Headers): string {
  const configured = process.env.CLIENT_IP_HEADER?.trim().toLowerCase();
  if (configured) return headers.get(configured)?.trim() || "0.0.0.0";

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS ?? 1) || 1);
    const chain = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return chain[Math.max(0, chain.length - hops)] ?? "0.0.0.0";
  }
  return headers.get("x-real-ip")?.trim() || "0.0.0.0";
}

/**
 * ASN of the caller. Only read when the edge is configured to stamp it
 * (`ASN_HEADER`, e.g. a Cloudflare transform rule writing `cf-asn`); a client
 * can send any header it likes, so an unconfigured header is never trusted.
 * Otherwise we fall back to a coarse /16 hint for clustering.
 */
export function clientAsn(headers: Headers): string {
  const asnHeader = process.env.ASN_HEADER?.trim().toLowerCase();
  const asn = asnHeader ? headers.get(asnHeader) : null;
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
