import { z } from 'zod';

export interface CognitiveCapsule {
  id: string;
  title: string;
  version: string;
  scenario: string;

  staticTriggers: {
    fileExtensions: string[];
    dependencies: string[];
    astKeywords: string[];
  };

  semanticDescription: string;

  payload: {
    defectPattern: string;
    invariantConstraint: string;
  };

  genealogy: {
    parentCapsuleIds: string[];
    rootSourceChunkIds: string[];
  };

  createdAt: number;
}

export interface RuntimeContext {
  fileExtension: string;
  activeDeps: string[];
  fileContent: string;
  query: string;
}

export const CapsulePluginConfigSchema = z.object({
  matchThreshold: z.number().default(0.4).describe('向量精匹配激活阈值'),
  redundancyThreshold: z.number().default(0.88).describe('胶囊去重冗余阈值'),
  topK: z.number().default(5).describe('最大返回胶囊数'),
  knowledgePatterns: z.array(z.string()).default([
    '**/KNOWLEDGE-*.md',
    '**/CAPSULE-*.md',
    '**/ARCHITECTURE.md',
    '**/DECISIONS.md'
  ]).describe('项目知识文件 glob 模式'),
  llmApiKey: z.string().default('').describe('LLM API Key'),
  llmBaseURL: z.string().default('https://api.minimaxi.com/anthropic').describe('LLM API Base URL'),
  llmModel: z.string().default('MiniMax-M2.7').describe('LLM 模型名称'),
  embeddingApiKey: z.string().default('').describe('Embedding API Key'),
  embeddingBaseURL: z.string().default('https://api.minimaxi.com/v1').describe('Embedding API Base URL'),
  embeddingModel: z.string().default('embo-01').describe('Embedding 模型名称'),
  idleSynthCooldownMs: z.number().default(300000).describe('session.idle 胶囊合成冷却时间(ms)，默认5分钟'),
  maxToolResultTokens: z.number().default(3000).describe('capsuleQuery 工具返回最大 token 数'),
  useLocalDatabase: z.boolean().default(false).describe('是否在项目本地存储数据库（.opencode/capsule.db）'),
  enableAutoDistill: z.boolean().default(false).describe('是否允许在空闲时自动合成胶囊'),
  useLocalEmbedding: z.boolean().default(true).describe('是否优先使用本地向量模型'),
  localEmbeddingModel: z.string().default('Xenova/bge-small-zh-v1.5').describe('本地向量模型名称'),
});

export type CapsulePluginConfig = z.infer<typeof CapsulePluginConfigSchema>;
