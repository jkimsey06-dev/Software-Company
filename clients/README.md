# Clients

One JSON file per client, named `<slug>.json`, validated against
`tenantConfigSchema` in `packages/shared/src/tenant-config.ts`.

- No secrets. Tokens and API keys live in environment variables or a secret store.
- No real customer data.
- `example-hvac.json` is a fake tenant used in tests and seed data.
