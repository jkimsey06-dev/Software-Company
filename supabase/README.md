# Supabase

- `migrations/`: SQL migrations, applied in filename order.
- `tests/`: RLS tests. Every new migration adds or updates a test here in the same change.
- `seed.sql`: fake data for dev only.
- `scripts/`: local test harness.

## Running the RLS tests locally

The tests run against a plain local Postgres (16+), using a small shim that stands
in for Supabase's `auth` schema and roles. The script creates a throwaway database,
applies the shim, migrations and tests, then drops the database. It refuses any
host other than localhost.

```bash
RLS_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm test:rls
```

## Applying migrations to dev

Migration files are named `<version>_<name>.sql`, where `<version>` must equal the
version Supabase records in `supabase_migrations.schema_migrations`. If they differ,
`supabase db push` treats the migration as unapplied and runs it again.

When a migration is applied through the Supabase MCP (`apply_migration`), Supabase
picks the version at apply time, so name the file after applying:

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

Then run the security and performance advisors and fix anything they report.

## Rules

- Every table holding client data has `tenant_id uuid not null`. The tests fail if not.
- RLS is enabled on every public table. The tests fail if not.
- No `delete` policies for users on client data unless there's a reason. Close records out with a status.
- Work against the `dev` project only. Staging and prod are promoted by hand.
