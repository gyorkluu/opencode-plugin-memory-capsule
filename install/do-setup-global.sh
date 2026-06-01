#!/bin/bash
set -e

PLUGIN_SRC="/Users/gyork/Documents/workspace/opencode-plugin-memory-capsule"
OPENCODE_CONFIG="$HOME/.config/opencode"
OPENCODE_PLUGINS="$OPENCODE_CONFIG/plugins"

echo "🚀 配置记忆胶囊 (Memory Capsule) 全局安装..."
echo ""

# ==========================================
# 1. 清理旧插件
# ==========================================
echo "📦 [1/5] 清理旧插件..."

if [ -f "$OPENCODE_PLUGINS/2ndmemory.js" ]; then
  rm "$OPENCODE_PLUGINS/2ndmemory.js"
  echo "  ✅ Removed old 2ndmemory.js"
fi

if [ -d "$OPENCODE_PLUGINS/2ndmemory-dist" ]; then
  rm -rf "$OPENCODE_PLUGINS/2ndmemory-dist"
  echo "  ✅ Removed old 2ndmemory-dist/"
fi

if [ -d "$OPENCODE_PLUGINS/memory-capsule" ]; then
  rm -rf "$OPENCODE_PLUGINS/memory-capsule"
  echo "  ✅ Removed old memory-capsule/"
fi

if [ -f "$OPENCODE_PLUGINS/memory-capsule.js" ]; then
  rm "$OPENCODE_PLUGINS/memory-capsule.js"
  echo "  ✅ Removed old memory-capsule.js"
fi

echo "  ✅ Old plugins cleaned"

# ==========================================
# 2. 安装插件文件
# ==========================================
echo ""
echo "📦 [2/5] 安装插件文件..."

mkdir -p "$OPENCODE_PLUGINS/memory-capsule"
cp -r "$PLUGIN_SRC/dist/"* "$OPENCODE_PLUGINS/memory-capsule/"
echo "  ✅ Dist → $OPENCODE_PLUGINS/memory-capsule/"

cat > "$OPENCODE_PLUGINS/memory-capsule.js" << 'ENTRY'
export { MemoryCapsulePlugin } from "./memory-capsule/index.js";
ENTRY
echo "  ✅ Entry → $OPENCODE_PLUGINS/memory-capsule.js"

# ==========================================
# 3. 更新全局 package.json（添加依赖）
# ==========================================
echo ""
echo "📦 [3/5] 更新全局依赖..."

cat > "$OPENCODE_CONFIG/package.json" << 'PKGJSON'
{
  "dependencies": {
    "@opencode-ai/plugin": "1.15.7",
    "@opencode-ai/sdk": "^1.15.7",
    "onnxruntime-web": "^1.26.0",
    "glob": "^13.0.6",
    "minimatch": "^10.2.5",
    "zod": "^4.1.8"
  },
  "pnpm": {
    "overrides": {
      "onnxruntime-node": "npm:empty-npm-package@1.0.0"
    }
  }
}
PKGJSON
echo "  ✅ package.json updated"

# ==========================================
# 4. 安装依赖
# ==========================================
echo ""
echo "📦 [4/5] 安装依赖..."

cd "$OPENCODE_CONFIG"
if command -v bun &> /dev/null; then
  bun install 2>&1 | tail -3
  echo "  ✅ Dependencies installed with bun"
elif command -v pnpm &> /dev/null; then
  pnpm install 2>&1 | tail -3
  echo "  ✅ Dependencies installed with pnpm"
else
  npm install 2>&1 | tail -3
  echo "  ✅ Dependencies installed with npm"
fi

# ==========================================
# 5. 更新全局 opencode.json
# ==========================================
echo ""
echo "📦 [5/5] 更新全局 opencode.json..."

OPENCODE_JSON="$OPENCODE_CONFIG/opencode.json"

if [ -f "$OPENCODE_JSON" ]; then
  node -e "
const fs = require('fs');
const config = JSON.parse(fs.readFileSync('$OPENCODE_JSON', 'utf-8'));

delete config.provider['minimax-cn'];

config.provider['minimax'] = {
  models: { 'MiniMax-M2.7': { name: 'MiniMax M2.7' } },
  name: 'MiniMax',
  npm: '@ai-sdk/anthropic',
  options: {
    apiKey: 'sk-cp-PUb2fuIighiYj6QbcSAlarvvONH2OfHtNwmA_PWKNby3UktjH-TKBrTWEAklypU3LGySKv0yw9n53WTGmnkQDxtmYoXw9V7zPtzadWbYxL6TsgU0173B2w0',
    baseURL: 'https://api.minimaxi.com/anthropic/v1'
  }
};

config.model = 'opencode/minimax-m3';

fs.writeFileSync('$OPENCODE_JSON', JSON.stringify(config, null, 2) + '\n');
console.log('  ✅ opencode.json updated: added minimax provider, removed minimax-cn');
" 2>&1
else
  echo "  ⚠️  opencode.json not found, skipping"
fi

# ==========================================
# 完成
# ==========================================
echo ""
echo "=========================================="
echo "🎉 全局安装完成！"
echo "=========================================="
echo ""
echo "📁 全局插件目录: $OPENCODE_PLUGINS/"
echo "   ├── memory-capsule.js        (入口)"
echo "   └── memory-capsule/           (编译产物)"
echo ""
echo "🔧 全局配置: $OPENCODE_CONFIG/opencode.json"
echo "   ├── provider.minimax          (MiniMax M2.7)"
echo "   └── model: opencode/minimax-m3"
echo ""
echo "📋 环境变量（可选，用于 LLM 胶囊合成）:"
echo "   export CAPSULE_LLM_API_KEY=your-api-key"
