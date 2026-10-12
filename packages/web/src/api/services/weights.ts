/**
 * Vote weights, in one place.
 *
 * An unverified vote is recorded straight away (no login wall) but held as
 * PENDING: weight 0, so it never moves the ranking. Verifying upgrades it.
 * A cookie costs nothing to mint, so an unverified vote must be worth nothing
 * until a real identity stands behind it.
 *
 * When SMS OTP goes live, phone becomes the strongest identity (a Nigerian SIM
 * is NIN-linked) and email can drop below it — change these numbers, nothing else.
 */
export const PENDING_WEIGHT = 0;
export const EMAIL_WEIGHT = 1;
export const PHONE_WEIGHT = 1;

export function weightForChannel(channel: "email" | "sms") {
  return channel === "sms" ? PHONE_WEIGHT : EMAIL_WEIGHT;
}

export function isPendingWeight(weight: number) {
  return weight <= PENDING_WEIGHT;
}
