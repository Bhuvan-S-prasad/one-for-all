#!/bin/sh
# Runs once, when the Postgres data volume is first created.
# - Enables pgvector.
# - Creates the non-owner app role so row-level security applies to the app.
#   Tables are created later by migrations running as the owner role; default
#   privileges grant the app role access to them automatically.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE EXTENSION IF NOT EXISTS vector;

	DO \$\$
	BEGIN
	  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
	    CREATE ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
	  END IF;
	END
	\$\$;

	GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO ${APP_DB_USER};
	GRANT USAGE ON SCHEMA public TO ${APP_DB_USER};
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_DB_USER};
	ALTER DEFAULT PRIVILEGES FOR ROLE ${POSTGRES_USER} IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO ${APP_DB_USER};
EOSQL
