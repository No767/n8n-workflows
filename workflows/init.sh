#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH=$(readlink -f -- "${BASH_SOURCE[0]}")
ROOT_DIR=${SCRIPT_PATH%/*}

ENCRYPTED_CONFIG=${ENCRYPTED_CONFIG:-$ROOT_DIR/canvas.sops.yml}
LOCAL_CONFIG=${LOCAL_CONFIG:-$ROOT_DIR/canvas.local.yml}

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
	BLUE=$'\033[1;34m' RED=$'\033[1;31m' RESET=$'\033[0m'
else
	BLUE='' RED='' RESET=''
fi

log() { printf '%s==>%s %s\n' "$BLUE" "$RESET" "$*" >&2; }
abort() {
	printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2
	exit 1
}

usage() {
	printf 'usage: %s [--local] [--ask-all] [--help]\n\n' "${0##*/}"
	printf 'Asks for the Asana, Google Calendar and n8n ids missing from %s,\n' "$ENCRYPTED_CONFIG"
	printf 'then encrypts it again. The Canvas URL and the courses are edited with sops edit\n\n'
	printf '  --local    fill in %s instead, in plaintext. For n8n-local\n' "$LOCAL_CONFIG"
	printf '  --ask-all  ask for every id again. Press enter to keep the current one\n'
	printf '  --help     show this help\n'
}

LOCAL=
ASK_ALL=
while [[ $# -gt 0 ]]; do
	case $1 in
		--local)
			LOCAL=1
			shift
			;;
		--ask-all)
			ASK_ALL=1
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

REQUIRED=(gum yq)
[[ -n $LOCAL ]] || REQUIRED+=(sops)

for cmd in "${REQUIRED[@]}"; do
	command -v "$cmd" >/dev/null || abort "$cmd is required"
done

CONFIG={}
if [[ -n $LOCAL ]]; then
	[[ ! -f $LOCAL_CONFIG ]] || CONFIG=$(<"$LOCAL_CONFIG")
elif [[ -f $ENCRYPTED_CONFIG ]]; then
	log "reading the values already in $ENCRYPTED_CONFIG"
	CONFIG=$(sops --decrypt "$ENCRYPTED_CONFIG")
fi

ask() {
	local path=$1 prompt=$2
	local value input=
	value=$(yq ".$path // \"\"" <<<"$CONFIG")
	[[ -n $value && -z $ASK_ALL ]] \
		|| input=$(gum input --no-show-help --prompt "$prompt: " --value "$value" </dev/tty)
	CONFIG=$(VALUE=${input:-$value} yq ".$path = strenv(VALUE)" <<<"$CONFIG")
}

ask asana.project 'Asana Project ID'
ask asana.missed_section 'Asana Missed Section ID'
ask calendar.id 'Google Calendar ID'
ask n8n.credentials.canvas 'n8n Canvas Credential ID'
ask n8n.credentials.asana 'n8n Asana Credential ID'
ask n8n.credentials.google_calendar 'n8n Google Calendar Credential ID'
ask n8n.credentials.ntfy 'n8n ntfy Credential ID'
ask n8n.data_tables.ledger 'n8n canvas_ledger Table ID'
ask n8n.data_tables.meta 'n8n canvas_meta Table ID'

if [[ -n $LOCAL ]]; then
	(
		umask 077
		printf '%s\n' "$CONFIG" >"$LOCAL_CONFIG"
	)
	log "wrote $LOCAL_CONFIG"

	exit 0
fi

umask 077
TMP=$(mktemp "$ENCRYPTED_CONFIG.XXXXXX")
trap 'rm -f "$TMP"' EXIT

log "encrypting to $ENCRYPTED_CONFIG"
sops --encrypt --filename-override "$ENCRYPTED_CONFIG" --input-type yaml /dev/stdin \
	<<<"$CONFIG" >"$TMP"

mv "$TMP" "$ENCRYPTED_CONFIG"
log "wrote $ENCRYPTED_CONFIG"
