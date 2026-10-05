#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH=$(readlink -f -- "${BASH_SOURCE[0]}")
ROOT_DIR=${SCRIPT_PATH%/*}

ENCRYPTED=${ENCRYPTED:-$ROOT_DIR/secrets.sops.yml}
LOCAL_VALUES=${LOCAL_VALUES:-$ROOT_DIR/secrets.local.env}

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
	BLUE=$'\033[1;34m' RED=$'\033[1;31m' RESET=$'\033[0m'
else
	BLUE='' RED='' RESET=''
fi

log() { [[ -n ${LOCAL:-} ]] || printf '%s==>%s %s\n' "$BLUE" "$RESET" "$*" >&2; }
abort() {
	printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2
	exit 1
}

usage() {
	printf 'usage: %s [--local] [--print] [--rotate] [--rotate-tokens] [--help]\n\n' "${0##*/}"
	printf '  --local          keep the values in plaintext in %s\n' "$LOCAL_VALUES"
	printf '                   instead of encrypting them. For local dev, where compose\n'
	printf '                   reads them with --env-file\n'
	printf '  --print          with --local, also print the values to stdout\n'
	printf '  --rotate         generate fresh values for the runner, sandbox, and SearXNG\n'
	printf '                   keys. Recreate the containers afterwards\n'
	printf '  --rotate-tokens  ask for the Tailscale auth key, Cloudflare API token,\n'
	printf '                   BorgBase repository URL and host key, and Healthchecks\n'
	printf '                   ping URL again. Press enter to keep the current one\n'
	printf '  --help           show this help\n'
}

LOCAL=
PRINT=
ROTATE=
ROTATE_TOKENS=
while [[ $# -gt 0 ]]; do
	case $1 in
		--local)
			LOCAL=1
			shift
			;;
		--print)
			PRINT=1
			shift
			;;
		--rotate)
			ROTATE=1
			shift
			;;
		--rotate-tokens)
			ROTATE_TOKENS=1
			shift
			;;
		--help)
			usage
			exit 0
			;;
		*)
			usage >&2
			abort "unknown option: $1"
			;;
	esac
done

[[ -z $PRINT || -n $LOCAL ]] || abort "--print only works with --local"

REQUIRED=(openssl yq)
[[ -n $LOCAL ]] || REQUIRED+=(gum sops)
[[ -z $ROTATE_TOKENS ]] || REQUIRED+=(gum)

for cmd in "${REQUIRED[@]}"; do
	command -v "$cmd" >/dev/null || abort "$cmd is required"
done

if [[ -n $LOCAL ]]; then
	[[ -f $LOCAL_VALUES ]] && KEPT=(yq -p props -o yaml '.[] |= sub("^\"|\"$"; "")' -- "$LOCAL_VALUES")
elif [[ -f $ENCRYPTED ]]; then
	log "reading the values already in $ENCRYPTED"
	KEPT=(sops --decrypt "$ENCRYPTED")
fi

declare -A EXISTING=()
if [[ -v KEPT ]]; then
	while IFS= read -r -d '' key && IFS= read -r -d '' value; do
		EXISTING[$key]=$value
	done < <("${KEPT[@]}" | yq -0 'to_entries | map([.key, .value]) | flatten | .[]')
	((${#EXISTING[@]})) || abort "could not read the values already in ${KEPT[-1]}"
fi

[[ -z $ROTATE ]] || unset \
	'EXISTING[N8N_RUNNERS_AUTH_TOKEN]' \
	'EXISTING[SANDBOX_API_KEY]' \
	'EXISTING[SANDBOX_REGISTRATION_TOKEN]' \
	'EXISTING[SANDBOX_RUNNER_API_KEY]' \
	'EXISTING[SEARXNG_SECRET]'

KEYS=()
declare -A SECRETS=()
put() {
	local key=$1 value=$2
	[[ -n $value ]] || abort "$key cannot be empty"
	KEYS+=("$key")
	SECRETS[$key]=$value
}

generate() {
	local key=$1 bytes=$2
	put "$key" "${EXISTING[$key]:-$(openssl rand -hex "$bytes")}"
}

ask() {
	local key=$1 prompt=$2 default=${3:-}
	local value=${EXISTING[$key]:-${LOCAL:+$default}} input=
	[[ -n $value && -z $ROTATE_TOKENS ]] || input=$(gum input --password --no-show-help --prompt "$prompt: " </dev/tty)
	put "$key" "${input:-$value}"
}

generate N8N_ENCRYPTION_KEY 32
generate POSTGRES_PASSWORD 32
generate N8N_DB_PASSWORD 32
generate BORGMATIC_DB_PASSWORD 32
generate N8N_RUNNERS_AUTH_TOKEN 32

generate SANDBOX_API_KEY 24
generate SANDBOX_REGISTRATION_TOKEN 24
generate SANDBOX_RUNNER_API_KEY 24
generate SEARXNG_SECRET 24

generate BORG_PASSPHRASE 32
put BORG_SSH_KEY "${EXISTING[BORG_SSH_KEY]:-$(openssl genpkey -algorithm ed25519)}"

ask TS_AUTHKEY 'Tailscale Auth Key' local-tailscale-auth-key
ask CLOUDFLARE_API_TOKEN 'Cloudflare API Token' local-cloudflare-api-token
ask BORG_REPO 'BorgBase Repository URL' local-borg-repo
ask BORG_KNOWN_HOSTS 'BorgBase Host Key' local-borg-known-hosts
ask HEALTHCHECKS_URL 'Healthchecks Ping URL' local-healthchecks-url

if [[ -n $LOCAL ]]; then
	(
		umask 077
		for key in "${KEYS[@]}"; do
			KEY=$key VALUE=${SECRETS[$key]} yq -n '{strenv(KEY): "\"" + strenv(VALUE) + "\""}'
		done \
			| yq -o props --properties-separator '=' >"$LOCAL_VALUES"
	)
	[[ -z $PRINT ]] || cat -- "$LOCAL_VALUES"

	exit 0
fi

umask 077
TMP=$(mktemp "$ENCRYPTED.XXXXXX")
trap 'rm -f "$TMP"' EXIT

log "encrypting to $ENCRYPTED"
for key in "${KEYS[@]}"; do
	KEY=$key VALUE=${SECRETS[$key]} yq -n '{strenv(KEY): strenv(VALUE)}'
done \
	| sops --encrypt --filename-override "$ENCRYPTED" --input-type yaml /dev/stdin >"$TMP"

mv "$TMP" "$ENCRYPTED"
log "wrote $ENCRYPTED"
