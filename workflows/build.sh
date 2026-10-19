#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH=$(readlink -f -- "${BASH_SOURCE[0]}")
ROOT_DIR=${SCRIPT_PATH%/*}

SRC_DIR=$ROOT_DIR/src
TEMPLATE_DIR=$ROOT_DIR/templates
DIST_DIR=${DIST_DIR:-$ROOT_DIR/dist}
JS_DIR=$ROOT_DIR/build

CONFIG=${CONFIG:-$ROOT_DIR/canvas.yml}
ENCRYPTED_CONFIG=${ENCRYPTED_CONFIG:-$ROOT_DIR/canvas.sops.yml}
LOCAL_CONFIG=${LOCAL_CONFIG:-$ROOT_DIR/canvas.local.yml}
ENCRYPTED=${ENCRYPTED:-${ROOT_DIR%/*}/secrets.sops.yml}
LOCAL_VALUES=${LOCAL_VALUES:-${ROOT_DIR%/*}/secrets.local.env}

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
	printf 'usage: %s [--local] [--help]\n\n' "${0##*/}"
	printf 'Type-checks the Code node sources in %s, then fills the workflow templates\n' "$SRC_DIR"
	printf 'and writes them, encrypted, to %s/canvas.sops.json\n\n' "$DIST_DIR"
	printf '  --local  build for n8n-local: read the ntfy values from %s\n' "$LOCAL_VALUES"
	printf '           instead of decrypting %s, put the ids in\n' "$ENCRYPTED"
	printf '           %s on top, and write %s/canvas.json\n' "$LOCAL_CONFIG" "$DIST_DIR"
	printf '           in plaintext\n'
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

REQUIRED=(jq sops yq)
for cmd in "${REQUIRED[@]}"; do
	command -v "$cmd" >/dev/null || abort "$cmd is required"
done
[[ -x $ROOT_DIR/node_modules/.bin/tsc ]] || abort "tsc not found, run pnpm install first"

if [[ -n $LOCAL ]]; then
	[[ -f $LOCAL_VALUES ]] || abort "$LOCAL_VALUES not found, run init.sh --local first"
	[[ -f $LOCAL_CONFIG ]] || abort "$LOCAL_CONFIG not found, run workflows/init.sh --local first"
	SECRETS=(yq -p props -o json '.[] |= (sub("^\"|\"$"; "") | sub("\$\$"; "$$"))' -- "$LOCAL_VALUES")
	OVERRIDE_CONFIG=$(yq -o json "$LOCAL_CONFIG")
	OUTPUT=$DIST_DIR/canvas.json
	WRITE=(cat)
else
	SECRETS=(sops --decrypt --output-type json "$ENCRYPTED")
	OVERRIDE_CONFIG={}
	OUTPUT=$DIST_DIR/canvas.sops.json
	WRITE=(sops --encrypt --filename-override "$OUTPUT" --input-type json /dev/stdin)
fi

log "reading $CONFIG, $ENCRYPTED_CONFIG and the ntfy values"
PLAIN_CONFIG=$(yq -o json "$CONFIG")
DECRYPTED_CONFIG=$(sops --decrypt --output-type json "$ENCRYPTED_CONFIG")
MERGED_CONFIG=$("${SECRETS[@]}" | PLAIN_CONFIG=$PLAIN_CONFIG DECRYPTED_CONFIG=$DECRYPTED_CONFIG \
	OVERRIDE_CONFIG=$OVERRIDE_CONFIG jq '
	($ENV.PLAIN_CONFIG | fromjson)
	* ($ENV.DECRYPTED_CONFIG | fromjson)
	* ($ENV.OVERRIDE_CONFIG | fromjson)
	* {ntfy: {alert_topic: .NTFY_ALERT_TOPIC, base_url: .NTFY_BASE_URL, topic: .NTFY_TOPIC}}')

MISSING=$(jq -r '
	if .ntfy.enabled then . else del(.ntfy, .n8n.credentials.ntfy) end
	| [paths(. == "" or . == null) | join(".")]
	| join(", ")' <<<"$MERGED_CONFIG")
[[ -z $MISSING ]] || abort "the config is missing $MISSING"

log "type-checking and stripping types with tsc"
"$ROOT_DIR/node_modules/.bin/tsc" -p "$ROOT_DIR/tsconfig.json"

WORKFLOW_NODE_CONFIG=$(jq 'del(.n8n) | .courses |= map([.id, del(.id)])' <<<"$MERGED_CONFIG")
JS_FILES=()
for js in "$JS_DIR"/*.js; do
	name=${js##*/}
	JS_FILES+=(--rawfile "${name%.js}" "$js")
done

mkdir -p "$DIST_DIR"
umask 077
TMP=$(mktemp "$OUTPUT.XXXXXX")
trap 'rm -f "$TMP"' EXIT

MERGED_CONFIG=$MERGED_CONFIG WORKFLOW_NODE_CONFIG=$WORKFLOW_NODE_CONFIG \
	jq "${JS_FILES[@]}" -f "$ROOT_DIR/fill.jq" "$TEMPLATE_DIR"/*.json \
	| jq -s '{workflows: .}' \
	| "${WRITE[@]}" >"$TMP"
mv "$TMP" "$OUTPUT"
log "wrote $OUTPUT"
