# Owner dashboard

Owners sign in at `/login` with an emailed link (no passwords) and see their
leads, the full text thread for each, estimate bookings, and calendar status.
Everything they see comes through their own session and the database's row-level
security: the dashboard never uses the service role key.

## Supabase Auth settings (per environment: dev, then staging and prod)

In the Supabase dashboard, **Authentication**:

1. **Sign In / Providers → Email:** keep Email on. Turn **off** "Allow new users to
   sign up". Owners are added by us, never self-registered.
2. **URL Configuration:** set **Site URL** to the app's public URL
   (`PUBLIC_BASE_URL`).
3. **Email Templates → Magic link:** change the link so it goes to our confirm page.
   Replace `{{ .ConfirmationURL }}` with:

   ```
   {{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}
   ```

   The page shows a "Continue" button, and the button does the sign-in. That way a
   mail scanner that opens the link can't use up the owner's one-time token, and the
   link works on any device.
4. **SMTP (before real clients):** Supabase's built-in sender is rate-limited and for
   testing only. Under **Project Settings → Authentication → SMTP**, use Resend's SMTP
   with your verified domain.

`.env.example` already has `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY`; both must be set on Vercel.

## How access works

- `tenant_members` links a user to a business (role `owner` or `staff`; the dashboard
  treats them the same for now). A signed-in user with no membership sees
  "That account isn't linked to a business yet".
- A user in several businesses gets a switcher. The choice is a cookie, and it is
  checked against their memberships on every request.
- Every page checks the session with Supabase (`getUser()`), and every query filters by
  the tenant as well as relying on row-level security.
- Customer text (messages, areas, addresses, notes) is shown as plain text and is never
  interpreted. Phone numbers are the only values that become links (`tel:`), and only
  when they are valid.
- Dashboard pages are never cached or framed (`Cache-Control: no-store`,
  `X-Frame-Options: DENY`).

## Adding an owner or staff member

When a client signs, add their people (dev first; for staging or prod you run it
yourself with that project's URL and service key):

```bash
NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  pnpm --filter @sc/web owner:add <tenant-id> <email> [owner|staff]
```

That is a dry run: it shows which Supabase project and which business it's talking
to, and what it would do. Add `--apply` to do it. It creates the login if needed and
adds the membership. **It sends no email.** Tell them to open `/login` on the app and
ask for a link. Use the service key only on your own machine, never in the app's
browser code or in chat.

## Editing a lead

On a lead's page the owner can change the status, name, address and notes (notes are
private to the business). Saving a note never undoes a status the system set while the
form was open: the status is only written if the owner changed it. When an estimate is
booked the lead becomes **Booked** automatically, unless the owner already moved it to
Won, Lost or Spam.

## What the owner can't do here (yet)

Reply to customers, or connect a calendar by themselves (we send a connect link, see
`calendar.md`).
