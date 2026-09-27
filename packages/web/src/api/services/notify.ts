/**
 * OTP delivery. Email is the live channel for this build; the SMS/WhatsApp
 * aggregator (Termii primary, Africa's Talking failover) plugs into the same
 * `deliver()` contract once credentials exist — `channel` already flows through
 * the otp_codes table, so cost-per-verified-vote reporting does not change.
 */

export interface DeliveryResult {
  delivered: boolean;
  provider: string;
  /** Present only in dev mode, where there is no provider to deliver through. */
  devCode?: string;
  costKobo: number;
  error?: string;
}

const FROM = process.env.OTP_FROM_EMAIL ?? "NaijaRank <onboarding@resend.dev>";

export async function deliverEmailOtp(to: string, code: string): Promise<DeliveryResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // No provider wired: the code is returned to the caller and logged, clearly
    // labelled as dev mode. Never enable this path in production.
    console.log(`[otp] dev mode — code for ${to}: ${code}`);
    return { delivered: false, provider: "dev", devCode: code, costKobo: 0 };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        subject: `${code} is your NaijaRank code`,
        text: `Your NaijaRank verification code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`,
        html: otpHtml(code),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("[otp] resend failed", res.status, body);
      return { delivered: false, provider: "resend", costKobo: 0, error: `provider ${res.status}` };
    }
    return { delivered: true, provider: "resend", costKobo: 0 };
  } catch (err) {
    console.error("[otp] resend threw", err);
    return { delivered: false, provider: "resend", costKobo: 0, error: "network" };
  }
}

function otpHtml(code: string) {
  return `<!doctype html><html><body style="margin:0;background:#FBFAF6;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:32px">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E6E3D9;border-radius:16px;padding:32px">
<tr><td>
<div style="font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:#0B5D2E;font-weight:700">NaijaRank</div>
<h1 style="font-size:22px;margin:16px 0 8px;color:#0B1410">Make your vote count</h1>
<p style="margin:0 0 24px;color:#5C6B61;font-size:15px;line-height:1.5">Enter this code to verify your vote. Verified votes count at full weight.</p>
<div style="font-size:38px;font-weight:800;letter-spacing:.18em;color:#0B1410;background:#F3F6F1;border-radius:12px;padding:18px;text-align:center">${code}</div>
<p style="margin:24px 0 0;color:#5C6B61;font-size:13px">Expires in 10 minutes. One vote per person per board.</p>
</td></tr></table></body></html>`;
}
