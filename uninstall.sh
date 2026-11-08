#!/usr/bin/env bash
# ==============================================================================
# Antigravity Context & Token Inspector (agy-context) Uninstaller for macOS/Linux
# ==============================================================================

USER_DIR="${HOME}"
TARGET_PLUGIN_DIR="${USER_DIR}/.gemini/config/plugins/agy-context"
TARGET_SIDECAR_DIR="${USER_DIR}/.gemini/config/sidecars/agy-context"
TARGET_SIDECAR_DATA="${USER_DIR}/.gemini/antigravity/sidecar_data"

echo "================================================================="
echo "  Antigravity Context Inspector (agy-context) Uninstaller        "
echo "================================================================="
echo ""

# 1. Stop Sidecar via Language Server RPC if running
echo "[1/3] Stopping background sidecar daemon..."
if [ -n "${ANTIGRAVITY_LS_ADDRESS}" ] && [ -n "${ANTIGRAVITY_CSRF_TOKEN}" ]; then
  for sid in "agy-context/context-panel" "agy-context"; do
    curl -s -X POST "http://${ANTIGRAVITY_LS_ADDRESS}/exa.language_server_pb.LanguageServerService/ManageSidecar" \
      -H "Content-Type: application/json" \
      -H "x-codeium-csrf-token: ${ANTIGRAVITY_CSRF_TOKEN}" \
      -d "{\"sidecarId\":\"${sid}\",\"action\":\"SIDECAR_ACTION_DISABLE\"}" > /dev/null 2>&1 || true
  done
  echo "      [OK] Sidecar stopped."
fi

# 2. Remove directories
echo "[2/3] Removing plugin and sidecar files..."
rm -rf "${TARGET_PLUGIN_DIR}"
rm -rf "${TARGET_SIDECAR_DIR}"
rm -rf "${TARGET_SIDECAR_DATA}/agy-context"
rm -rf "${TARGET_SIDECAR_DATA}/agy-context_context-panel"
echo "      [OK] Removed plugin and sidecar directories."

echo ""
echo "================================================================="
echo "  Uninstallation Complete!                                       "
echo "================================================================="
echo ""
