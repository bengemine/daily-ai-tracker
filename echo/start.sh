#!/usr/bin/env bash
set -euo pipefail
app_dir="$(dirname "$(readlink -f "$0")")"
service=echo-conversation-finder.service
if ! systemctl --user cat "$service" >/dev/null 2>&1; then
  # Write a user service that runs serve.sh from this folder.
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$unit_dir"
  serve_path="${app_dir}/serve.sh"
  serve_path="${serve_path//%/%%}"
  cat > "$unit_dir/$service" <<UNIT
[Unit]
Description=Echo conversation finder
After=default.target

[Service]
Type=simple
ExecStart=/bin/bash "${serve_path}"
Restart=on-failure
RestartSec=3
KillMode=control-group
TimeoutStopSec=5
UMask=0077

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable "$service"
fi
systemctl --user start "$service"
for attempt in {1..40}; do
  if curl -fsS http://127.0.0.1:4317/api/status 2>/dev/null | python3 -c 'import sys,json; assert json.load(sys.stdin)["app"] == "echo-conversation-finder"' 2>/dev/null; then
    exit 0
  fi
  sleep .25
done
printf 'Echo could not start. Run: journalctl --user -u %s -n 30\n' "$service" >&2
exit 1
