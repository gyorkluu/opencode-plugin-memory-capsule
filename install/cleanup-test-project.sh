#!/bin/bash
set -e

TEST_PROJECT="/Users/gyork/Documents/workspace/opencode-memory-capsule-test"

echo "🧹 清理测试项目，改为使用全局配置..."
echo ""

# ==========================================
# 1. 删除项目级插件
# ==========================================
echo "📦 [1/3] 删除项目级插件..."

if [ -d "$TEST_PROJECT/.opencode/plugins" ]; then
  rm -rf "$TEST_PROJECT/.opencode/plugins"
  echo "  ✅ Removed .opencode/plugins/"
fi

# 删除旧的 symlink（如果存在）
if [ -L "$TEST_PROJECT/.opencode/plugins/2ndmemory-dist" ]; then
  rm "$TEST_PROJECT/.opencode/plugins/2ndmemory-dist"
  echo "  ✅ Removed 2ndmemory-dist symlink"
fi

# ==========================================
# 2. 更新项目 opencode.json（移除 provider 配置，使用全局）
# ==========================================
echo ""
echo "📦 [2/3] 更新项目 opencode.json..."

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
echo "📦 [3/3] 清理旧数据库..."

if [ -f "$TEST_PROJECT/.opencode/capsule.db" ]; then
  rm -f "$TEST_PROJECT/.opencode/capsule.db" \
        "$TEST_PROJECT/.opencode/capsule.db-shm" \
        "$TEST_PROJECT/.opencode/capsule.db-wal"
  echo "  ✅ Removed old capsule.db"
fi

# ==========================================
# 完成
# ==========================================
echo ""
echo "=========================================="
echo "🎉 测试项目清理完成！"
echo "=========================================="
echo ""
echo "📁 项目结构:"
echo "   $TEST_PROJECT/"
echo "   ├── opencode.json          (精简配置，使用全局 provider)"
echo "   └── .opencode/             (空目录，插件从全局加载)"
echo ""
echo "✅ 插件和 provider 配置全部来自全局:"
echo "   ~/.config/opencode/plugins/memory-capsule.js"
echo "   ~/.config/opencode/opencode.json (minimax provider)"
