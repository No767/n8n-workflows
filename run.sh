#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH=$(readlink -f -- "${BASH_SOURCE[0]}")
ROOT_DIR=${SCRIPT_PATH%/*}

ENCRYPTED=${ENCRYPTED:-$ROOT_DIR/secrets.sops.yml}

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

[[ $(id -u) == 0 ]] || abort "run as root via sudo"
[[ -f $ENCRYPTED ]] || abort "$ENCRYPTED not found, run ./init.sh first"

docker info --format json | jq --exit-status '.Runtimes | has("sysbox-runc")' >/dev/null \
	|| abort "sysbox-runc isn't a registered docker runtime"

log "starting docker compose stack"
SOPS_AGE_KEY_CMD='systemd-creds decrypt /etc/credstore.encrypted/age.key' \
	sops exec-env "$ENCRYPTED" "docker compose -f '$ROOT_DIR/docker-compose.prod.yml' up --wait"

log "the stack is up"
