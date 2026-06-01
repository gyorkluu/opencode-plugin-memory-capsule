import { CapsuleEngine } from '../src/CapsuleEngine.js';
import { CapsulePluginConfigSchema, CognitiveCapsule } from '../src/types.js';
import { chunkDocument, estimateTokenCount } from '../src/Chunker.js';
import * as LocalEmbedding from '../src/LocalEmbeddingService.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const config = CapsulePluginConfigSchema.parse({});
const TEST_DB_DIR = '/tmp/capsule-test-' + Date.now();
fs.mkdirSync(TEST_DB_DIR, { recursive: true });

const engine = new CapsuleEngine(config, TEST_DB_DIR);

let passed = 0;
let failed = 0;

const assert = (condition: boolean, testName: string) => {
  if (condition) {
    passed++;
    console.log(`  ✅ PASS: ${testName}`);
  } else {
    failed++;
    console.log(`  ❌ FAIL: ${testName}`);
  }
};

const KNOWLEDGE_DOCS: Record<string, string> = {
  'KNOWLEDGE-OPENCODE.md': `# OpenCode 插件系统

## 核心架构
OpenCode 插件系统基于事件驱动架构。插件通过钩子函数订阅事件，在事件触发时执行自定义逻辑。

## 插件加载方式
- 项目级: .opencode/plugins/ 目录
- 全局级: ~/.config/opencode/plugins/ 目录
- npm 包: 在 opencode.json 的 plugin 字段声明

## 可用事件钩子
- experimental.chat.system.transform: 每轮 LLM 调用前触发，可注入 system prompt
- session.compacted: 会话压缩后触发
- session.idle: 对话轮次结束后触发
- tool.execute.before: 工具执行前触发
- file.watcher.updated: 文件变更时触发

## 自定义工具
使用 @opencode-ai/plugin 包的 tool 函数注册自定义工具。工具定义包含 description、args 和 execute 三个核心字段。args 使用 Zod schema 定义参数类型。
`,
  'KNOWLEDGE-BUN.md': `# Bun 运行时

## 原生 SQLite 支持
Bun 内置了 SQLite 支持，无需安装额外依赖。使用 import { Database } from 'bun:sqlite' 即可直接使用。

### 基本用法
const db = new Database(':memory:');
const db = new Database('mydb.sqlite');

### WAL 模式
db.exec('PRAGMA journal_mode=WAL');
WAL 模式提供更好的并发性能，适合多读少写场景。

### 预编译语句
const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
const user = stmt.get(1);

### 事务
const insertMany = db.transaction((users) => {
  for (const user of users) {
    stmt.run(user.name, user.email);
  }
});

## Bun 原生 API
- Bun.file(): 高性能文件操作
- Bun.serve(): HTTP 服务器
- Bun.hash(): 哈希计算
`,
  'KNOWLEDGE-HONO.md': `# Hono 框架

## 中间件机制
Hono 中间件使用 app.use() 注册，支持洋葱模型。中间件可以修改请求和响应，也可以提前返回响应。

### 内置中间件
- logger: 请求日志
- cors: 跨域处理
- bearerAuth: Bearer Token 认证
- jwt: JWT 认证
- prettyJSON: JSON 格式化

### 自定义中间件
app.use(async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  c.header('X-Response-Time', ms + 'ms');
});

## 路由系统
Hono 支持多种路由模式：
- app.get('/path', handler)
- app.post('/api/users', handler)
- app.put('/api/users/:id', handler)

## 上下文对象
每个请求处理函数接收 Context 对象 (c)，包含：
- c.req: 请求信息
- c.json(): 返回 JSON 响应
- c.header(): 设置响应头
- c.set() / c.get(): 中间件间共享数据
`,
  'KNOWLEDGE-AIOS.md': `# AIOS 操作系统

## 核心概念
AIOS 是一个面向 AI Agent 的操作系统抽象层。它将 Agent 视为一等公民，提供调度、内存管理、文件系统等核心服务。

## Agent 类型
AIOS 定义了 5 种 Agent 类型：
1. Supervisor Agent: 负责任务分解和调度
2. Worker Agent: 执行具体任务
3. Observer Agent: 监控系统状态
4. Messenger Agent: 跨 Agent 通信
5. Guardian Agent: 安全和权限控制

## 内存管理
AIOS 的内存管理采用分层架构：
- L1: 工作记忆 (Working Memory) - 当前活跃上下文
- L2: 短期记忆 (Short-term Memory) - 会话级缓存
- L3: 长期记忆 (Long-term Memory) - 持久化知识库
`
};

console.log('\n========================================');
console.log('🧪 记忆胶囊 (Memory Capsule) 插件测试');
console.log('========================================\n');

// ========== TEST 1: Local Embedding Model ==========
console.log('--- TEST 1: BAAI/bge-small-zh-v1.5 本地嵌入模型 ---');
try {
  console.log('  ⏳ Loading model...');
  const vec = await LocalEmbedding.embed('测试中文嵌入向量');
  assert(Array.isArray(vec) && vec.length === 512, `向量维度: ${vec.length} (expected 512)`);
  const norm = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
  assert(Math.abs(norm - 1.0) < 0.01, `向量归一化: norm=${norm.toFixed(4)}`);
  console.log(`  📊 dim=${vec.length}, norm=${norm.toFixed(4)}, sample=[${vec.slice(0, 5).map((v: number) => v.toFixed(4)).join(', ')}]`);
} catch (e) {
  assert(false, `本地嵌入模型加载失败: ${e}`);
}

// ========== TEST 2: Document Chunking ==========
console.log('\n--- TEST 2: 文档分块策略 ---');
const testDoc = `# Test Document

## Section 1
${'A'.repeat(2000)}

## Section 2
${'B'.repeat(2000)}

## Section 3
${'C'.repeat(500)}`;

const chunks = chunkDocument(testDoc, 'test:doc', 'test.md');
assert(chunks.length > 1, `分块数量: ${chunks.length} (expected > 1)`);
assert(chunks.every(c => c.id.startsWith('test:doc::chunk_')), `分块 ID 格式正确`);
assert(chunks.every(c => c.sourcePath === 'test.md'), `分块 sourcePath 正确`);
console.log(`  📊 ${chunks.length} chunks, sizes: [${chunks.map(c => c.text.length).join(', ')}]`);

// ========== TEST 3: Token Estimation ==========
console.log('\n--- TEST 3: Token 估算 ---');
const zhTokens = estimateTokenCount('这是一段中文测试文本');
const enTokens = estimateTokenCount('This is an English test text');
assert(zhTokens > 0 && enTokens > 0, `中文=${zhTokens} tokens, 英文=${enTokens} tokens`);
assert(zhTokens > enTokens, `中文 token 估算 > 英文 (CJK 权重 1.5x)`);

// ========== TEST 4: SQLite Persistence ==========
console.log('\n--- TEST 4: SQLite 持久化 ---');
let totalChunks = 0;

for (const [filename, content] of Object.entries(KNOWLEDGE_DOCS)) {
  const sourceId = `knowledge:${filename}`;
  const contentHash = crypto.createHash('md5').update(content).digest('hex');

  engine.registerSource(sourceId, filename, contentHash);
  const docChunks = chunkDocument(content, sourceId, filename);
  engine.loadChunks(docChunks);
  totalChunks += docChunks.length;
  console.log(`  📄 ${filename} → ${docChunks.length} chunks`);
}

assert(engine.getSourceCount() > 0, `知识源数量: ${engine.getSourceCount()}`);
assert(engine.getChunkCount() > 0, `知识块数量: ${engine.getChunkCount()} (total from ${totalChunks} loaded)`);
assert(engine.getUnembeddedCount() > 0, `待嵌入数量: ${engine.getUnembeddedCount()}`);

// ========== TEST 5: Embedding Computation ==========
console.log('\n--- TEST 5: 向量计算与持久化 ---');
const embedFn = async (text: string, isQuery: boolean = false) => LocalEmbedding.embed(text, isQuery);
const computed = await engine.computeAndStoreEmbeddings(embedFn, (msg) => console.log(`  📝 ${msg}`));
assert(computed > 0, `计算了 ${computed} 个向量`);
assert(engine.getUnembeddedCount() === 0, `待嵌入数量: ${engine.getUnembeddedCount()} (expected 0)`);

// ========== TEST 6: Knowledge Routing with 512-dim ==========
console.log('\n--- TEST 6: 512维语义检索 ---');
const testQueries = [
  { query: 'OpenCode 插件系统架构', expected: 'OPENCODE' },
  { query: 'Bun SQLite 原生支持', expected: 'BUN' },
  { query: 'Hono 中间件机制', expected: 'HONO' },
  { query: 'AIOS 操作系统', expected: 'AIOS' },
];

for (const { query, expected } of testQueries) {
  const results = await engine.routeRawKnowledge(query, embedFn, (msg) => {});
  assert(results.length > 0, `查询 "${query}" → ${results.length} 条结果`);
  if (results[0]) {
    const isCorrect = results[0].sourcePath.includes(expected);
    console.log(`  📊 Top: ${results[0].sourcePath} (score=${results[0].score.toFixed(3)}) ${isCorrect ? '✅' : '❌'}`);
  }
}

// ========== TEST 7: Capsule Persistence ==========
console.log('\n--- TEST 7: 胶囊持久化 ---');
const testCapsule: CognitiveCapsule = {
  id: 'test-capsule-sqlite-001',
  title: 'Vue3-Ref-Cleanup-Rule',
  version: '1.0.0',
  scenario: 'Vue 3 component watch cleanup',
  staticTriggers: {
    fileExtensions: ['.vue', '.ts'],
    dependencies: ['vue'],
    astKeywords: ['ref', 'watchEffect']
  },
  semanticDescription: 'Vue3 中 ref 和 watchEffect 必须在组件卸载时清理',
  payload: {
    defectPattern: '组件卸载后 watchEffect 仍在执行',
    invariantConstraint: '所有 watchEffect 和 watch 必须在 onUnmounted 中调用 stop()'
  },
  genealogy: { parentCapsuleIds: [], rootSourceChunkIds: [] },
  createdAt: Date.now()
};

const registered = await engine.verifyAndRegister(testCapsule, embedFn, (msg) => console.log(`  📝 ${msg}`));
assert(registered === true, '胶囊注册成功');
assert(engine.getCapsuleCount() === 1, `胶囊数量: ${engine.getCapsuleCount()}`);

// ========== TEST 8: Cross-session Persistence ==========
console.log('\n--- TEST 8: 跨会话持久化验证 ---');
const engine2 = new CapsuleEngine(config, TEST_DB_DIR);
assert(engine2.getCapsuleCount() === 1, `新引擎实例读取到 ${engine2.getCapsuleCount()} 个胶囊`);
assert(engine2.getChunkCount() > 0, `新引擎实例读取到 ${engine2.getChunkCount()} 个知识块`);
assert(engine2.getUnembeddedCount() === 0, `新引擎实例待嵌入数量: ${engine2.getUnembeddedCount()} (expected 0, vectors persisted)`);
engine2.close();

// ========== TEST 9: Dedup with content hash ==========
console.log('\n--- TEST 9: 内容哈希去重 ---');
const opencodeContent = KNOWLEDGE_DOCS['KNOWLEDGE-OPENCODE.md'];
const sameHash = crypto.createHash('md5').update(opencodeContent).digest('hex');
assert(engine.isSourceLoaded('knowledge:KNOWLEDGE-OPENCODE.md', sameHash), '相同内容哈希被正确识别为已加载');

const wrongHash = '0000000000000000';
assert(!engine.isSourceLoaded('knowledge:KNOWLEDGE-OPENCODE.md', wrongHash), '不同哈希被正确识别为已变更');

// ========== TEST 10: 512维 vs 64维 检索质量对比 ==========
console.log('\n--- TEST 10: 512维检索质量验证 ---');
const qualityQueries = [
  { query: 'Hono 中间件机制', expected: 'HONO' },
  { query: 'Bun SQLite 数据库操作', expected: 'BUN' },
  { query: 'OpenCode 插件事件钩子', expected: 'OPENCODE' },
];

let qualityPassed = 0;
for (const { query, expected } of qualityQueries) {
  const results = await engine.routeRawKnowledge(query, embedFn, (msg) => {});
  const topResult = results[0];
  const isMatch = topResult?.sourcePath?.includes(expected);
  if (isMatch) qualityPassed++;
  console.log(`  📊 "${query}" → ${topResult?.sourcePath} (score=${topResult?.score?.toFixed(3)}) ${isMatch ? '✅' : '❌'}`);
}
assert(qualityPassed >= 2, `检索质量: ${qualityPassed}/${qualityQueries.length} 正确匹配`);

// ========== SUMMARY ==========
console.log('\n========================================');
console.log(`📊 测试结果: ${passed} PASSED / ${failed} FAILED / ${passed + failed} TOTAL`);
console.log('========================================');

console.log(`\n📦 引擎状态:`);
console.log(`  - 知识源: ${engine.getSourceCount()}`);
console.log(`  - 知识块: ${engine.getChunkCount()}`);
console.log(`  - 认知胶囊: ${engine.getCapsuleCount()}`);
console.log(`  - 待嵌入: ${engine.getUnembeddedCount()}`);
console.log(`  - 数据库: ${TEST_DB_DIR}/.opencode/capsule.db`);

engine.close();

process.exit(failed > 0 ? 1 : 0);
