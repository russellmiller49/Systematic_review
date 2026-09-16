import { invalidState } from "@/server/errors";

export function passwordResetEmailConfig() {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  const rawUrl = process.env.APP_URL;
  let appUrl: URL;
  try {
    appUrl = new URL(rawUrl ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname);
    if (appUrl.username || appUrl.password ||
        (appUrl.protocol !== "https:" && !(local && appUrl.protocol === "http:"))) {
      throw new Error("Invalid application URL");
    }
  } catch {
    throw invalidState("Password reset is temporarily unavailable. Please contact your workspace owner.");
  }
  if (!apiKey || !from) {
    throw invalidState("Password reset is temporarily unavailable. Please contact your workspace owner.");
  }
  return { apiKey, from, origin: appUrl.origin };
}

export async function sendPasswordResetEmail(
  email: string,
  token: string,
  config: ReturnType<typeof passwordResetEmailConfig>,
) {
  const url = new URL("/reset-password", config.origin);
  // A fragment keeps the secret out of HTTP request URLs, access logs and referrers.
  url.hash = new URLSearchParams({ token }).toString();
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: config.from,
      to: [email],
      subject: "Reset your Synthesis password",
      text: `We received a request to reset your Synthesis password.\n\nChoose a new password using this link:\n${url.toString()}\n\nThis link expires in 30 minutes and can only be used once. If you did not request a reset, you can ignore this email. Your password has not changed.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  // Never log provider response bodies: they may contain recipient details.
  if (!response.ok) throw new Error(`Password reset email delivery failed (${response.status})`);
}
