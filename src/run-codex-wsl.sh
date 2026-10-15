#!/usr/bin/env bash
set -euo pipefail

tracker_codex_args=("$@")
for ((tracker_arg_index=0; tracker_arg_index<${#tracker_codex_args[@]}; tracker_arg_index++)); do
  tracker_arg="${tracker_codex_args[$tracker_arg_index]}"
  if [[ "$tracker_arg" == "--cd" || "$tracker_arg" == "--output-schema" || "$tracker_arg" == "--output-last-message" ]]; then
    tracker_path_index=$((tracker_arg_index + 1))
    tracker_path="${tracker_codex_args[$tracker_path_index]}"
    if [[ "$tracker_path" =~ ^[A-Za-z]:[\\/] ]]; then
      tracker_codex_args[$tracker_path_index]="$(wslpath -u "$tracker_path")"
    fi
  fi
done

source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
exec codex "${tracker_codex_args[@]}"
