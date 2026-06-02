import { Plugin, tool } from '@opencode-ai/plugin';
import { CapsuleEngine } from './CapsuleEngine.js';
import { CapsulePluginConfigSchema, CognitiveCapsule, RuntimeContext } from './types.js';
import { chunkDocument, estimateTokenCount } from './Chunker.js';
import * as LocalEmbedding from './LocalEmbeddingService.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { glob } from 'glob';
import { minimatch } from 'minimatch';
import { z } from 'zod';

const MAX_INJECTION_TOKENS = 4000;

// @opencode-ai/plugin@1.15.13's PluginInput is { client, project, directory,
// worktree, ... }. The `directory` field is the current working directory
// (replacing the old ctx.project.path).
// `options` (the second arg) is a PluginOptions = Record<string, unknown>;
// it carries the [name, options] tuple from opencode.json's `plugin` array.
// Note: in opencode 1.15.13 there is a known bug where `options` is passed
// as undefined despite the [name, options] tuple in opencode.json. The
// fallback chain below means the plugin still works correctly in that case.
export const MemoryCapsulePlugin: Plugin = async (ctx, options) => {
  const config = CapsulePluginConfigSchema.parse(options || {});
  const projectDir = (ctx.directory || process.cwd()).replace(/\/+$/, '');
  // Knowledge base resolution (in priority order):
  // 1) explicit config option (when opencode fixes the options-passing bug)
  // 2) if CWD is NOT the home dir, use CWD as knowledge base
  // 3) if CWD IS the home dir, fall back to the opencode config dir so the
  //    plugin can still find a KNOWLEDGE-BASE.md (which the user can symlink)
  const pluginFileDir = path.dirname(new URL(import.meta.url).pathname);
  const configDir = path.resolve(pluginFileDir, '..', '..', '..'); // ~/.config/opencode
  const knowledgeProjectDir =
    (config as any).knowledgeProjectPath ||
    (projectDir !== os.homedir() && projectDir !== '/' ? projectDir : configDir);
  const engine = new CapsuleEngine(config, knowledgeProjectDir);

  let lastIdleSynthTime = 0;
  let lastInjectedChunkIds: Set<string> = new Set();

  const logDir = path.join(os.homedir(), '.config', 'opencode', 'plugins', 'memory-capsule', 'logs');
  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {}
  }
  const logFile = path.join(logDir, 'plugin.log');

  const log = (message: string, level: 'info' | 'error' | 'warn' | 'debug' = 'info') => {
    ctx.client.app.log({
      body: {
        service: 'opencode-plugin-memory-capsule',
        level: level as any,
        message,
      }
    }).catch(() => {});

    try {
      const timestamp = new Date().toISOString();
      fs.appendFileSync(logFile, `[${timestamp}] [${level.toUpperCase()}] ${message}\n`);
    } catch {}
  };

  const isGitIgnored = (filePath: string): boolean => {
    try {
      const relativePath = path.relative(knowledgeProjectDir, filePath);
      if (relativePath.startsWith('..') || !relativePath) {
        return false;
      }
      const res = spawnSync('git', ['check-ignore', '-q', relativePath], {
        cwd: knowledgeProjectDir,
      });
      return res.status === 0;
    } catch (e) {
      return false;
    }
  };

  const resolveApiConfig = async (): Promise<{ apiKey: string; baseURL: string; model: string }> => {
    const envApiKey = process.env.CAPSULE_LLM_API_KEY || '';
    const envBaseURL = process.env.CAPSULE_LLM_BASE_URL || '';
    const envModel = process.env.CAPSULE_LLM_MODEL || '';

    if (envApiKey) {
      return {
        apiKey: envApiKey,
        baseURL: envBaseURL || 'https://api.minimaxi.com/anthropic',
        model: envModel || 'MiniMax-M2.7'
      };
    }

    if (config.llmApiKey) {
      return {
        apiKey: config.llmApiKey,
        baseURL: config.llmBaseURL,
        model: config.llmModel
      };
    }

    return {
      apiKey: '',
      baseURL: 'https://api.minimaxi.com/anthropic',
      model: 'MiniMax-M2.7'
    };
  };

  const callLLMAnthropic = async (
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    maxTokens = 2048,
    temperature = 1.0
  ): Promise<string> => {
    const apiConfig = await resolveApiConfig();
    if (!apiConfig.apiKey) {
      throw new Error('No LLM API key configured. Set CAPSULE_LLM_API_KEY env var or llmApiKey in plugin config.');
    }

    const url = `${apiConfig.baseURL.replace(/\/$/, '')}/v1/messages`;

    log(`[callLLM] POST ${url}, model=${apiConfig.model}, messages=${messages.length}`, 'info');

    const anthropicMessages = messages.map(m => ({
      role: m.role,
      content: [{ type: 'text' as const, text: m.content }]
    }));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiConfig.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: apiConfig.model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: anthropicMessages,
        temperature,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`[callLLM] API error: ${response.status} - ${errorText.substring(0, 300)}`, 'error');
      throw new Error(`LLM API failed: ${response.status} - ${errorText.substring(0, 200)}`);
    }

    const result = await response.json() as any;
    const textBlocks = (result.content || []).filter((b: any) => b.type === 'text');
    const content = textBlocks.map((b: any) => b.text).join('\n');

    if (!content) {
      throw new Error('No text content in LLM response');
    }

    log(`[callLLM] Response OK, length=${content.length}`, 'info');
    return content;
  };

  const deterministicLocalEmbedding = (text: string): number[] => {
    const DIM = 64;
    const vector = new Array(DIM).fill(0);
    const normalized = text.toLowerCase();

    for (let i = 0; i < normalized.length; i++) {
      const charCode = normalized.charCodeAt(i);
      const slot = charCode % DIM;
      vector[slot] += 1;
      const shiftSlot = (charCode >> 3) % DIM;
      vector[shiftSlot] += 0.5;
    }

    for (let i = 0; i < DIM; i++) {
      vector[i] += (Math.sin(i * 0.1 + normalized.length * 0.01) + 1) * 0.1;
    }

    const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vector.map(v => v / norm) : vector;
  };

  const getEmbedding = async (text: string, isQuery: boolean = false): Promise<number[]> => {
    if (config.useLocalEmbedding) {
      try {
        await LocalEmbedding.ensureInitialized(config.localEmbeddingModel);
        if (LocalEmbedding.isReady()) {
          return await LocalEmbedding.embed(text, isQuery);
        }
      } catch (e) {
        log(`[getEmbedding] Local model (${config.localEmbeddingModel}) failed, falling back: ${e}`, 'warn');
      }
    }

    const apiConfig = await resolveApiConfig();
    const apiKey = config.embeddingApiKey || apiConfig.apiKey;

    if (apiKey) {
      const baseURL = (config.embeddingBaseURL || 'https://api.minimaxi.com/v1').replace(/\/$/, '');
      const url = `${baseURL}/embeddings`;

      try {
        const body: Record<string, unknown> = {
          model: config.embeddingModel,
          texts: [text.substring(0, 8000)],
          type: 'db',
        };

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        });

        const result = await response.json() as any;

        if (response.ok) {
          const embedding = result.vectors?.[0] || result.data?.[0]?.embedding;
          if (Array.isArray(embedding) && embedding.length > 0) {
            log(`[getEmbedding] API success, dim=${embedding.length}`, 'debug');
            return embedding;
          }
          log(`[getEmbedding] API returned empty: ${JSON.stringify(result).substring(0, 200)}`, 'warn');
        } else {
          log(`[getEmbedding] API failed: ${response.status} - ${JSON.stringify(result).substring(0, 200)}`, 'warn');
        }
      } catch (e) {
        log(`[getEmbedding] API error: ${e}`, 'warn');
      }
    }

    log(`[getEmbedding] All methods failed, using deterministic local embedding (64-dim, low quality)`, 'warn');
    return deterministicLocalEmbedding(text);
  };

  // Knowledge lives in a project dir separate from the CWD. By default it's the
  // current project, but you can point to a different one (e.g. always load
  // super-cloud-disk knowledge even when CWD is ~ or a subdir of it).
  // (knowledgeProjectDir is declared above near the top of the function so
  // file.watcher handlers can reuse it)

  /**
   * Load bundled knowledge that ships with the plugin itself. These .md files
   * live in <plugin>/bundled/ next to dist/. They are version-controlled
   * with the plugin code, so knowledge updates ride along with plugin
   * releases. Loaded into the SAME DB as project knowledge, with each
   * capsule's source_project pointing at the bundled file (e.g.
   * "bundled/super-cloud-disk.md") for traceability.
   */
  const loadBundledKnowledge = async (): Promise<void> => {
    const bundledDir = path.join(pluginFileDir, '..', 'bundled');
    if (!fs.existsSync(bundledDir)) {
      log(`[bundled] No bundled/ dir at ${bundledDir}, skipping`, 'info');
      return;
    }
    const files = fs.readdirSync(bundledDir).filter(f => f.endsWith('.md'));
    if (files.length === 0) {
      log(`[bundled] bundled/ dir is empty`, 'info');
      return;
    }
    log(`[bundled] Loading ${files.length} bundled knowledge file(s) from ${bundledDir}`, 'info');
    for (const file of files) {
      const absPath = path.join(bundledDir, file);
      const relPath = `bundled/${file}`;
      log(`[bundled] Syncing ${relPath} (source_project=${relPath})`, 'info');
      try {
        await engine.syncFromCodebaseMarkdown(absPath, getEmbedding, log, relPath);
      } catch (e) {
        log(`[bundled] Failed to sync ${relPath}: ${e}`, 'warn');
      }
    }
  };

  const loadProjectKnowledge = async (): Promise<void> => {
    log(`[loadProjectKnowledge] Scanning project: ${knowledgeProjectDir} (cwd: ${projectDir})`, 'info');

    const isHome = knowledgeProjectDir === os.homedir() || knowledgeProjectDir === '/';
    let newChunks = 0;
    let skippedSources = 0;

    for (const pattern of config.knowledgePatterns) {
      try {
        const searchPattern = isHome ? pattern.replace(/^\*\*\//, './') : pattern;
        const files = await glob(searchPattern, {
          cwd: knowledgeProjectDir,
          absolute: true,
          nodir: true
        });

        for (const filePath of files) {
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (content.trim().length === 0) continue;

            const relativePath = path.relative(knowledgeProjectDir, filePath);
            if (isGitIgnored(filePath)) {
              log(`[loadProjectKnowledge] Skipping git-ignored file: ${relativePath}`, 'debug');
              continue;
            }
            const sourceId = `knowledge:${relativePath}`;
            const contentHash = crypto.createHash('md5').update(content).digest('hex');

            if (engine.isSourceLoaded(sourceId, contentHash)) {
              skippedSources++;
              continue;
            }

            engine.registerSource(sourceId, relativePath, contentHash);

            const chunks = chunkDocument(content, sourceId, relativePath);
            engine.loadChunks(chunks);
            newChunks += chunks.length;

            log(`[loadProjectKnowledge] Loaded: ${relativePath} → ${chunks.length} chunks (${content.length} chars, hash=${contentHash.substring(0, 8)})`, 'info');
          } catch (e) {
            log(`[loadProjectKnowledge] Failed to read ${filePath}: ${e}`, 'warn');
          }
        }
      } catch (e) {
        log(`[loadProjectKnowledge] Glob pattern "${pattern}" failed: ${e}`, 'debug');
      }
    }

    log(`[loadProjectKnowledge] Done: ${newChunks} new chunks, ${skippedSources} unchanged sources, total ${engine.getChunkCount()} chunks in DB`, 'info');

    if (newChunks > 0) {
      log(`[loadProjectKnowledge] Computing embeddings for ${engine.getUnembeddedCount()} unembedded items...`, 'info');
      const computed = await engine.computeAndStoreEmbeddings(getEmbedding, log);
      log(`[loadProjectKnowledge] Embeddings computed: ${computed}`, 'info');
    }
  };

  const buildRuntimeContext = async (query: string, sessionId: string): Promise<RuntimeContext> => {
    let fileExtension = '';
    let activeDeps: string[] = [];
    let fileContent = '';

    try {
      const pkgJsonPath = path.join(projectDir, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        activeDeps = [
          ...Object.keys(pkg.dependencies || {}),
          ...Object.keys(pkg.devDependencies || {})
        ];
      }
    } catch (e) {
      log(`[buildRuntimeContext] Failed to read package.json: ${e}`, 'debug');
    }

    try {
      const messagesRes = await ctx.client.session.messages({
        path: { id: sessionId }
      });
      const messages = messagesRes.data || [];
      const lastUserMsg = [...messages].reverse().find(m => m.info.role === 'user');
      if (lastUserMsg) {
        const fileParts = lastUserMsg.parts.filter(p => p.type === 'file');
        if (fileParts.length > 0) {
          const filePath = (fileParts[0] as any)?.path || (fileParts[0] as any)?.name || '';
          if (filePath) {
            fileExtension = path.extname(filePath);
          }
        }
      }
    } catch (e) {
      log(`[buildRuntimeContext] Failed to extract file context: ${e}`, 'debug');
    }

    return {
      fileExtension,
      activeDeps,
      fileContent,
      query
    };
  };

  const synthesizeCapsule = async (
    query: string,
    assistantResponse: string,
    sessionId: string,
    sourceIds: string[]
  ): Promise<void> => {
    const systemPrompt = `你是一个认知胶囊提炼引擎。你的任务是从对话中提取"确定性经验约束"，格式严格如下。
规则：
1. 只提取"不可违反的技术铁律"，而非模糊建议
2. invariantConstraint 必须是可执行的、具体的约束条件
3. 如果对话中没有明确的技术决策或铁律，返回 confidence=0
4. staticTriggers 必须与内容严格相关，不可泛化
5. 只能从对话中提取事实，绝不能编造对话中未提及的内容`;

    const userPrompt = `请从以下对话中提炼一个认知胶囊。

用户问题: "${query}"
助手回答: "${assistantResponse.substring(0, 2000)}"

请严格返回 JSON 格式（不要 markdown 代码块）：
{
  "title": "简洁的英文标题，如 Vue3-Ref-Cleanup-Rule",
  "version": "1.0.0",
  "scenario": "当前适用的具体技术和应用场景描述，如：在编写 Vue 3 组件中使用 reactive refs 或 watchers 时",
  "staticTriggers": {
    "fileExtensions": [".相关后缀"],
    "dependencies": ["相关依赖包名"],
    "astKeywords": ["相关代码关键字"]
  },
  "semanticDescription": "描述该胶囊解决的具体问题场景",
  "payload": {
    "defectPattern": "缺陷/问题的具象模式",
    "invariantConstraint": "不可违反的铁律约束"
  },
  "confidence": 1
}`;

    try {
      const result = await callLLMAnthropic(systemPrompt, [{ role: 'user', content: userPrompt }], 1024, 0.3);
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log(`[synthesizeCapsule] No JSON found in LLM response`, 'warn');
        return;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.confidence !== 1 || !parsed.payload?.invariantConstraint) {
        log(`[synthesizeCapsule] Confidence=0 or no invariant, skipping`, 'debug');
        return;
      }

      const title = parsed.title || 'Untitled-Capsule';
      const id = crypto.createHash('md5').update(title).digest('hex');

      const capsule: CognitiveCapsule = {
        id,
        title,
        version: parsed.version || '1.0.0',
        scenario: parsed.scenario || '',
        staticTriggers: parsed.staticTriggers || { fileExtensions: [], dependencies: [], astKeywords: [] },
        semanticDescription: parsed.semanticDescription || '',
        payload: parsed.payload,
        genealogy: {
          parentCapsuleIds: [],
          rootSourceChunkIds: sourceIds
        },
        createdAt: Date.now()
      };

      const registered = await engine.verifyAndRegister(capsule, getEmbedding, log);
      if (registered) {
        log(`[synthesizeCapsule] New capsule synthesized: "${capsule.title}"`, 'info');
        engine.syncToCodebaseMarkdown(knowledgeProjectDir);
      }
    } catch (e) {
      log(`[synthesizeCapsule] Failed: ${e}`, 'warn');
    }
  };

  const buildInjectionWithBudget = (
    capsules: CognitiveCapsule[],
    knowledge: Array<{ id: string; text: string; sourcePath: string; score: number }>
  ): string | null => {
    const capsuleTexts = capsules.map((cap, i) =>
      `* **Cognitive Capsule #${i + 1}: ${cap.title}**\n  - **Scenario**: ${cap.scenario}\n  - **Pattern**: ${cap.payload.defectPattern}\n  - **Invariant**: ${cap.payload.invariantConstraint}`
    );

    const knowledgeTexts = knowledge.map((k, i) =>
      `* **Knowledge Source**: \`${k.sourcePath}\` (relevance score: ${k.score.toFixed(2)})\n  - **Content**:\n${k.text.split('\n').map(line => '    ' + line).join('\n')}`
    );

    let usedTokens = 0;
    const selectedParts: string[] = [];
    const injectedIds = new Set<string>();

    for (const capText of capsuleTexts) {
      const tokens = estimateTokenCount(capText);
      if (usedTokens + tokens > MAX_INJECTION_TOKENS) break;
      selectedParts.push(capText);
      usedTokens += tokens;
    }

    for (let i = 0; i < knowledgeTexts.length; i++) {
      const knText = knowledgeTexts[i];
      const knId = knowledge[i]?.id;
      if (!knId) continue;

      const tokens = estimateTokenCount(knText);
      if (usedTokens + tokens > MAX_INJECTION_TOKENS) {
        const remaining = MAX_INJECTION_TOKENS - usedTokens;
        if (remaining > 100) {
          const charBudget = Math.floor(remaining * 2.5);
          selectedParts.push(knText.substring(0, charBudget) + '\n...[truncated]');
          injectedIds.add(knId);
          usedTokens = MAX_INJECTION_TOKENS;
        }
        break;
      }
      selectedParts.push(knText);
      injectedIds.add(knId);
      usedTokens += tokens;
    }

    lastInjectedChunkIds = injectedIds;

    if (selectedParts.length === 0) return null;

    return `==== COGNITIVE CAPSULE CONSTRAINTS ====
The following content is loaded from project knowledge files and past verified executions.
CRITICAL RULES:
1. For INVARIANT CONSTRAINT entries: treat as absolute invariants, do NOT hallucinate alternative logic
2. For Recalled Knowledge entries: these are VERBATIM copies of project files. Quote them exactly, do NOT paraphrase or add information not present in the source
3. If the knowledge does not contain the answer, say so explicitly rather than fabricating content

${selectedParts.join('\n\n---\n\n')}
==============================================`;
  };

  const truncateToTokenBudget = (text: string, maxTokens: number): string => {
    const estimated = estimateTokenCount(text);
    if (estimated <= maxTokens) return text;

    const charBudget = Math.floor(maxTokens * 2.5);
    return text.substring(0, charBudget) + '\n\n...[result truncated to fit token budget]';
  };

  const matchesKnowledgePattern = (filePath: string): boolean => {
    const relativePath = path.relative(knowledgeProjectDir, filePath);
    return config.knowledgePatterns.some(pattern =>
      minimatch(relativePath, pattern, { matchBase: true })
    );
  };

  log(`[init] Initializing CapsuleEngine with project: ${projectDir} (knowledge: ${knowledgeProjectDir})`, 'info');

  if (config.useLocalEmbedding) {
    LocalEmbedding.ensureInitialized(config.localEmbeddingModel).then(() => {
      log(`[init] Local embedding model (${config.localEmbeddingModel}) ready, dim=${LocalEmbedding.getEmbeddingDim()}`, 'info');
    }).catch((e) => {
      log(`[init] Local embedding model (${config.localEmbeddingModel}) failed to load: ${e}. Will fallback.`, 'warn');
    });
  } else {
    log(`[init] Local embedding model is disabled. Using API embedding fallback.`, 'info');
  }

  // Load bundled knowledge first (always). Then optionally scan project dir
  // (opt-in via enableProjectScan). The chained loadProjectKnowledge is only
  // called inside the project-scan branch.
  loadBundledKnowledge()
    .then(() =>
      (config as any).enableProjectScan
        ? engine
            .syncFromCodebaseMarkdown(knowledgeProjectDir, getEmbedding, log)
            .then(() => loadProjectKnowledge())
        : Promise.resolve()
    )
    .then(() => {
      log(`[init] Engine ready: ${engine.getSourceCount()} sources, ${engine.getChunkCount()} chunks, ${engine.getCapsuleCount()} capsules`, 'info');
    })
    .catch((e) => {
      log(`[init] Knowledge loading failed: ${e}`, 'error');
    });

  return {
    tool: {
      capsuleQuery: tool({
        description: `忠实检索项目知识库和认知胶囊库的原文内容。返回的是原始文档片段，不做任何 LLM 合成或改写。
适用场景：
1. 需要精确引用项目知识文件中的内容
2. 查找已确认的技术决策和架构规范的原文
3. 获取认知胶囊中的 INVARIANT CONSTRAINT 原文
注意：此工具返回原文，不会编造或解读内容。`,
        args: {
          query: z.string().describe('检索关键词或问题描述'),
          fileExtension: z.string().optional().describe('当前文件后缀，如 .vue .ts'),
          activeDependencies: z.string().optional().describe('逗号分隔的当前项目依赖，如 vue,pinia')
        },
        execute: async (args, toolCtx) => {
          const query = args.query || '';
          const sessionId = toolCtx.sessionID || 'default-session';

          log(`[capsuleQuery] INVOKED: query="${query.substring(0, 100)}"`, 'info');

          const runtimeContext: RuntimeContext = {
            fileExtension: args.fileExtension || '',
            activeDeps: args.activeDependencies ? args.activeDependencies.split(',').map(s => s.trim()) : [],
            fileContent: '',
            query
          };

          const capsules = await engine.routeCapsules(runtimeContext, getEmbedding, log);
          const knowledge = await engine.routeRawKnowledge(query, getEmbedding, log);

          const dedupedKnowledge = knowledge.filter(k => !lastInjectedChunkIds.has(k.id));

          const capsuleTexts = capsules.map((cap, i) =>
            `* **Cognitive Capsule #${i + 1}: ${cap.title}**\n  - **Scenario**: ${cap.scenario}\n  - **Pattern**: ${cap.payload.defectPattern}\n  - **Invariant**: ${cap.payload.invariantConstraint}`
          ).join('\n\n');

          const knowledgeTexts = dedupedKnowledge.map((k, i) =>
            `* **Knowledge Source**: \`${k.sourcePath}\` (relevance score: ${k.score.toFixed(2)})\n  - **Content**:\n${k.text.split('\n').map(line => '    ' + line).join('\n')}`
          ).join('\n\n');

          const combinedContext = [capsuleTexts, knowledgeTexts].filter(t => t.length > 0).join('\n\n---\n\n');

          if (!combinedContext) {
            return 'No relevant capsules or knowledge found for this query.';
          }

          const truncated = truncateToTokenBudget(combinedContext, config.maxToolResultTokens);

          log(`[capsuleQuery] Returning ${capsules.length} capsules + ${dedupedKnowledge.length} knowledge chunks (deduped from ${knowledge.length}, ${lastInjectedChunkIds.size} already in system prompt)`, 'info');

          return truncated;
        }
      })
    },

    'experimental.chat.system.transform': async (input, output) => {
      const sessionId = input.sessionID;
      if (!sessionId) return;

      log(`[system.transform] TRIGGERED: sessionId=${sessionId}`, 'info');

      try {
        const messagesRes = await ctx.client.session.messages({
          path: { id: sessionId }
        });
        const messages = messagesRes.data || [];
        if (messages.length === 0) return;

        const lastUserMessage = [...messages]
          .reverse()
          .find(m => m.info.role === 'user');
        if (!lastUserMessage) return;

        const queryText = lastUserMessage.parts
          .filter(p => p.type === 'text')
          .map(p => (p as any).text)
          .join('\n');
        if (!queryText) return;

        const runtimeContext = await buildRuntimeContext(queryText, sessionId);
        const capsules = await engine.routeCapsules(runtimeContext, getEmbedding, log);
        const knowledge = await engine.routeRawKnowledge(queryText, getEmbedding, log);

        const injection = buildInjectionWithBudget(capsules, knowledge);

        if (!injection) {
          log(`[system.transform] No capsules or knowledge activated, skipping injection`, 'info');
          return;
        }

        output.system.push(injection);
        log(`[system.transform] Injected ${capsules.length} capsules + ${knowledge.length} knowledge chunks (budget=${MAX_INJECTION_TOKENS} tokens)`, 'info');
      } catch (e) {
        log(`[system.transform] Failed: ${e}`, 'error');
      }
    },

    'experimental.session.compacting': async (input, output) => {
      const sessionId = input.sessionID;

      log(`[session.compacting] TRIGGERED: sessionId=${sessionId}`, 'info');

      try {
        const messagesRes = await ctx.client.session.messages({
          path: { id: sessionId }
        });
        const messages = messagesRes.data || [];
        if (messages.length === 0) return;

        const dialogueText = messages
          .map(m => {
            const role = m.info.role;
            const content = m.parts
              .filter(p => p.type === 'text')
              .map(p => (p as any).text)
              .join('\n');
            return `${role}: ${content}`;
          })
          .join('\n');

        log(`[session.compacting] Distilling ${messages.length} messages into capsules using LLM (${config.llmModel})...`, 'info');

        const systemPrompt = `你是一个认知胶囊蒸馏引擎。你的任务是从即将被压缩的对话历史中，提炼出"不可丢失的确定性技术铁律"。
规则：
1. 只提炼"不可违反的技术约束"，而非模糊总结
2. 每条 invariantConstraint 必须是具体的、可执行的
3. 最多提炼 3 条最核心的约束
4. 只能从对话中提取事实，绝不能编造对话中未提及的内容`;

        const userPrompt = `以下对话即将被压缩清理，请提炼认知胶囊：

${dialogueText.substring(0, 6000)}

请严格返回 JSON 数组（不要 markdown 代码块）：
[{
  "title": "英文标题",
  "version": "1.0.0",
  "scenario": "当前适用的具体技术和应用场景描述，如：在编写 Vue 3 组件中使用 reactive refs 或 watchers 时",
  "staticTriggers": { "fileExtensions": [], "dependencies": [], "astKeywords": [] },
  "semanticDescription": "场景描述",
  "payload": { "defectPattern": "问题模式", "invariantConstraint": "铁律约束" },
  "confidence": 1
}]`;

        const distillRes = await callLLMAnthropic(systemPrompt, [{ role: 'user', content: userPrompt }], 1024, 0.3);

        let items: any[] = [];
        try {
          const jsonStart = distillRes.indexOf('[');
          const jsonEnd = distillRes.lastIndexOf(']');
          if (jsonStart !== -1 && jsonEnd !== -1) {
            items = JSON.parse(distillRes.substring(jsonStart, jsonEnd + 1));
          }
        } catch (e) {
          log(`[session.compacting] JSON parse failed: ${e}`, 'warn');
        }

        let distilledCount = 0;
        for (const item of items) {
          if (item.confidence === 1 && item.payload?.invariantConstraint) {
            const title = item.title || 'Distilled-Capsule';
            const id = crypto.createHash('md5').update(title).digest('hex');

            const capsule: CognitiveCapsule = {
              id,
              title,
              version: item.version || '1.0.0',
              scenario: item.scenario || '',
              staticTriggers: item.staticTriggers || { fileExtensions: [], dependencies: [], astKeywords: [] },
              semanticDescription: item.semanticDescription || '',
              payload: item.payload,
              genealogy: {
                parentCapsuleIds: [],
                rootSourceChunkIds: []
              },
              createdAt: Date.now()
            };

            const registered = await engine.verifyAndRegister(capsule, getEmbedding, log);
            if (registered) distilledCount++;
          }
        }

        if (distilledCount > 0) {
          engine.syncToCodebaseMarkdown(knowledgeProjectDir);
          output.context.push(`[Cognitive Capsule] 已蒸馏并持久化 ${distilledCount} 条确定性技术约束。`);
          log(`[session.compacting] Distilled ${distilledCount} capsules`, 'info');
        }
      } catch (e) {
        log(`[session.compacting] Failed: ${e}`, 'error');
      }
    },

    'session.idle': async (input: any) => {
      const sessionId = input.sessionID;
      if (!sessionId) return;

      if (!config.enableAutoDistill) {
        log(`[session.idle] Auto distillation is disabled. Skipping capsule synthesis.`, 'debug');
        return;
      }

      const now = Date.now();
      if (now - lastIdleSynthTime < config.idleSynthCooldownMs) {
        log(`[session.idle] Cooldown active, skipping capsule synthesis (${Math.ceil((config.idleSynthCooldownMs - (now - lastIdleSynthTime)) / 1000)}s remaining)`, 'debug');
        return;
      }

      try {
        const messagesRes = await ctx.client.session.messages({
          path: { id: sessionId }
        });
        const messages = messagesRes.data || [];
        if (messages.length < 2) return;

        const lastAssistantMessage = [...messages]
          .reverse()
          .find(m => m.info.role === 'assistant');
        const lastUserMessage = [...messages]
          .reverse()
          .find(m => m.info.role === 'user');

        if (!lastAssistantMessage || !lastUserMessage) return;

        const userText = lastUserMessage.parts
          .filter(p => p.type === 'text')
          .map(p => (p as any).text)
          .join('\n');
        const assistantText = lastAssistantMessage.parts
          .filter(p => p.type === 'text')
          .map(p => (p as any).text)
          .join('\n');

        if (!userText || !assistantText) return;

        log(`[session.idle] Auto-distilling dialogue into capsule using LLM (${config.llmModel})...`, 'info');
        lastIdleSynthTime = now;
        await synthesizeCapsule(userText, assistantText, sessionId, []);
      } catch (e) {
        log(`[session.idle] Capsule synthesis failed: ${e}`, 'debug');
      }
    },

    'file.watcher.updated': async (input: any) => {
      const filePath: string = input.path || '';
      if (!filePath) return;

      if (filePath.endsWith('KNOWLEDGE-BASE.md')) {
        log(`[file.watcher] KNOWLEDGE-BASE.md updated. Syncing to database...`, 'info');
        await engine.syncFromCodebaseMarkdown(knowledgeProjectDir, getEmbedding, log);
        return;
      }

      if (!matchesKnowledgePattern(filePath)) return;

      if (isGitIgnored(filePath)) {
        log(`[file.watcher] Skipping git-ignored file update: ${filePath}`, 'debug');
        return;
      }

      const relativePath = path.relative(knowledgeProjectDir, filePath);
      log(`[file.watcher] Knowledge file changed: ${relativePath}`, 'info');

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.trim().length === 0) return;

        const sourceId = `knowledge:${relativePath}`;
        const contentHash = crypto.createHash('md5').update(content).digest('hex');

        if (engine.isSourceLoaded(sourceId, contentHash)) {
          log(`[file.watcher] Content unchanged: ${relativePath}`, 'debug');
          return;
        }

        engine.registerSource(sourceId, relativePath, contentHash);
        const chunks = chunkDocument(content, sourceId, relativePath);
        engine.loadChunks(chunks);

        log(`[file.watcher] Reloaded: ${relativePath} → ${chunks.length} chunks`, 'info');

        const computed = await engine.computeAndStoreEmbeddings(getEmbedding, log);
        log(`[file.watcher] Computed ${computed} new embeddings`, 'info');
      } catch (e) {
        log(`[file.watcher] Failed to reload ${filePath}: ${e}`, 'warn');
      }
    }
  };
};
