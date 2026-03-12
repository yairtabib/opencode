#!/bin/bash
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$HOME/.opencode/bin"

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     OpenCode — Production Setup      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 1. bun
if command -v bun &>/dev/null; then
  echo "✓ bun $(bun --version)"
else
  echo "→ Installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    echo "✗ bun install failed. See https://bun.sh"
    exit 1
  fi
  echo "✓ bun $(bun --version) installed"
fi

# 2. uv (for Python MCPs)
if command -v uvx &>/dev/null; then
  echo "✓ uv $(uv --version 2>/dev/null)"
else
  echo "→ Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v uvx &>/dev/null; then
    echo "✗ uv install failed. See https://docs.astral.sh/uv"
    exit 1
  fi
  echo "✓ uv $(uv --version 2>/dev/null) installed"
fi

# 3. Node/npx (for context7 MCP)
if command -v npx &>/dev/null; then
  echo "✓ npx (node $(node --version 2>/dev/null))"
else
  echo "⚠ npx not found — context7 MCP will not work."
  echo "  Install Node.js: https://nodejs.org"
fi

# 4. SSH key check (for private MCPs)
if ssh -T git@github.com 2>&1 | grep -q "successfully authenticated"; then
  echo "✓ GitHub SSH access"
else
  echo "⚠ GitHub SSH not configured — private MCPs"
  echo "  (koala-mcp, shell-mcp, jenkins-mcp) will"
  echo "  fail to install. See:"
  echo "  https://docs.github.com/en/authentication/connecting-to-github-with-ssh"
fi

echo ""

# 5. Dependencies
echo "→ Installing dependencies..."
bun install --cwd "$REPO_DIR"
echo "✓ Dependencies installed"

echo ""

# 6. Build production binary
echo "→ Building opencode binary..."
bun run --cwd "$REPO_DIR/packages/opencode" script/build.ts --single
echo "✓ Binary built"

# 7. Install binary to ~/.opencode/bin
mkdir -p "$INSTALL_DIR"

# Detect platform for the correct dist directory
RAW_OS=$(uname -s)
case "$RAW_OS" in
  Darwin*) BUILD_OS="darwin" ;;
  Linux*)  BUILD_OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) BUILD_OS="windows" ;;
  *) echo "✗ Unsupported OS: $RAW_OS"; exit 1 ;;
esac

RAW_ARCH=$(uname -m)
case "$RAW_ARCH" in
  aarch64|arm64) BUILD_ARCH="arm64" ;;
  x86_64)        BUILD_ARCH="x64" ;;
  *) echo "✗ Unsupported arch: $RAW_ARCH"; exit 1 ;;
esac

DIST_DIR="$REPO_DIR/packages/opencode/dist/opencode-${BUILD_OS}-${BUILD_ARCH}/bin"

if [ ! -f "$DIST_DIR/opencode" ]; then
  echo "✗ Build artifact not found at $DIST_DIR/opencode"
  exit 1
fi

cp "$DIST_DIR/opencode" "$INSTALL_DIR/opencode"
chmod 755 "$INSTALL_DIR/opencode"
echo "✓ Installed to $INSTALL_DIR/opencode"

# 8. Add to PATH if not already there
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  export PATH="$INSTALL_DIR:$PATH"

  SHELL_NAME=$(basename "$SHELL")
  case "$SHELL_NAME" in
    zsh)
      RC_FILE="${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    bash)
      RC_FILE="$HOME/.bashrc"
      [ ! -f "$RC_FILE" ] && RC_FILE="$HOME/.bash_profile"
      ;;
    fish)
      RC_FILE="$HOME/.config/fish/config.fish"
      ;;
    *)
      RC_FILE="$HOME/.profile"
      ;;
  esac

  PATH_LINE="export PATH=$INSTALL_DIR:\$PATH"
  if [ "$SHELL_NAME" = "fish" ]; then
    PATH_LINE="fish_add_path $INSTALL_DIR"
  fi

  if [ -f "$RC_FILE" ] && ! grep -Fq "$INSTALL_DIR" "$RC_FILE" 2>/dev/null; then
    echo "" >> "$RC_FILE"
    echo "# opencode" >> "$RC_FILE"
    echo "$PATH_LINE" >> "$RC_FILE"
    echo "✓ Added $INSTALL_DIR to PATH in $RC_FILE"
  elif [ ! -f "$RC_FILE" ]; then
    echo "⚠ Add to PATH manually: $PATH_LINE"
  else
    echo "✓ $INSTALL_DIR already in $RC_FILE"
  fi
fi

echo ""

# 9. GitHub Copilot auth
AUTH_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"

if [ -f "$AUTH_FILE" ] && grep -q "github-copilot" "$AUTH_FILE" 2>/dev/null; then
  echo "✓ GitHub Copilot authenticated"
else
  echo "─────────────────────────────────────"
  echo "GitHub Copilot authentication required"
  echo "You need a GitHub account with an"
  echo "active Copilot subscription."
  echo "─────────────────────────────────────"
  echo ""
  "$INSTALL_DIR/opencode" auth login
fi

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         ✓ Setup complete!            ║"
echo "║                                      ║"
echo "║   Run:  opencode                     ║"
echo "╚══════════════════════════════════════╝"
echo ""
