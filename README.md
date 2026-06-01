# 记忆胶囊插件 2.0 (opencode-plugin-memory-capsule)

`opencode-plugin-memory-capsule` 是为 OpenCode 设计的高性能、低消耗、面向团队协作的**场景感知记忆结晶插件**（Memory Capsule 2.0）。

它针对开发助理在面对长对话时，因上下文超出 Token 限制被系统自动截断压缩，导致核心技术共识、定制架构规范和关键决策丢失的痛点而设计。通过将对话历史（情境记忆）结晶为不可违反的规则（语义记忆），并支持双向 Git 同步，让 AI 的经验在开发团队中沉淀为长期可复用的资产。

---

## 💻 核心机制与架构

本插件基于 **情境到语义结晶（Episodic-to-Semantic Memory Crystallization）** 架构设计，采用全本地轻量级计算，不需要任何云端第三方向量数据库：

```mermaid
graph TD
    A[用户输入/文件变更] --> B[自动提取 Runtime Context]
    B --> C[情境语义检索 Layer1: 静态触发器过滤]
    C --> D[情境语义检索 Layer2: 场景余弦相似度计算]
    D -->|匹配成功| E[召回相关规则并注入 System Prompt]
    
    F[对话触发压缩/会话闲置] --> G[调用 LLM 蒸馏提取技术铁律]
    G --> H{置信度评估 & 场景/铁律提炼}
    H -->|生成稳定 MD5 ID| I[(SQLite 胶囊数据库)]
    I -->|自动导出| J[项目根目录 .opencode/KNOWLEDGE-BASE.md]
    J -->|手动修改/Git Pull| K[文件监控事件 file.watcher.updated]
    K -->|自动解析与 GC| I
```

1. **场景驱动的精准向量检索（Scenario-Driven Matching）**：
   * **向量情境化**：向量数据库存储的是胶囊**适用场景（Scenario）**的 Embedding（而非直接对代码约束进行计算）。
   * **前瞻性召回**：当用户输入“*我要写一个 React 异步请求*”时，即使还没开始打字，引擎也会自动语义召回契合该场景的 React 卸载/闭包清理规则，并将其以标准格式注入 Prompt。

2. **双向 Codebase Markdown 同步（Bidirectional Git-Sync）**：
   * **Markdown 落地**：SQLite 数据库中的全部记忆自动以极佳的可读性导出到当前项目工作区的 `.opencode/KNOWLEDGE-BASE.md` 文件中。团队成员可以直接提交并推送到 Git，实现**团队共建、版本可控的 AI 记忆库**。
   * **反向注入与同步**：OpenCode 启动或文件变化时，插件会自动解析 `KNOWLEDGE-BASE.md`。如果开发者手动修改了场景、规则或者删除了某条胶囊，修改将自动同步回 SQLite 数据库，并重算向量。
   * **稳定 ID 映射**：基于标题哈希（`md5(title)`）计算出稳定 ID，保证在 Markdown 中增删改时，SQLite 的同步安全、冲突自由且具备无缝的垃圾回收（GC）能力。

3. **安全扫描保护（Security & Deep Scan Protection）**：
   * **Gitignore 智能过滤**：自动利用 `git check-ignore` 工具，在目录扫描和文件更新监听中跳过任何命中的私有依赖和临时编译文件。
   * **主目录防穿透保护**：在 Home 目录（`~`）或根目录（`/`）下调起 OpenCode 时，自动将深度递归检索（`**/`）降级为根目录下单层检索（`./`），确保不会全盘扫描用户电脑，兼顾隐私和性能。

4. **高度可观测的持久化日志**：
   * 所有胶囊结晶过程、向量计算、同步与 GC 动作均会附加 ISO 时间戳输出到本地的 `~/.config/opencode/plugins/memory-capsule/logs/plugin.log` 中。

---

## ⚙️ 插件配置参数

在 OpenCode 的 `opencode.json` 的 `plugin` 选项，或插件配置面板中可调整以下行为：

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `matchThreshold` | `number` | `0.55` | 向量精匹配召回相似度阈值。 |
| `redundancyThreshold` | `number` | `0.88` | 胶囊去重冗余阈值。相似度高于此值的结晶会被判定为 redundant 而不予重复存入。 |
| `topK` | `number` | `5` | 单词对话中最大可匹配注入的胶囊数量。 |
| `knowledgePatterns` | `array` | `['**/KNOWLEDGE-*.md', '**/CAPSULE-*.md', '**/ARCHITECTURE.md', '**/DECISIONS.md']` | 触发知识文件构建的 Glob 模式。 |
| `useLocalDatabase` | `boolean` | `false` | 是否使用本地工作区存储 SQLite（即放在 `.opencode/capsule.db`）。默认 `false`，存储在 `~/.config/opencode` 下的集中式目录，按工作区 MD5 隔离，避免弄脏项目代码。 |
| `enableAutoDistill` | `boolean` | `false` | 会话闲置（session.idle）时是否允许在后台自动调用大模型提炼胶囊。默认关闭以防过度消耗 Token 额度。 |

---

## 🚀 安装方法

### 方式 1：使用配置文件声明安装（推荐所有用户）

由于此插件的代码托管在 GitHub 公开仓库，任何人都可以直接在配置文件中引用安装，无需配置 SSH Key 权限：

1. **配置依赖包文件 (`package.json`)**：
   如果你想在全局加载该插件，编辑 `~/.config/opencode/package.json`；如果只想在单个项目里加载，编辑当前项目工作区根目录的 `.opencode/package.json`：
   ```json
   {
     "dependencies": {
       "opencode-plugin-memory-capsule": "git+https://github.com/gyorkluu/opencode-plugin-memory-capsule.git"
     }
   }
   ```

2. **在配置文件中声明启用 (`opencode.json`)**：
   对应地，编辑全局的 `~/.config/opencode/opencode.json` 或项目级的 `.opencode/opencode.json`：
   ```json
   {
     "plugin": [
       "opencode-plugin-memory-capsule"
     ]
   }
   ```

3. **重新安装**：
   运行命令让依赖就绪，或者直接重启 OpenCode：
   ```bash
   # 全局安装时
   cd ~/.config/opencode && bun install

   # 项目级安装时
   cd .opencode && bun install
   ```

---

### 方式 2：本地克隆开发加载（开发者适用）

1. 将本仓库克隆至你的全局插件或项目插件目录：
   ```bash
   git clone git@github.com:gyorkluu/opencode-plugin-memory-capsule.git ~/.config/opencode/plugins/memory-capsule
   ```
2. 安装依赖并完成编译：
   ```bash
   cd ~/.config/opencode/plugins/memory-capsule
   bun install
   bun x tsc
   ```
3. 在 `~/.config/opencode/plugins/` 下创建一个名为 `memory-capsule.js` 的文件，写入以下入口代码：
   ```javascript
   export { MemoryCapsulePlugin } from "./memory-capsule/dist/index.js";
   ```

---

## 🧪 测试与验证方法

使用内置的集成测试验证 2.0 功能：
```bash
# 运行单元测试与集成同步测试
bun test
```
测试会覆盖：
1. **情境匹配测试**：验证 Query 语义特征能够通过 `scenario` 正确匹配出 Vue Watch/Docker 容器构建等对应规则。
2. **Markdown 导出与载入**：验证 SQLite $\rightarrow$ Markdown $\rightarrow$ SQLite 擦除 $\rightarrow$ 从 Markdown 完全复原的精准逻辑。
3. **协同修改与 GC**：模拟在 Markdown 中修改版本、增加/删除规则，并验证 SQLite 中对应的胶囊被更新或正确执行垃圾回收清空。
