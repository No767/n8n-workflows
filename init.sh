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
	printf 'usage: %s [--local] [--help]\n\n' "${0##*/}"
	printf '  --local  print the values to stdout and keep them in plaintext in\n'
	printf '           %s instead of encrypting them. For local dev, where\n' "$LOCAL_VALUES"
	printf '           compose reads them with --env-file\n'
	printf '  --help   show this help\n'
}

LOCAL=
while [[ $# -gt 0 ]]; do
	case $1 in
		--local)
			LOCAL=1
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

REQUIRED=(openssl yq)
[[ -n $LOCAL ]] || REQUIRED+=(gum sops)

for cmd in "${REQUIRED[@]}"; do
	command -v "$cmd" >/dev/null || abort "$cmd is required"
done

if [[ -n $LOCAL ]]; then
	[[ -f $LOCAL_VALUES ]] && KEPT=(yq -p props -o yaml -- "$LOCAL_VALUES")
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
	local value=${EXISTING[$key]:-${LOCAL:+$default}}
	[[ -n $value ]] || value=$(gum input --password --no-show-help --prompt "$prompt: " </dev/tty)
	put "$key" "$value"
}

generate N8N_ENCRYPTION_KEY 32
generate POSTGRES_PASSWORD 32
generate N8N_DB_PASSWORD 32
generate N8N_RUNNERS_AUTH_TOKEN 32

generate SANDBOX_API_KEY 24
generate SANDBOX_REGISTRATION_TOKEN 24
generate SANDBOX_RUNNER_API_KEY 24
generate SEARXNG_SECRET 24

ask TS_AUTHKEY 'Tailscale Auth Key' local-tailscale-auth-key
ask CLOUDFLARE_API_TOKEN 'Cloudflare API Token' local-cloudflare-api-token

if [[ -n $LOCAL ]]; then
	(
		umask 077
		for key in "${KEYS[@]}"; do
			KEY=$key VALUE=${SECRETS[$key]} yq -n '{strenv(KEY): strenv(VALUE)}'
		done \
			| yq -o props --properties-separator '=' \
			| tee -- "$LOCAL_VALUES"
	)

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
