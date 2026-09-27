/// <reference types="node" />

/**
 * Ambient declarations for the API's server-side environment.
 *
 * The api tree is imported for its types by the mobile and desktop packages,
 * whose tsconfigs don't carry Node/Bun types. The triple-slash reference above
 * (plus the the `reference path` in `index.ts`) pulls these into any program
 * that walks this tree, so the API type-checks identically everywhere.
 */
declare namespace NodeJS {
  interface ProcessEnv {
    /** Turso / libSQL connection URL. */
    DATABASE_URL?: string;
    /** Turso auth token. */
    DATABASE_AUTH_TOKEN?: string;
    /** Secret used to sign voter + admin session cookies. */
    SESSION_SECRET?: string;
    /** Fallback session secret provided by the template. */
    BETTER_AUTH_SECRET?: string;
    /** Resend API key for OTP email delivery. Unset = dev mode. */
    RESEND_API_KEY?: string;
    /** From address for OTP emails. */
    OTP_FROM_EMAIL?: string;
    /** Public origin, used for share links and sitemap URLs. */
    PUBLIC_BASE_URL?: string;
    WEBSITE_URL?: string;
    NODE_ENV?: string;
  }
}
