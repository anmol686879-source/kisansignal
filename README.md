# KisanSignal

Farm-advice app with an optional Node backend for accounts and saved fields. Weather and soil data come from
NASA POWER and Open-Meteo in the browser. The **Sensors** tab uses SoilSCAPE in-situ soil moisture (ORNL DAAC,
doi 10.3334/ORNLDAAC/1339).

    public/index.html     the app (served by the backend)
    server/               Express API + SQLite/PostgreSQL (Node 22+)
    test/                 API tests (npm test)
    scripts/              rebuilds the SoilSCAPE data block from the zip

## Run locally
    npm install
    npm start                 # http://localhost:8080
In development the one-time code is printed in the server log and shown on the login screen
(`SMS_PROVIDER=console`). That mode is refused when `NODE_ENV=production`.

## Deploy a free demo
The included [Render Blueprint](./render.yaml) publishes `public/` as a free static site. With no backend, the app
uses its browser-only demo login: a one-time demo code is shown in the interface and profile/field data stays in
that browser's local storage. This is a demo, not real identity verification or cloud account storage. Do not enter
real or sensitive personal information.

1. Push this repository to GitHub and connect it to Render.
2. Create a Blueprint from the repository and deploy it. No database URL, SMS account, or secret is required for
   the static demo.

The Neon project is available for future backend development; it is not used by this static deployment. To enable
real accounts and cross-device saved data later, deploy the Node API with PostgreSQL and configure a real SMS
provider. Displaying an authentication code to every visitor is not safe for real accounts.

For local development, run `npm install` then `npm start`. The backend uses SQLite and prints development OTPs
to the server log. To use Neon locally, the Neon CLI stores the connection in ignored `.env.local`; `npm start`
and `npm run dev` load it automatically. Never commit `.env` or `.env.local`.

The optional API sets Secure session cookies in production and should always be served over HTTPS. Run one
instance per SQLite database.

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
Static hosting intentionally uses the **demo** login (code shown on screen, data kept in the browser). Use it only
for demonstrations; it does not provide private accounts or cloud persistence.

## Refresh sensor data
    pip install netCDF4 numpy
    python scripts/build_soilscape.py SoilSCAPE_1339_1-*.zip --inject

## Still to do before a public launch
- Privacy policy and consent text (you store phone numbers and farm data).
- A shared rate-limit store if you ever run more than one instance; PostgreSQL stores account sessions and field data when configured.
- A map-tile provider for heavy traffic; OpenStreetMap's free servers are for light use.
- SoilSCAPE sites are in the USA with records ending 2012-2019: reference data, not advice for Indian districts.
