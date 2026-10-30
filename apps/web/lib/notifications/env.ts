// Server-only configuration for owner notifications and operator alerts.
export interface NotificationEnv {
  resendApiKey: string;
  fromEmail: string;
  // Where system alerts go. Optional: without it, alerts are only logged.
  opsAlertEmail: string | undefined;
}

// Returns null when email isn't configured, so calls keep working without it.
export function readNotificationEnv(env: NodeJS.ProcessEnv = process.env): NotificationEnv | null {
  const resendApiKey = env.RESEND_API_KEY;
  const fromEmail = env.NOTIFICATIONS_FROM_EMAIL;
  if (!resendApiKey || !fromEmail) return null;
  return { resendApiKey, fromEmail, opsAlertEmail: env.OPS_ALERT_EMAIL || undefined };
}
