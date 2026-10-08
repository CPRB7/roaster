# Resume Roast

A single Node.js app serves the existing frontend and its API. It uses SQLite
for the queue, reaction counts, votes and reports, and stores redacted resume
images as private files on disk. There is no browser-side vote database, auth
provider, cross-origin API or second operational database.

## Run locally

Requires Node.js 22.13 or newer.

```sh
npm install
Copy-Item .env.example .env
npm start
```

Open `http://localhost:3000`. The app creates its SQLite database and private
upload directory under `DATA_DIR` and a rolling backup in `BACKUP_DIR`. Keep
primary data on encrypted persistent storage and the backup path on a separate
encrypted persistent volume in production. Do not commit `.env`, database
files, uploads or backups.

## Queue and privacy lifecycle

- Uploads wait in FIFO order. One resume is made public for exactly six hours;
  the next queued resume then goes live. This allows up to four live slots per
  day, not a cap of four uploads. A busy queue may take longer to reach.
- The three reactions are `shit`, `mid` and `respect`. Votes are recorded by the
  server and limited to one per account (or anonymous browser cookie) per
  resume. The backend does not return aggregate results until the final 30
  minutes of that resume's live window.
- An account can upload one resume per rolling 30 days. The account's last
  upload timestamp is retained after the resume itself expires so the limit
  remains enforceable. Anonymous uploads are not identity-limited while login
  is optional.
- At expiry, the app removes the image, resume record, vote records and reports
  from the primary database and invalidates the previous backup before making
  a fresh snapshot of only still-active and queued resumes.
- Images are accepted as PNG, JPEG or WebP up to 12 MB, decoded and re-encoded
  as JPEG to strip source metadata. Uploads should already have been redacted
  in the browser; re-encoding does not identify or redact personal content.
- Optional report email is not collected or sent by this version. Google and
  email/password accounts are implemented; login enforcement is off by default.

## Accounts and login gate

Leave `REQUIRE_LOGIN=0` for launch: no sign-in button or account form is shown,
and uploads, votes and reports work without login. The account/authentication
routes and frontend are included but dormant. If moderation or abuse requires
it later, set `REQUIRE_LOGIN=1` and restart the server. The sign-in UI appears
and the backend then requires an account for uploading, voting and reporting.
This switch is enforced server-side; hiding the UI alone is not the security
boundary. The one-upload-per-30-days limit applies to signed-in accounts.
Turning the gate on does not retroactively associate earlier anonymous uploads
with accounts.

Email/password accounts require passwords of at least 12 characters and store
only salted scrypt hashes. Google sign-in is enabled when both
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are configured. Register this
callback URL with Google OAuth:
`{PUBLIC_ORIGIN}/api/auth/google/callback`. Google email verification is
required; accounts are not automatically linked across sign-in methods.
This initial email/password implementation does not include email ownership
verification, password reset or account recovery, so configure Google OAuth
before production or add a verified recovery flow before relying on password
accounts.

Copy `.env.example` to `.env`; `npm start` loads that file. Set the Google
OAuth callback to the exact `PUBLIC_ORIGIN` plus
`/api/auth/google/callback`. Configure credentials before enabling login if
you want Google sign-in; otherwise the email/password option is available.

Authentication sessions are opaque random tokens stored hashed in SQLite and
sent in HTTP-only SameSite cookies. The app has no developer/admin account or
moderation dashboard; the login gate applies to public actions, not operational
administration.

## Security notes

Helmet security headers, same-origin mutation checks, HTTP-only SameSite vote
cookies, rate limits, SQLite parameterized statements, image decoding/re-encode,
upload size/type limits, and non-public file storage are enabled. Configure TLS
at the hosting platform, restrict host filesystem access, patch dependencies,
and use a dedicated low-privilege OS account. `TRUST_PROXY` should only be
enabled when the app is behind a trusted reverse proxy.

No application can promise that data can never leak. Resumes are deliberately
public while live, so users must redact identifying information before upload.
Anyone who can access the public site during that window can view and save the
image. A vote cookie is best-effort duplicate-vote prevention, not verified
identity.

## Backups and deletion limits

With `BACKUP_DIR` configured, the app makes a complete snapshot at startup and
every 24 hours, and refreshes it after a resume expires. Only one snapshot is
retained; each snapshot includes the database and images that are queued or
live at snapshot time. The expired resume is removed from the rolling snapshot
before a replacement is published. There is a recovery-point gap of up to 24
hours for uploads made since the previous snapshot. Configure storage-level
encryption and access controls for the backup volume, mount it separately from
`DATA_DIR`, and never expose it to the web server.

Deletion from the primary data and current rolling snapshot is immediate after
the six-hour window. Filesystem snapshots, drive remnants, host/provider
backups, or copies saved by viewers are outside this app's control. Do not
promise erasure from those systems.

To restore the latest snapshot, stop the app, copy
`BACKUP_DIR/latest/resume-roast.sqlite` to `DATA_DIR/resume-roast.sqlite`, and
copy `BACKUP_DIR/latest/uploads` to `UPLOAD_DIR`. Start the app; its startup
cleanup removes any resumes whose six-hour windows have already expired.

In production, set `NODE_ENV=production`, `PUBLIC_ORIGIN` to the exact HTTPS
origin, `BACKUP_DIR` to a separate encrypted mounted volume, and
`TRUST_PROXY=1` only behind a trusted single reverse proxy. This app is designed
for one Node process on a persistent-volume host. It is
not configured for multi-instance deployment or cloud object storage. Do not
put it behind multiple replicas without replacing the local SQLite/filesystem
coordination with shared transactional storage.

## API

- `GET /api/live` — current public resume, timer and (only in the final 30
  minutes) reaction totals.
- `GET /api/live/image` — current live image, served with `no-store`.
- `POST /api/uploads` — multipart image upload (`resume`, optional `label`).
- `POST /api/votes` — `{ "reaction": "shit" | "mid" | "respect" }`.
- `POST /api/reports` — `{ "reason": "not-resume" | "hate" | "private-info" | "other" }`.
- `GET /api/auth/status` — login requirement, Google availability and current account.
- `POST /api/auth/register` / `POST /api/auth/login` — email/password accounts.
- `GET /api/auth/google` — begin configured Google OAuth.
- `POST /api/auth/logout` — revoke the current session.
- `GET /api/health` — process health only; no sensitive data.
