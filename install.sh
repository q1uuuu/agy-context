#!/usr/bin/env bash
# ==============================================================================
# Antigravity Context & Token Inspector (agy-context) Installer for macOS/Linux
# ==============================================================================
set -e

USER_DIR="${HOME}"
TARGET_PLUGIN_DIR="${USER_DIR}/.gemini/config/plugins/agy-context"
LEGACY_SIDECAR_DIR="${USER_DIR}/.gemini/config/sidecars/agy-context"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "================================================================="
echo "  Antigravity Context & Token Inspector (agy-context) Installer  "
echo "================================================================="
echo ""

# 1. Install Plugin Bundle
echo "[1/3] Installing Plugin Bundle..."
if [ "${SCRIPT_DIR}" != "${TARGET_PLUGIN_DIR}" ]; then
  mkdir -p "${TARGET_PLUGIN_DIR}"
  rm -rf "${TARGET_PLUGIN_DIR}/sidecars/context-panel/scripts"
  cp -R "${SCRIPT_DIR}/"* "${TARGET_PLUGIN_DIR}/"
  echo "      [OK] Plugin files installed to: ${TARGET_PLUGIN_DIR}"
else
  rm -rf "${TARGET_PLUGIN_DIR}/sidecars/context-panel/scripts"
  echo "      [OK] Plugin directory is current location (${TARGET_PLUGIN_DIR})"
fi

# 2. Clean Legacy Standalone Sidecar (Avoid duplicate items)
echo "[2/3] Checking for legacy standalone sidecar..."
if [ -d "${LEGACY_SIDECAR_DIR}" ]; then
  rm -rf "${LEGACY_SIDECAR_DIR}"
  echo "      [OK] Cleaned legacy standalone sidecar."
else
  echo "      [OK] No duplicates found."
fi

# 3. Live activation if LS is running
echo "[3/3] Checking Antigravity Language Server status..."
if [ -n "${ANTIGRAVITY_LS_ADDRESS}" ] && [ -n "${ANTIGRAVITY_CSRF_TOKEN}" ]; then
  curl -s -X POST "http://${ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/ManageSidecar" \
    -H "Content-Type: application/json" \
    -H "x-codeium-csrf-token: ${ANTIGRAVITY_CSRF_TOKEN}" \
    -d '{"sidecarId":"agy-context/context-panel","action":"SIDECAR_ACTION_ENABLE"}' > /dev/null 2>&1 || true
  echo "      [OK] Live activation requested via Connect RPC."
else
  echo "      [INFO] Antigravity Language Server will discover and start the sidecar on launch."
fi

echo ""
echo "================================================================="
echo "  Installation Completed Successfully!                           "
echo "================================================================="
echo ""
echo "How to Open:"
echo "  1. Top-right '...' -> 'Extensions >' -> 'Context Usage'"
echo "  2. In-chat link: sidecar://agy-context/context-panel/"
echo "  3. Running in background automatically."
echo ""
