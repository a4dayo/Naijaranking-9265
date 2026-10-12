/** Normalisation helpers. `normaliseName` backs the unique(board_id, name_normalised) constraint. */

const NOISE_WORDS = new Set(["the", "a", "an", "of", "and", "&"]);

export function normaliseName(raw: string) {
  const base = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !NOISE_WORDS.has(w))
    .join(" ")
    .trim();
  return base || raw.trim().toLowerCase();
}

export function slugify(raw: string) {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Nigerian mobile numbers → E.164. Accepts 0803..., 803..., +234803..., 234803... */
export function normaliseNgPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  let rest: string;
  if (digits.startsWith("+234")) rest = digits.slice(4);
  else if (digits.startsWith("234")) rest = digits.slice(3);
  else if (digits.startsWith("0")) rest = digits.slice(1);
  else rest = digits.replace(/^\+/, "");
  if (!/^[789]\d{9}$/.test(rest)) return null;
  return `+234${rest}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Providers that ignore dots in the local part. */
const DOT_BLIND_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
/** Providers that deliver `name+anything@` to `name@`. */
const PLUS_ADDRESSING_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "fastmail.com",
  "zoho.com",
]);
const DOMAIN_ALIASES: Record<string, string> = { "googlemail.com": "gmail.com" };

/**
 * Lower-cases and canonicalises an email so one inbox is one identity:
 * `Ada.Obi+naijarank@GoogleMail.com` → `adaobi@gmail.com`. The canonical form
 * still delivers to the same inbox on these providers, so it is what we store,
 * rate-limit and send to.
 */
export function normaliseEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  const at = email.lastIndexOf("@");
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (PLUS_ADDRESSING_DOMAINS.has(domain)) local = local.split("+")[0]!;
  if (DOT_BLIND_DOMAINS.has(domain)) local = local.replaceAll(".", "");
  domain = DOMAIN_ALIASES[domain] ?? domain;
  if (!local) return null;
  return `${local}@${domain}`;
}

/** Light profanity/impersonation screen for nominations — flags, never auto-rejects silently. */
const SCREEN_TERMS = [
  "fraudster",
  "scammer",
  "criminal",
  "yahoo boy",
  "thief",
  "killer",
  "president",
  "senator",
  "governor",
  "minister",
  "honourable",
];

export function screenNomination(name: string): { verdict: "clean" | "review"; reason?: string } {
  const lower = name.toLowerCase();
  const hit = SCREEN_TERMS.find((t) => lower.includes(t));
  if (hit) return { verdict: "review", reason: `contains restricted term "${hit}"` };
  if (name.trim().length < 2) return { verdict: "review", reason: "too short" };
  if (name.length > 80) return { verdict: "review", reason: "too long" };
  return { verdict: "clean" };
}

export const ALLOWED_CATEGORIES = ["Music", "Film", "People", "Places", "Culture"] as const;
export type Category = (typeof ALLOWED_CATEGORIES)[number];

export function isAllowedCategory(value: string): value is Category {
  return (ALLOWED_CATEGORIES as readonly string[]).includes(value);
}
