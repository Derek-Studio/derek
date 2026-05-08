#!/usr/bin/env bash
# Safe deploy with automatic rollback if the new version fails to start.
#
# Flow:
#   1. Back up current dist/ → dist.bak/
#   2. Build
#   3. Restart service
#   4. Health check: service must start and stay active for HEALTH_SECS
#   5. If it crashes: restore dist.bak/, restart old version, exit non-zero
#
# Auto-detects which systemd service to target based on the repo path.
# Override with: SERVICE=derek-dev-discord ./scripts/safe-deploy.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Auto-detect service from worktree path, allow env override
if [[ -z "${SERVICE:-}" ]]; then
    case "$REPO_DIR" in
        */derek-dev) SERVICE="derek-dev-discord" ;;
        *)           SERVICE="derek-discord" ;;
    esac
fi

DIST_DIR="$REPO_DIR/dist"
BACKUP_DIR="$REPO_DIR/dist.bak"
HEALTH_SECS=15

log()  { echo "[deploy] $*"; }
fail() { log "FAILED: $*" >&2; exit 1; }

rollback() {
    log "Rolling back to previous version..."
    if [[ ! -d "$BACKUP_DIR" ]]; then
        fail "No backup found — check journalctl -u $SERVICE -n 50 for details"
    fi
    rm -rf "$DIST_DIR"
    mv "$BACKUP_DIR" "$DIST_DIR"
    systemctl restart "$SERVICE"
    sleep 5
    if systemctl is-active --quiet "$SERVICE"; then
        log "✓ Rollback successful — previous version is running"
    else
        fail "Rollback also failed — manual intervention needed. Check: journalctl -u $SERVICE -n 50"
    fi
}

# --- backup ---
if [[ -d "$DIST_DIR" ]]; then
    log "Backing up dist/ → dist.bak/"
    rm -rf "$BACKUP_DIR"
    cp -r "$DIST_DIR" "$BACKUP_DIR"
fi

# --- build ---
log "Building..."
cd "$REPO_DIR"
if ! pnpm run build; then
    log "Build failed — service unchanged, removing backup"
    rm -rf "$BACKUP_DIR"
    fail "Build failed. Fix errors above and try again."
fi

# --- restart ---
log "Restarting $SERVICE..."
systemctl restart "$SERVICE"

# --- health check phase 1: wait for service to become active ---
log "Waiting for service to start (up to 30s)..."
started=false
for i in $(seq 1 30); do
    if systemctl is-active --quiet "$SERVICE"; then
        started=true
        break
    fi
    sleep 1
done

if [[ "$started" != "true" ]]; then
    rollback
    fail "Service did not start within 30s. Rolled back to previous version."
fi

# --- health check phase 2: confirm stable for HEALTH_SECS ---
log "Service started — confirming stability for ${HEALTH_SECS}s..."
for i in $(seq 1 $HEALTH_SECS); do
    sleep 1
    if ! systemctl is-active --quiet "$SERVICE"; then
        log "Service crashed after ${i}s"
        rollback
        fail "New version crashed. Rolled back to previous version."
    fi
done

# --- success ---
rm -rf "$BACKUP_DIR"
log "✓ $SERVICE healthy — deploy complete"
