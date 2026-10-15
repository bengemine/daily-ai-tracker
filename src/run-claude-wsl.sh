#!/usr/bin/env bash
set -euo pipefail

tracker_cli_args=("$@")
source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
exec claude "${tracker_cli_args[@]}"
