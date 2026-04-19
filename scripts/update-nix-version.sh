#!/usr/bin/env bash
# Update Nix package version and hashes for a new release
# Usage: ./scripts/update-nix-version.sh <version>
# Example: ./scripts/update-nix-version.sh 1.15.0

set -e

VERSION=$1
SKIP_VERIFY=$2
NIX_FILE="nix/packages/default/default.nix"
FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

if [ -z "$VERSION" ]; then
  echo -e "${RED}Error: Version number required${NC}"
  echo "Usage: $0 <version> [--skip-verify]"
  echo "Example: $0 1.15.0"
  echo "Example: $0 1.15.0 --skip-verify"
  exit 1
fi

echo -e "${YELLOW}Updating Nix package to version ${VERSION}...${NC}"
echo ""

# Step 1: Update version in nix file
echo "Step 1: Updating version number in ${NIX_FILE}..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|version = \".*\";|version = \"${VERSION}\";|" "$NIX_FILE"
else
  sed -i "s|version = \".*\";|version = \"${VERSION}\";|" "$NIX_FILE"
fi

# Step 2: Insert fake source hash
echo "Step 2: Using fake source hash to trigger hash calculation..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|sha256 = \".*\";|sha256 = \"${FAKE_HASH}\";|" "$NIX_FILE"
else
  sed -i "s|sha256 = \".*\";|sha256 = \"${FAKE_HASH}\";|" "$NIX_FILE"
fi

# Step 3: Build to get the real source hash
echo "Step 3: Building package to get correct source hash..."
echo -e "${YELLOW}(This will fail - that's expected!)${NC}"
echo ""

BUILD_OUTPUT=$(nix build .#default 2>&1 || true)
SOURCE_HASH=$(echo "$BUILD_OUTPUT" | sed -n 's/.*got:[[:space:]]*\(sha256-[A-Za-z0-9+/=]*\).*/\1/p' | head -1)

if [ -z "$SOURCE_HASH" ]; then
  echo -e "${RED}Error: Could not extract source hash from build output${NC}"
  echo "Build output:"
  echo "$BUILD_OUTPUT"
  exit 1
fi

echo -e "${GREEN}Found source hash: ${SOURCE_HASH}${NC}"
echo ""

# Step 4: Update with real source hash
echo "Step 4: Updating with correct source hash..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|sha256 = \".*\";|sha256 = \"${SOURCE_HASH}\";|" "$NIX_FILE"
else
  sed -i "s|sha256 = \".*\";|sha256 = \"${SOURCE_HASH}\";|" "$NIX_FILE"
fi

# Step 5: Insert fake pnpmDeps hash
echo "Step 5: Using fake pnpmDeps hash to trigger hash calculation..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|hash = \".*\";|hash = \"${FAKE_HASH}\";|" "$NIX_FILE"
else
  sed -i "s|hash = \".*\";|hash = \"${FAKE_HASH}\";|" "$NIX_FILE"
fi

# Step 6: Build to get the real pnpmDeps hash
echo "Step 6: Building package to get correct pnpmDeps hash..."
echo -e "${YELLOW}(This will fail - that's expected!)${NC}"
echo ""

BUILD_OUTPUT=$(nix build .#default 2>&1 || true)
PNPM_HASH=$(echo "$BUILD_OUTPUT" | sed -n 's/.*got:[[:space:]]*\(sha256-[A-Za-z0-9+/=]*\).*/\1/p' | head -1)

if [ -z "$PNPM_HASH" ]; then
  echo -e "${RED}Error: Could not extract pnpmDeps hash from build output${NC}"
  echo "Build output:"
  echo "$BUILD_OUTPUT"
  exit 1
fi

echo -e "${GREEN}Found pnpmDeps hash: ${PNPM_HASH}${NC}"
echo ""

# Step 7: Update with real pnpmDeps hash
echo "Step 7: Updating with correct pnpmDeps hash..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|hash = \".*\";|hash = \"${PNPM_HASH}\";|" "$NIX_FILE"
else
  sed -i "s|hash = \".*\";|hash = \"${PNPM_HASH}\";|" "$NIX_FILE"
fi

# Step 8: Build again to verify (unless --skip-verify is passed)
if [ "$SKIP_VERIFY" = "--skip-verify" ]; then
  echo "Step 8: Skipping verification build (--skip-verify flag passed)"
  echo ""
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}Success! Nix package updated to v${VERSION}${NC}"
  echo -e "${GREEN}════════════════════════════════════════════════${NC}"
  echo ""
  echo "Changes made to: ${NIX_FILE}"
  echo ""
  echo "Source hash: ${SOURCE_HASH}"
  echo "pnpmDeps hash: ${PNPM_HASH}"
  echo ""
  echo -e "${YELLOW}Note: Verification build was skipped. Run 'nix build .#default' locally to verify.${NC}"
else
  echo "Step 8: Verifying build with correct hashes..."
  if nix build .#default; then
    echo -e "${GREEN}✓ Build successful!${NC}"
    echo ""

    # Test the binary exists
    echo "Step 9: Verifying binary exists..."
    if [ -f "./result/bin/nanocoder" ] && [ -x "./result/bin/nanocoder" ]; then
      echo -e "${GREEN}✓ Binary exists and is executable!${NC}"
    else
      echo -e "${YELLOW}⚠ Warning: Binary not found or not executable${NC}"
    fi

    # Clean up
    rm -f result

    echo ""
    echo -e "${GREEN}════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}Success! Nix package updated to v${VERSION}${NC}"
    echo -e "${GREEN}════════════════════════════════════════════════${NC}"
    echo ""
    echo "Changes made to: ${NIX_FILE}"
    echo ""
    echo "Source hash: ${SOURCE_HASH}"
    echo "pnpmDeps hash: ${PNPM_HASH}"
    echo ""
    echo "Next steps:"
    echo "  1. Review the changes: git diff ${NIX_FILE}"
    echo "  2. Commit: git add ${NIX_FILE}"
    echo "  3. Commit: git commit -m 'chore: update nix package to v${VERSION}'"
    echo "  4. Push: git push"
  else
    echo -e "${RED}✗ Build failed with correct hashes${NC}"
    echo "Please check the build output above for errors."
    exit 1
  fi
fi
