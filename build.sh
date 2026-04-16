#!/bin/bash
# Local build script — uses the project-local Node.js in tools/node/
# Usage: bash build.sh [--watch]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_DIR="$SCRIPT_DIR/tools/node"

if [ ! -f "$NODE_DIR/node.exe" ]; then
  echo "Error: Node.js not found at $NODE_DIR/node.exe"
  exit 1
fi

export PATH="$NODE_DIR:$PATH"

if [ "$1" = "--watch" ]; then
  "$NODE_DIR/node.exe" "$NODE_DIR/node_modules/npm/bin/npm-cli.js" run dev
else
  "$NODE_DIR/node.exe" "$NODE_DIR/node_modules/npm/bin/npm-cli.js" run build
fi
