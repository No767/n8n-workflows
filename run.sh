#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH=$(readlink -f -- "${BASH_SOURCE[0]}")
ROOT_DIR=${SCRIPT_PATH%/*}

ENCRYPTED=${ENCRYPTED:-$ROOT_DIR/secrets.sops.yml}
WORKFLOWS_DIR=${WORKFLOWS_DIR:-$ROOT_DIR/workflows}
WORKFLOWS_FILE=$WORKFLOWS_DIR/dist/canvas.sops.json
AGE_KEY_CMD='systemd-creds decrypt /etc/credstore.encrypted/age.key'

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
	printf 'usage: %s [--init] [--import] [--help]\n\n' "${0##*/}"
	printf 'Starts the docker compose stack, then:\n\n'
	printf '  --init    import and publish Canvas Init, which creates the data tables.\n'
	printf '            Once, before the first --import\n'
	printf '  --import  import the workflows in %s\n' "$WORKFLOWS_FILE"
	printf '            and publish them\n'
	printf '  --help    show this help\n'
}

INIT=
IMPORT=
while [[ $# -gt 0 ]]; do
	case $1 in
		--init)
			INIT=1
			shift
			;;
		--import)
			IMPORT=1
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

REQUIRED=(docker jq sops)
[[ -z $INIT && -z $IMPORT ]] || REQUIRED+=(yq)

for cmd in "${REQUIRED[@]}"; do
	command -v "$cmd" >/dev/null || abort "$cmd is required"
done

[[ $(id -u) == 0 ]] || abort "run as root via sudo"
[[ -f $ENCRYPTED ]] || abort "$ENCRYPTED not found, run ./init.sh first"
[[ -z $IMPORT || -f $WORKFLOWS_FILE ]] \
	|| abort "$WORKFLOWS_FILE not found, run workflows/build.sh first"

docker info --format json | jq --exit-status '.Runtimes | has("sysbox-runc")' >/dev/null \
	|| abort "sysbox-runc isn't a registered docker runtime"

log "starting docker compose stack"
SOPS_AGE_KEY_CMD=$AGE_KEY_CMD \
	sops exec-env "$ENCRYPTED" "docker compose -f '$ROOT_DIR/docker-compose.prod.yml' up --wait"

log "the stack is up"

if [[ -n $INIT ]]; then
	INIT_ID=$(yq '.n8n.workflows.init' "$WORKFLOWS_DIR/canvas.yml")

	log "importing and publishing Canvas Init"

	jq --arg id "$INIT_ID" '.id = $id | del(.settings.errorWorkflow)' \
		"$WORKFLOWS_DIR/templates/canvas-init.json" \
		| docker --log-level error compose -f "$ROOT_DIR/docker-compose.prod.yml" \
			exec -T n8n n8n import:workflow --input=/dev/stdin

	docker --log-level error compose -f "$ROOT_DIR/docker-compose.prod.yml" \
		exec -T n8n n8n publish:workflow --id="$INIT_ID"

	log "Canvas Init runs within about 10 s. The data table ids are in its execution, under each"
	log "Create node's id, and on n8n's Data tables page. Add them with workflows/init.sh, then"
	log "build, and run this again with --import"
fi

if [[ -n $IMPORT ]]; then
	log "importing the workflows in $WORKFLOWS_FILE"
	SOPS_AGE_KEY_CMD=$AGE_KEY_CMD sops --decrypt --extract '["workflows"]' "$WORKFLOWS_FILE" \
		| docker --log-level error compose -f "$ROOT_DIR/docker-compose.prod.yml" \
			exec -T n8n n8n import:workflow --input=/dev/stdin
	while IFS= read -r id; do
		docker --log-level error compose -f "$ROOT_DIR/docker-compose.prod.yml" \
			exec -T n8n n8n publish:workflow --id="$id"
	done < <(yq '.n8n.workflows[]' "$WORKFLOWS_DIR/canvas.yml")
	log "published, n8n picks them up within about 10 s"
fi
