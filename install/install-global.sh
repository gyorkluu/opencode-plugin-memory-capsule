#!/bin/bash
set -e

PLUGIN_SRC="/Users/gyork/Documents/workspace/opencode-plugin-memory-capsule"
OPENCODE_CONFIG="$HOME/.config/opencode"
OPENCODE_PLUGINS="$OPENCODE_CONFIG/plugins"

echo "🚀 Installing 记忆胶囊 (Memory Capsule) plugin globally..."

# 1. Create plugin directory
mkdir -p "$OPENCODE_PLUGINS/memory-capsule"

# 2. Copy compiled dist files
cp -r "$PLUGIN_SRC/dist/"* "$OPENCODE_PLUGINS/memory-capsule/"
echo "✅ Dist files copied to $OPENCODE_PLUGINS/memory-capsule/"

# 3. Copy entry file
cp "$PLUGIN_SRC/install/memory-capsule.js" "$OPENCODE_PLUGINS/memory-capsule.js"
echo "✅ Entry file copied to $OPENCODE_PLUGINS/memory-capsule.js"

# 4. Setup dependencies (merge with existing package.json if any)
if [ -f "$OPENCODE_CONFIG/package.json" ]; then
  echo "⚠️  Found existing $OPENCODE_CONFIG/package.json"
  echo "   Please manually add these dependencies if not present:"
  echo "   - onnxruntime-web: ^1.26.0"
  echo "   - glob: ^13.0.6"
  echo "   - minimatch: ^10.2.5"
  echo "   - zod: ^4.1.8"
  echo "   And add pnpm.overrides.onnxruntime-node = 'npm:empty-npm-package@1.0.0'"
else
  cp "$PLUGIN_SRC/install/package.json" "$OPENCODE_CONFIG/package.json"
  echo "✅ package.json created at $OPENCODE_CONFIG/package.json"
fi

# 5. Install dependencies
cd "$OPENCODE_CONFIG"
if command -v bun &> /dev/null; then
  bun install
  echo "✅ Dependencies installed with bun"
elif command -v pnpm &> /dev/null; then
  pnpm install
  echo "✅ Dependencies installed with pnpm"
else
  npm install
  echo "✅ Dependencies installed with npm"
fi

# 6. Set environment variables (optional, for LLM capsule synthesis)
echo ""
echo "📋 To enable LLM capsule synthesis, set these environment variables:"
echo "   export CAPSULE_LLM_API_KEY=your-api-key"
echo "   export CAPSULE_LLM_BASE_URL=https://api.minimaxi.com/anthropic  # optional"
echo "   export CAPSULE_LLM_MODEL=MiniMax-M2.7  # optional"
echo ""
echo "🎉 Installation complete! The plugin will be loaded on next OpenCode startup."
echo "   Global plugin directory: $OPENCODE_PLUGINS/"
echo "   Plugin entry: $OPENCODE_PLUGINS/memory-capsule.js"
echo "   Dist files: $OPENCODE_PLUGINS/memory-capsule/"
