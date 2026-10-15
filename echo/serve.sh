#!/usr/bin/env bash
set -euo pipefail
app_dir="$(dirname "$(readlink -f "$0")")"
# Optional local settings (see echo.env.example). Not committed.
if [[ -f "$app_dir/echo.env" ]]; then
  set -a
  source "$app_dir/echo.env"
  set +a
fi
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${HOME}/.nvm"
  if [[ -s "${NVM_DIR}/nvm.sh" ]]; then
    source "${NVM_DIR}/nvm.sh"
  fi
fi
export PATH="${HOME}/.local/bin:${PATH}:/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0"
if [[ -n "${ECHO_WINDOWS_HOME:-}" ]]; then
  # Windows Terminal (wt.exe) lives here.
  export PATH="${PATH}:${ECHO_WINDOWS_HOME}/AppData/Local/Microsoft/WindowsApps"
fi
export WSL_DISTRO_NAME="${WSL_DISTRO_NAME:-Ubuntu}"
if [[ -S /run/WSL/1_interop ]]; then
  export WSL_INTEROP=/run/WSL/1_interop
fi
cd -- "$app_dir"
exec node server.mjs
