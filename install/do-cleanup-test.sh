#!/bin/bash
set -e

TEST_PROJECT="/Users/gyork/Documents/workspace/opencode-2ndmemory-test"
NEW_NAME="/Users/gyork/Documents/workspace/opencode-memory-capsule-test"

echo "🧹 清理测试项目，改为使用全局配置..."
echo ""

# ==========================================
# 1. 删除项目级插件
# ==========================================
echo "📦 [1/4] 删除项目级插件..."

if [ -d "$TEST_PROJECT/.opencode/plugins" ]; then
  rm -rf "$TEST_PROJECT/.opencode/plugins"
  echo "  ✅ Removed .opencode/plugins/"
fi

# ==========================================
# 2. 更新项目 opencode.json
# ==========================================
echo ""
echo "📦 [2/4] 更新项目 opencode.json..."

cat > "$TEST_PROJECT/opencode.json" << 'OPENCODE_JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 10000
  }
}
OPENCODE_JSON
echo "  ✅ opencode.json simplified (provider/model from global config)"

# ==========================================
# 3. 清理旧的 SQLite 数据库
# ==========================================
echo ""
echo "📦 [3/4] 清理旧数据库..."

if [ -f "$TEST_PROJECT/.opencode/capsule.db" ]; then
  rm -f "$TEST_PROJECT/.opencode/capsule.db" \
        "$TEST_PROJECT/.opencode/capsule.db-shm" \
        "$TEST_PROJECT/.opencode/capsule.db-wal"
  echo "  ✅ Removed old capsule.db"
fi

# ==========================================
# 4. 重命名测试项目目录
# ==========================================
echo ""
echo "📦 [4/4] 重命名测试项目目录..."

if [ -d "$TEST_PROJECT" ]; then
  mv "$TEST_PROJECT" "$NEW_NAME"
  echo "  ✅ Renamed: opencode-2ndmemory-test → opencode-memory-capsule-test"
else
  echo "  ⚠️  Directory not found: $TEST_PROJECT"
fi

# ==========================================
# 完成
# ==========================================
echo ""
echo "=========================================="
echo "🎉 测试项目清理完成！"
echo "=========================================="
echo ""
echo "📁 项目目录: $NEW_NAME/"
echo "   ├── opencode.json          (精简配置，使用全局 provider)"
echo "   └── .opencode/             (空目录，插件从全局加载)"
echo ""
echo "✅ 插件和 provider 配置全部来自全局:"
echo "   ~/.config/opencode/plugins/memory-capsule.js"
echo "   ~/.config/opencode/opencode.json (minimax provider)"
