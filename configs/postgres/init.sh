#!/usr/bin/env bash
set -e

resolve_secret() {
	local var=$1 file_var="${1}_FILE"
	local path=${!file_var:-}

	unset "$file_var"
	[[ -n $path ]] || return 0

	if [[ -n ${!var:-} ]]; then
		printf >&2 'error: both %s and %s are set (but are exclusive)\n' "$var" "$file_var"
		exit 1
	elif [[ ! -r $path ]]; then
		printf >&2 'error: %s=%s is not readable\n' "$file_var" "$path"
		exit 1
	fi

	declare -g "$var=$(<"$path")"
}

resolve_secret N8N_PASSWORD
resolve_secret BORGMATIC_PASSWORD
resolve_secret NTFY_PASSWORD

### Roles and databases

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE ROLE n8n LOGIN PASSWORD '${N8N_PASSWORD:?}' CONNECTION LIMIT 15;
	CREATE ROLE ntfy LOGIN PASSWORD '${NTFY_PASSWORD:?}' CONNECTION LIMIT 30;
	CREATE ROLE postgres_monitor LOGIN CONNECTION LIMIT 5;
	CREATE ROLE borgmatic LOGIN PASSWORD '${BORGMATIC_PASSWORD:?}' CONNECTION LIMIT 5 IN ROLE pg_read_all_data;

	CREATE DATABASE ntfy OWNER ntfy;
	ALTER DATABASE n8n OWNER TO n8n;
	REVOKE ALL ON DATABASE n8n, ntfy, postgres, template1 FROM public;

	GRANT CONNECT ON DATABASE n8n TO n8n;
	GRANT CONNECT ON DATABASE ntfy TO ntfy;
	GRANT CONNECT ON DATABASE postgres TO postgres_monitor;
	GRANT CONNECT ON DATABASE n8n, ntfy TO borgmatic;
EOSQL

### Database hardening

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname n8n <<-EOSQL
	ALTER SCHEMA public OWNER TO n8n;
	REVOKE ALL ON SCHEMA public FROM public;
	GRANT ALL ON SCHEMA public TO n8n;

	ALTER DEFAULT PRIVILEGES FOR ROLE n8n REVOKE EXECUTE ON FUNCTIONS FROM public;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname ntfy <<-EOSQL
	ALTER SCHEMA public OWNER TO ntfy;
	REVOKE ALL ON SCHEMA public FROM public;
	GRANT ALL ON SCHEMA public TO ntfy;

	ALTER DEFAULT PRIVILEGES FOR ROLE ntfy REVOKE EXECUTE ON FUNCTIONS FROM public;
EOSQL

### Banning of superusers

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-'EOSQL'
	ALTER ROLE postgres PASSWORD NULL;
EOSQL
