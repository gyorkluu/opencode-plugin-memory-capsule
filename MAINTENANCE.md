# Maintenance Notes

> 面向维护这个插件的工程师。本文解释 **为什么** 仓库长成现在这样，
> 以及在升级、修改或调试时应该注意哪些陷阱。

## 1. 双源结构

```
opencode-plugin-memory-capsule/
├── index.ts          # re-export shim（不是真正的入口）
├── src/              # 真正的 TypeScript 实现
│   ├── index.ts
│   ├── CapsuleEngine.ts
│   ├── Chunker.ts
│   ├── LocalEmbeddingService.ts
│   └── types.ts
├── dist/             # bun build 产物，gitignored
├── package.json      # main: "dist/index.js" + scripts.build + prepare
├── tsconfig.json     # outDir: "./dist"
└── README*.md
```

**为什么有根 `index.ts`：** 兜底。OpenCode 解析插件入口通常走 `package.json.main`
（指向 `dist/index.js`），但偶尔 IDE / typechecker 会沿 `index.ts` 兜底。
如果某天 `dist/` 还没构建就有人 clone，re-export shim 仍能解析。

**为什么 `dist/` 不进版本库：** 它是确定性的构建产物，与源码一一对应。强行提交
会让 PR 永远带 build 噪音。

## 2. 安装流程的正确姿势

`package.json` 已经注册了 `prepare` 钩子：

```json
"scripts": {
  "build": "bun build src/index.ts --outdir dist --target node --format esm",
  "build:watch": "bun build src/index.ts --outdir dist --target node --format esm --watch",
  "clean": "rm -rf dist",
  "prepare": "bun run build",
  "prepublishOnly": "bun run clean && bun run build"
}
```

`bun install` → `prepare` → `bun run build` 链路：

1. `bun install` 解析 `dependencies` 装包
2. 装完后 npm / bun 生命周期触发 `prepare` 脚本
3. `prepare` 调用 `bun run build`
4. `bun build src/index.ts --outdir dist --target node --format esm` 输出
   `dist/index.js` + sourcemaps + `.d.ts`

**如果 `prepare` 失败**，症状是 `package.json.main` 指向不存在的 `dist/index.js`。
排查：`bun --version`（需 ≥ 1.2.5）；手动 `bun run build` 看堆栈。

## 3. OpenCode SDK 升级注意事项

本插件用 `PeerDep` 形式引用 `@opencode-ai/plugin` 和 `@opencode-ai/sdk`。
升级时容易踩的点：

| 模块 | 行为 |
| --- | --- |
| `Plugin` 类型签名 | 历史上改过 `Plugin = (ctx, options) => Promise<...>` 的 `ctx` 形状，升级后常见 `ctx.project`、`ctx.client`、`ctx.$` 不可用。 |
| `tool()` 工厂 | 返回的 tool 对象字段名变过 (`description` / `args` / `execute`)。新版本多了 `formatError` 等可选字段。 |
| `session.idle` 事件 | 早期叫 `session.idle`，2024 末改名为 `session.idle`（不变），但 payload 结构从 string 变 `{ type, ... }` 对象。 |

升级后必须跑：

```bash
bun run build    # 类型不兼容会立刻报错
bun test         # 行为不兼容测试会抓
```

## 4. SQLite 数据库位置

默认是 **集中式**：

```
~/.config/opencode/plugins/memory-capsule/databases/project-{md5(absolutePath)}.db
```

每个项目（按 `process.cwd()` 的 MD5）独立一个文件，避免多项目交叉污染。
如果想项目内嵌，将 `useLocalDatabase` 设为 `true` 即可写到 `.opencode/capsule.db`。

**升级时不要删除 `databases/` 目录**，所有团队的"团队记忆"都在里面。
维护者如果想清理用户数据：

```bash
rm -rf ~/.config/opencode/plugins/memory-capsule/databases/
```

但要在 README / CHANGELOG 中明确告知。

## 5. 本地向量模型

首次运行会自动从 HuggingFace 镜像下载约 90MB `BAAI/bge-small-zh-v1.5` ONNX 模型到
`~/.cache/huggingface/hub/`。后续离线使用。

如果 CI 环境无法联网，需要预先 `BUN_INSTALL_CACHE_DIR=...` 预热。

## 6. 已知坑 / 不变式 (WONT-FIX)

| 坑 | 原因 | 状态 |
| --- | --- | --- |
| `dist/` 偶尔因 git 状态变化残留 | `.gitignore` 早期缺失 | 已加 gitignore |
| `onnxruntime-node` 在 Bun 1.x 上 crash | N-API 兼容问题 | 用 `pnpm.overrides.onnxruntime-node: empty-npm-package` 绕过 |
| GitHub Actions LFS 限制 | 90MB 模型 | 改为首次运行时下载 |

## 7. 发版 checklist

```bash
bun run clean       # 删旧 dist
bun install         # 装依赖 + prepare 钩子触发 build
bun test            # 跑测试，必须 100% 通过
git add -A
git commit -m "feat: ..."
git push origin main
```

不要直接 `pnpm publish`——本仓库 `private: true` 不会上 npm。
