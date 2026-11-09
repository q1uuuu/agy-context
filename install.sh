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

# 1. Environment Pre-flight Check
echo "[1/4] Running Environment Pre-flight Check..."

# 1.1 Check Antigravity host directories & storage
CONV_DIR="${USER_DIR}/.gemini/antigravity/conversations"
if [ -d "${CONV_DIR}" ]; then
  DB_COUNT=$(find "${CONV_DIR}" -name "*.db" 2>/dev/null | wc -l | tr -d ' ')
  echo "      [OK] Antigravity Conversation Storage: ${DB_COUNT} database(s) found"
elif [ -d "${USER_DIR}/.gemini/antigravity" ]; then
  echo "      [INFO] Antigravity Storage: Initialized (conversation databases will appear after first chat)"
else
  echo "      [INFO] Antigravity directory (~/.gemini/antigravity) will be auto-created on launch"
fi

# 1.2 Check SQLite Engine
if command -v sqlite3 >/dev/null 2>&1; then
  SQLITE_VER=$(sqlite3 --version | awk '{print $1}')
  echo "      [OK] System sqlite3 CLI: Found (${SQLITE_VER})"
else
  echo "      [INFO] sqlite3 CLI not found in PATH."
  echo "             Antigravity's embedded node:sqlite will be used as the primary engine."
  echo "             (Optional: If running outside Antigravity, install via 'brew install sqlite' or 'apt install sqlite3')"
fi

# 2. Install Plugin Bundle
echo "[2/4] Installing Plugin Bundle..."
if [ "${SCRIPT_DIR}" != "${TARGET_PLUGIN_DIR}" ]; then
  mkdir -p "${TARGET_PLUGIN_DIR}"
  rm -rf "${TARGET_PLUGIN_DIR}/sidecars/context-panel/scripts"
  cp -R "${SCRIPT_DIR}/"* "${TARGET_PLUGIN_DIR}/"
  echo "      [OK] Plugin files installed to: ${TARGET_PLUGIN_DIR}"
else
  rm -rf "${TARGET_PLUGIN_DIR}/sidecars/context-panel/scripts"
  echo "      [OK] Plugin directory is current location (${TARGET_PLUGIN_DIR})"
fi

# 2.1 Ensure plugin is registered & enabled in ~/.gemini/config/config.json
CFG_PATH="${USER_DIR}/.gemini/config/config.json"
if [ -f "${CFG_PATH}" ]; then
  if command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      try {
        const p = process.argv[1];
        const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
        cfg.plugins = cfg.plugins || {};
        if (!cfg.plugins["agy-context"] || cfg.plugins["agy-context"].enabled !== true) {
          cfg.plugins["agy-context"] = { enabled: true };
          fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
          console.log("      [OK] Registered agy-context in config.json plugins map.");
        } else {
          console.log("      [OK] Plugin agy-context is registered in config.json.");
        }
      } catch (e) {}
    ' "${CFG_PATH}" || true
  fi
fi

# 2. Clean Legacy Standalone Sidecar (Avoid duplicate items)
echo "[3/4] Checking for legacy standalone sidecar..."
if [ -d "${LEGACY_SIDECAR_DIR}" ]; then
  rm -rf "${LEGACY_SIDECAR_DIR}"
  echo "      [OK] Cleaned legacy standalone sidecar."
else
  echo "      [OK] No duplicates found."
fi

# 3. Live activation if LS is running
echo "[4/4] Checking Antigravity Language Server status..."
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
