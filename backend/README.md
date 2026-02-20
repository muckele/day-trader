# Backend

## Local Run

```bash
npm install
npm start
```

Server default: `http://localhost:4000`

## Tests

```bash
npm test
```

## Robo Trader

Robo Trader adds:

- User settings (`enabled`, `dailyLimit`, `weeklyLimit`, `monthlyLimit`)
- Usage buckets (`day`, `week`, `month`) tracked in UTC
- Audit trail events (`trade_executed`, `trade_skipped_limit`, `robo_disabled`, `email_sent`, `email_failed`, etc.)

API endpoints:

- `GET /api/robo/settings`
- `PUT /api/robo/settings`
- `GET /api/robo/audit?from=&to=&limit=`

## Environment Variables

Core:

- `MONGO_URI`
- `JWT_SECRET`
- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`
- `APCA_DATA_URL`
- `APCA_DATA_FEED` (recommended: `iex`)

Robo Trader:

- `ROBO_SCHEDULER_DISABLED` (`true` to disable background loop)
- `ROBO_SIGNAL_SYMBOL` (placeholder scheduler symbol, default `AAPL`)
- `ROBO_SIGNAL_QTY` (default `1`)
- `ROBO_SIGNAL_SIDE` (`buy`/`sell`, default `buy`)
- `ROBO_FALLBACK_EMAIL` (optional fallback recipient)

Robo email provider:

- `ROBO_EMAIL_PROVIDER` (`log` or `smtp`; default auto-selects `smtp` if `SMTP_HOST` exists, otherwise `log`)
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

## Fly Deploy Notes

Recommended `fly secrets` include:

- `MONGO_URI`
- `JWT_SECRET`
- `APCA_API_KEY_ID`
- `APCA_API_SECRET_KEY`
- `APCA_DATA_URL`
- `APCA_DATA_FEED=iex`
- Any SMTP variables if using real email notifications

Example:

```bash
cd backend
fly secrets set APCA_DATA_FEED=iex
fly deploy
```

Do not commit real API keys, SMTP credentials, or database URIs.
