# KisanSignal (full-stack)

Farm-advice app with a Node backend: **real SMS one-time-code login** and **fields saved per account**
(SQLite locally, PostgreSQL when `DATABASE_URL` is set). Weather and soil data still come from NASA POWER and
Open-Meteo in the browser. The **Sensors** tab uses
SoilSCAPE in-situ soil moisture (ORNL DAAC, doi 10.3334/ORNLDAAC/1339).

    public/index.html     the app (served by the backend)
    server/               Express API + SQLite/PostgreSQL (Node 22+)
    test/                 API tests (npm test)
    scripts/              rebuilds the SoilSCAPE data block from the zip

## Run locally
    npm install
    npm start                 # http://localhost:8080
In development the one-time code is printed in the server log and shown on the login screen
(`SMS_PROVIDER=console`). That mode is refused when `NODE_ENV=production`.

## Deploy (free-tier option)
The included [Render Blueprint](./render.yaml) is configured for a free Render web service and PostgreSQL on
[Neon's Free plan](https://neon.com/pricing). This uses PostgreSQL because Render free services have ephemeral
filesystems; a SQLite database there would be lost whenever the service sleeps, restarts, or redeploys.

1. Create a Neon project and copy its pooled PostgreSQL connection string. Keep `sslmode=require` in the URL.
2. Push this project to a Git provider connected to Render, then create a new Render Blueprint from the repository.
3. Enter the Neon connection string as `DATABASE_URL`, and add the Twilio Account SID, Auth Token, and sender
   number or Messaging Service SID when Render requests the unsynchronized values.
4. Deploy the Blueprint. It generates `OTP_SECRET`, requires PostgreSQL, enables proxy-aware IP handling, and checks
   `/healthz` (including database connectivity).

Free-tier caveats: Render free web services sleep after inactivity and can take about a minute to wake. Neon Free
has usage limits and can scale to zero. Render says its free instances are for hobby/testing, not production.
Real SMS delivery requires a configured SMS provider and may incur costs; Twilio trial accounts have restrictions.
For India, register the sender ID and message template with DLT or carriers may block SMS.

For local development, run without a `.env` file to use SQLite and the console-only OTP provider, or set
`NODE_ENV=development` and `SMS_PROVIDER=console` in your local `.env`. For a VPS or another host with a persistent
disk, Docker Compose and Fly.io can still use the SQLite database at `/data/kisansignal.db`.
Neon CLI stores your local connection in the ignored `.env.local`; `npm start` and `npm run dev` load it
automatically. Never commit `.env` or `.env.local`.
Always serve over HTTPS (the session cookie is `Secure` in production) and run **one instance** per SQLite database.

## API
| Route | Purpose |
|---|---|
| `POST /api/otp/send` `{cc, phone}` | Send a 6-digit code. 30 s between sends, 5 per hour per number. |
| `POST /api/otp/verify` `{cc, phone, code}` | 5 tries, 5 min expiry. Sets an HttpOnly session cookie (30 days). |
| `GET /api/me` | Current user and fields. |
| `POST /api/profile` | Name, region, crop, language (first login). |
| `PUT /api/fields` | Replace the user's fields (max 8, validated). |
| `POST /api/logout`, `DELETE /api/me` | Sign out; delete account and data. |
| `GET /healthz` | Health check. |

Security: codes are stored only as salted hashes; sessions only as hashes; per-IP rate limits; JSON-only writes with
an Origin check (CSRF); strict CSP; field input validated server-side.

## Static-only mode
If you host just `public/` on a static host (Netlify, GitHub Pages) the app detects there is no API and falls back
to the old **demo** login (code shown on screen, data kept in the browser). Use that only for demos.

## Refresh sensor data
    pip install netCDF4 numpy
    python scripts/build_soilscape.py SoilSCAPE_1339_1-*.zip --inject

## Still to do before a public launch
- Privacy policy and consent text (you store phone numbers and farm data).
- A shared rate-limit store if you ever run more than one instance; PostgreSQL stores account sessions and field data when configured.
- A map-tile provider for heavy traffic; OpenStreetMap's free servers are for light use.
- SoilSCAPE sites are in the USA with records ending 2012-2019: reference data, not advice for Indian districts.
