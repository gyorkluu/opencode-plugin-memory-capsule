import { CognitiveCapsule, RuntimeContext, CapsulePluginConfig } from './types.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'bun:sqlite';

type EmbeddingFn = (text: string, isQuery?: boolean) => Promise<number[]>;
type LogFn = (msg: string, level?: 'info' | 'error' | 'warn' | 'debug') => void;

const ALLOWED_TABLES = new Set(['knowledge_chunks', 'capsules']);

interface KnowledgeChunk {
  id: string;
  sourceId: string;
  sourcePath: string;
  text: string;
  index: number;
}

export class CapsuleEngine {
  private config: CapsulePluginConfig;
  private db: Database;
  private dbPath: string;
  private embeddingCache: Map<string, number[]> = new Map();
  private closed = false;

  constructor(config: CapsulePluginConfig, projectDir?: string) {
    this.config = config;

    const dir = projectDir || process.cwd();
    const isTempDir = dir.startsWith('/tmp') || dir.startsWith('/private/tmp') || dir.includes('capsule-test');
    const useLocal = this.config.useLocalDatabase || isTempDir;

    if (useLocal) {
      const dbDir = path.join(dir, '.opencode');
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }
      this.dbPath = path.join(dbDir, 'capsule.db');
    } else {
      const homeDir = os.homedir();
      const dbDir = path.join(homeDir, '.config', 'opencode', 'plugins', 'memory-capsule', 'databases');
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      const projectHash = crypto.createHash('md5').update(dir).digest('hex');
      this.dbPath = path.join(dbDir, `project-${projectHash}.db`);

      try {
        const mappingFile = path.join(dbDir, 'projects.json');
        let mapping: Record<string, any> = {};
        if (fs.existsSync(mappingFile)) {
          mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf-8'));
        }
        mapping[`project-${projectHash}`] = {
          path: dir,
          name: path.basename(dir),
          updatedAt: Date.now()
        };
        fs.writeFileSync(mappingFile, JSON.stringify(mapping, null, 2));
      } catch (e) {
        // Ignore json mapping write errors
      }

      // Auto-migrate local database if exists
      const localDbPath = path.join(dir, '.opencode', 'capsule.db');
      if (fs.existsSync(localDbPath)) {
        try {
          fs.copyFileSync(localDbPath, this.dbPath);
          fs.unlinkSync(localDbPath);
          for (const ext of ['-wal', '-shm']) {
            const localSidecar = localDbPath + ext;
            const targetSidecar = this.dbPath + ext;
            if (fs.existsSync(localSidecar)) {
              fs.copyFileSync(localSidecar, targetSidecar);
              fs.unlinkSync(localSidecar);
            }
          }
          const localDbDir = path.dirname(localDbPath);
          if (fs.readdirSync(localDbDir).length === 0) {
            fs.rmdirSync(localDbDir);
          }
        } catch (e) {
          // Keep local if error
        }
      }
    }

    this.db = new Database(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA synchronous=NORMAL');
    this.db.exec('PRAGMA cache_size=-64000');

    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capsules (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0.0',
        scenario TEXT NOT NULL DEFAULT '',
        static_triggers TEXT NOT NULL DEFAULT '{}',
        semantic_description TEXT NOT NULL DEFAULT '',
        defect_pattern TEXT NOT NULL DEFAULT '',
        invariant_constraint TEXT NOT NULL DEFAULT '',
        parent_capsule_ids TEXT NOT NULL DEFAULT '[]',
        root_source_chunk_ids TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        embedding BLOB
      );

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        text TEXT NOT NULL,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        created_at INTEGER NOT NULL,
        UNIQUE(id)
      );

      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        loaded_at INTEGER NOT NULL,
        UNIQUE(id)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_source ON knowledge_chunks(source_id);
      CREATE INDEX IF NOT EXISTS idx_sources_path ON knowledge_sources(path);
    `);

    try {
      this.db.exec("ALTER TABLE capsules ADD COLUMN scenario TEXT NOT NULL DEFAULT ''");
    } catch (e) {
      // column already exists, safe to ignore
    }
  }

  public loadChunks(chunks: KnowledgeChunk[]): void {
    if (this.closed) return;
    const insertChunk = this.db.prepare(`
      INSERT OR REPLACE INTO knowledge_chunks (id, source_id, source_path, text, chunk_index, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const clearEmbedding = this.db.prepare(`
      UPDATE knowledge_chunks SET embedding = NULL WHERE id = ?
    `);

    const tx = this.db.transaction(() => {
      for (const chunk of chunks) {
        insertChunk.run(
          chunk.id,
          chunk.sourceId,
          chunk.sourcePath,
          chunk.text,
          chunk.index,
          Date.now()
        );
        clearEmbedding.run(chunk.id);
      }
    });
    tx();
  }

  public registerSource(sourceId: string, sourcePath: string, contentHash: string): void {
    if (this.closed) return;
    const existing = this.db.prepare(
      'SELECT content_hash FROM knowledge_sources WHERE id = ?'
    ).get(sourceId) as { content_hash: string } | null;

    if (existing && existing.content_hash === contentHash) {
      return;
    }

    if (existing) {
      this.db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(sourceId);
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO knowledge_sources (id, path, content_hash, loaded_at)
      VALUES (?, ?, ?, ?)
    `).run(sourceId, sourcePath, contentHash, Date.now());
  }

  public isSourceLoaded(sourceId: string, contentHash: string): boolean {
    if (this.closed) return false;
    const row = this.db.prepare(
      'SELECT content_hash FROM knowledge_sources WHERE id = ?'
    ).get(sourceId) as { content_hash: string } | null;
    return row !== null && row.content_hash === contentHash;
  }

  public async computeAndStoreEmbeddings(embedFn: EmbeddingFn, log?: LogFn): Promise<number> {
    if (this.closed) return 0;
    const unembedded = this.db.prepare(`
      SELECT id, text FROM knowledge_chunks WHERE embedding IS NULL
    `).all() as { id: string; text: string }[];

    const unembeddedCapsules = this.db.prepare(`
      SELECT id, scenario FROM capsules WHERE embedding IS NULL
    `).all() as { id: string; scenario: string }[];

    let computed = 0;

    for (const chunk of unembedded) {
      try {
        const vec = await embedFn(chunk.text, false);
        this.storeEmbedding('knowledge_chunks', chunk.id, vec);
        computed++;
      } catch (e) {
        log?.(`[CapsuleEngine] Embedding failed for chunk ${chunk.id}: ${e}`, 'warn');
      }
    }

    for (const cap of unembeddedCapsules) {
      try {
        const vec = await embedFn(cap.scenario, false);
        this.storeEmbedding('capsules', cap.id, vec);
        computed++;
      } catch (e) {
        log?.(`[CapsuleEngine] Embedding failed for capsule ${cap.id}: ${e}`, 'warn');
      }
    }

    log?.(`[CapsuleEngine] Computed ${computed} embeddings (${unembedded.length} chunks + ${unembeddedCapsules.length} capsules)`);
    return computed;
  }

  private storeEmbedding(table: string, id: string, vec: number[]): void {
    if (this.closed) return;
    if (!ALLOWED_TABLES.has(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }
    const buffer = new Float32Array(vec);
    this.db.prepare(`UPDATE ${table} SET embedding = ? WHERE id = ?`).run(
      Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      id
    );
  }

  private getEmbeddingFromDb(table: string, id: string): number[] | null {
    if (this.closed) return null;
    if (!ALLOWED_TABLES.has(table)) return null;
    const row = this.db.prepare(`SELECT embedding FROM ${table} WHERE id = ?`).get(id) as { embedding: Buffer } | null;
    if (!row || !row.embedding) return null;
    const float32 = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    return Array.from(float32);
  }

  public async routeCapsules(
    runtimeContext: RuntimeContext,
    embedFn: EmbeddingFn,
    log?: LogFn
  ): Promise<CognitiveCapsule[]> {
    if (this.closed) return [];
    const allCapsules = this.db.prepare('SELECT * FROM capsules').all() as any[];

    const candidates = allCapsules.filter(capsule => {
      const triggers = JSON.parse(capsule.static_triggers || '{}');
      const extMatch = !triggers.fileExtensions?.length ||
        triggers.fileExtensions.includes(runtimeContext.fileExtension);
      const depMatch = !triggers.dependencies?.length ||
        triggers.dependencies.some((dep: string) => runtimeContext.activeDeps.includes(dep));
      const astMatch = !triggers.astKeywords?.length ||
        triggers.astKeywords.some((kw: string) => runtimeContext.fileContent.includes(kw));
      return extMatch && (depMatch || astMatch);
    });

    log?.(`[routeCapsules] Layer1: ${allCapsules.length} total → ${candidates.length} candidates`);

    if (candidates.length === 0) return [];

    const queryVec = await this.getEmbeddingWithCache(runtimeContext.query, embedFn, true);

    const scored = candidates.map(capsule => {
      const vec = this.getEmbeddingFromDb('capsules', capsule.id);
      if (!vec) return { capsule, score: 0 };
      const score = this.cosineSimilarity(queryVec, vec);
      return { capsule, score };
    });

    return scored
      .filter(item => item.score >= this.config.matchThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.topK)
      .map(item => this.rowToCapsule(item.capsule));
  }

  public async routeRawKnowledge(
    query: string,
    embedFn: EmbeddingFn,
    log?: LogFn
  ): Promise<Array<{ id: string; text: string; sourcePath: string; score: number }>> {
    if (this.closed) return [];
    const allChunks = this.db.prepare(
      'SELECT id, text, source_path, embedding FROM knowledge_chunks'
    ).all() as { id: string; text: string; source_path: string; embedding: Buffer | null }[];

    if (allChunks.length === 0) return [];

    const queryVec = await this.getEmbeddingWithCache(query, embedFn, true);

    const scored = allChunks.map(chunk => {
      if (!chunk.embedding) return { id: chunk.id, text: chunk.text, sourcePath: chunk.source_path, score: 0 };
      const vec = this.bufferToVec(chunk.embedding);
      const score = this.cosineSimilarity(queryVec, vec);
      return { id: chunk.id, text: chunk.text, sourcePath: chunk.source_path, score };
    });

    const results = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, this.config.topK);

    log?.(`[routeRawKnowledge] ${allChunks.length} chunks → top ${results.length} (scores: ${results.map(r => r.score.toFixed(3)).join(', ')})`);

    return results;
  }

  public async verifyAndRegister(
    newCapsule: CognitiveCapsule,
    embedFn: EmbeddingFn,
    log?: LogFn
  ): Promise<boolean> {
    if (this.closed) return false;
    const newVec = await this.getEmbeddingWithCache(
      newCapsule.scenario,
      embedFn,
      false
    );

    const existingCapsules = this.db.prepare(
      'SELECT id, embedding FROM capsules WHERE embedding IS NOT NULL'
    ).all() as { id: string; embedding: Buffer }[];

    for (const existing of existingCapsules) {
      const regVec = this.bufferToVec(existing.embedding);
      const sim = this.cosineSimilarity(newVec, regVec);
      if (sim >= this.config.redundancyThreshold) {
        log?.(`[verifyAndRegister] Rejected redundant capsule "${newCapsule.title}" (sim=${sim.toFixed(3)})`);
        return false;
      }
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO capsules
        (id, title, version, scenario, static_triggers, semantic_description,
         defect_pattern, invariant_constraint, parent_capsule_ids,
         root_source_chunk_ids, created_at, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newCapsule.id,
      newCapsule.title,
      newCapsule.version,
      newCapsule.scenario,
      JSON.stringify(newCapsule.staticTriggers),
      newCapsule.semanticDescription,
      newCapsule.payload.defectPattern,
      newCapsule.payload.invariantConstraint,
      JSON.stringify(newCapsule.genealogy.parentCapsuleIds),
      JSON.stringify(newCapsule.genealogy.rootSourceChunkIds),
      newCapsule.createdAt,
      this.vecToBuffer(newVec)
    );

    log?.(`[verifyAndRegister] Registered capsule "${newCapsule.title}" v${newCapsule.version}`);
    return true;
  }

  public getCapsuleCount(): number {
    if (this.closed) return 0;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM capsules').get() as { count: number };
    return row.count;
  }

  public getChunkCount(): number {
    if (this.closed) return 0;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM knowledge_chunks').get() as { count: number };
    return row.count;
  }

  public getSourceCount(): number {
    if (this.closed) return 0;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM knowledge_sources').get() as { count: number };
    return row.count;
  }

  public getUnembeddedCount(): number {
    if (this.closed) return 0;
    const chunks = this.db.prepare('SELECT COUNT(*) as c FROM knowledge_chunks WHERE embedding IS NULL').get() as { c: number };
    const capsules = this.db.prepare('SELECT COUNT(*) as c FROM capsules WHERE embedding IS NULL').get() as { c: number };
    return chunks.c + capsules.c;
  }

  public getAllCapsules(): CognitiveCapsule[] {
    if (this.closed) return [];
    const rows = this.db.prepare('SELECT * FROM capsules ORDER BY created_at DESC').all() as any[];
    return rows.map(r => this.rowToCapsule(r));
  }

  public removeSource(sourceId: string): void {
    if (this.closed) return;
    this.db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(sourceId);
    this.db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(sourceId);
  }

  public syncToCodebaseMarkdown(projectDir: string): void {
    if (this.closed) return;
    const mdDir = path.join(projectDir, '.opencode');
    if (!fs.existsSync(mdDir)) {
      try {
        fs.mkdirSync(mdDir, { recursive: true });
      } catch (e) {
        return;
      }
    }
    const mdPath = path.join(mdDir, 'KNOWLEDGE-BASE.md');

    const capsules = this.getAllCapsules();
    const lines: string[] = [
      '# OpenCode Memory Capsules',
      '',
      'This file is automatically synchronized with the OpenCode Memory Capsule database.',
      'Manual changes here will be synced back to the database on start.',
      '',
      '---'
    ];

    for (const cap of capsules) {
      lines.push('');
      lines.push(`* **Cognitive Capsule: ${cap.title}**`);
      lines.push(`  - **Scenario**: ${cap.scenario}`);
      lines.push(`  - **Pattern**: ${cap.payload.defectPattern}`);
      lines.push(`  - **Invariant**: ${cap.payload.invariantConstraint}`);
      if (cap.version) {
        lines.push(`  - **Version**: ${cap.version}`);
      }
      if (cap.staticTriggers?.fileExtensions?.length) {
        lines.push(`  - **File Extensions**: ${cap.staticTriggers.fileExtensions.join(', ')}`);
      }
      if (cap.staticTriggers?.dependencies?.length) {
        lines.push(`  - **Dependencies**: ${cap.staticTriggers.dependencies.join(', ')}`);
      }
      if (cap.staticTriggers?.astKeywords?.length) {
        lines.push(`  - **Keywords**: ${cap.staticTriggers.astKeywords.join(', ')}`);
      }
      if (cap.semanticDescription) {
        lines.push(`  - **Description**: ${cap.semanticDescription}`);
      }
    }

    lines.push('');

    fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8');
  }

  public async syncFromCodebaseMarkdown(
    projectDir: string,
    embedFn: EmbeddingFn,
    log?: LogFn
  ): Promise<void> {
    if (this.closed) return;
    const mdPath = path.join(projectDir, '.opencode', 'KNOWLEDGE-BASE.md');
    if (!fs.existsSync(mdPath)) {
      log?.(`[syncFromCodebaseMarkdown] Markdown file not found at ${mdPath}, skipping sync.`, 'info');
      return;
    }

    try {
      const content = fs.readFileSync(mdPath, 'utf-8');
      const sections = content.split(/\*\s*\*\*Cognitive Capsule:\s*/i);
      const parsedCapsules: CognitiveCapsule[] = [];

      for (let i = 1; i < sections.length; i++) {
        const section = sections[i]!;
        const lines = section.split('\n');
        let title = lines[0]!.trim();
        if (title.endsWith('**')) {
          title = title.substring(0, title.length - 2).trim();
        }

        let scenario = '';
        let defectPattern = '';
        let invariantConstraint = '';
        let version = '1.0.0';
        let fileExtensions: string[] = [];
        let dependencies: string[] = [];
        let astKeywords: string[] = [];
        let description = '';

        for (const line of lines.slice(1)) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const scenarioMatch = trimmed.match(/^\s*[-*]\s*\*\*Scenario\*\*:\s*(.*)$/i);
          if (scenarioMatch) {
            scenario = scenarioMatch[1]!.trim();
            continue;
          }
          const patternMatch = trimmed.match(/^\s*[-*]\s*\*\*Pattern\*\*:\s*(.*)$/i);
          if (patternMatch) {
            defectPattern = patternMatch[1]!.trim();
            continue;
          }
          const invariantMatch = trimmed.match(/^\s*[-*]\s*\*\*Invariant\*\*:\s*(.*)$/i);
          if (invariantMatch) {
            invariantConstraint = invariantMatch[1]!.trim();
            continue;
          }
          const versionMatch = trimmed.match(/^\s*[-*]\s*\*\*Version\*\*:\s*(.*)$/i);
          if (versionMatch) {
            version = versionMatch[1]!.trim();
            continue;
          }
          const extMatch = trimmed.match(/^\s*[-*]\s*\*\*File Extensions\*\*:\s*(.*)$/i);
          if (extMatch) {
            fileExtensions = extMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
            continue;
          }
          const depMatch = trimmed.match(/^\s*[-*]\s*\*\*Dependencies\*\*:\s*(.*)$/i);
          if (depMatch) {
            dependencies = depMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
            continue;
          }
          const kwMatch = trimmed.match(/^\s*[-*]\s*\*\*Keywords\*\*:\s*(.*)$/i);
          if (kwMatch) {
            astKeywords = kwMatch[1]!.split(',').map(s => s.trim()).filter(Boolean);
            continue;
          }
          const descMatch = trimmed.match(/^\s*[-*]\s*\*\*Description\*\*:\s*(.*)$/i);
          if (descMatch) {
            description = descMatch[1]!.trim();
            continue;
          }
        }

        if (title && scenario && defectPattern && invariantConstraint) {
          const id = crypto.createHash('md5').update(title).digest('hex');
          parsedCapsules.push({
            id,
            title,
            version,
            scenario,
            staticTriggers: {
              fileExtensions,
              dependencies,
              astKeywords
            },
            semanticDescription: description,
            payload: {
              defectPattern,
              invariantConstraint
            },
            genealogy: {
              parentCapsuleIds: [],
              rootSourceChunkIds: []
            },
            createdAt: Date.now()
          });
        }
      }

      const parsedIds = new Set(parsedCapsules.map(c => c.id));
      const allDbCapsules = this.db.prepare('SELECT id, scenario, embedding FROM capsules').all() as { id: string; scenario: string; embedding: Buffer | null }[];

      for (const cap of parsedCapsules) {
        const dbRow = allDbCapsules.find(d => d.id === cap.id);
        let embeddingBuf: Buffer | null = null;
        if (dbRow && dbRow.scenario === cap.scenario && dbRow.embedding) {
          embeddingBuf = dbRow.embedding;
        } else {
          try {
            const vec = await embedFn(cap.scenario, false);
            embeddingBuf = this.vecToBuffer(vec);
          } catch (e) {
            log?.(`[syncFromCodebaseMarkdown] Embedding failed for "${cap.title}": ${e}`, 'warn');
          }
        }

        this.db.prepare(`
          INSERT OR REPLACE INTO capsules
            (id, title, version, scenario, static_triggers, semantic_description,
             defect_pattern, invariant_constraint, parent_capsule_ids,
             root_source_chunk_ids, created_at, embedding)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cap.id,
          cap.title,
          cap.version,
          cap.scenario,
          JSON.stringify(cap.staticTriggers),
          cap.semanticDescription,
          cap.payload.defectPattern,
          cap.payload.invariantConstraint,
          JSON.stringify(cap.genealogy.parentCapsuleIds),
          JSON.stringify(cap.genealogy.rootSourceChunkIds),
          cap.createdAt,
          embeddingBuf
        );
      }

      const deleteStmt = this.db.prepare('DELETE FROM capsules WHERE id = ?');
      let deleteCount = 0;
      for (const dbRow of allDbCapsules) {
        if (!parsedIds.has(dbRow.id)) {
          deleteStmt.run(dbRow.id);
          deleteCount++;
        }
      }

      if (deleteCount > 0) {
        log?.(`[syncFromCodebaseMarkdown] Garbage collected ${deleteCount} capsules from SQLite database.`, 'info');
      }

      log?.(`[syncFromCodebaseMarkdown] Synchronized ${parsedCapsules.length} capsules from markdown file.`, 'info');
    } catch (e) {
      log?.(`[syncFromCodebaseMarkdown] Failed: ${e}`, 'error');
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.embeddingCache.clear();
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {}
    this.db.close();
  }

  private rowToCapsule(row: any): CognitiveCapsule {
    return {
      id: row.id,
      title: row.title,
      version: row.version,
      scenario: row.scenario || '',
      staticTriggers: JSON.parse(row.static_triggers || '{}'),
      semanticDescription: row.semantic_description,
      payload: {
        defectPattern: row.defect_pattern,
        invariantConstraint: row.invariant_constraint,
      },
      genealogy: {
        parentCapsuleIds: JSON.parse(row.parent_capsule_ids || '[]'),
        rootSourceChunkIds: JSON.parse(row.root_source_chunk_ids || '[]'),
      },
      createdAt: row.created_at,
    };
  }

  private async getEmbeddingWithCache(text: string, embedFn: EmbeddingFn, isQuery: boolean): Promise<number[]> {
    const prefix = isQuery ? 'q:' : 'd:';
    const hash = prefix + crypto.createHash('sha256').update(text).digest('hex').substring(0, 32);
    const cached = this.embeddingCache.get(hash);
    if (cached) return cached;

    const vec = await embedFn(text, isQuery);
    this.embeddingCache.set(hash, vec);
    return vec;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (!a.length || !b.length) return 0;
    const len = Math.max(a.length, b.length);
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < len; i++) {
      const va = i < a.length ? a[i]! : 0;
      const vb = i < b.length ? b[i]! : 0;
      dot += va * vb;
      normA += va * va;
      normB += vb * vb;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }

  private bufferToVec(buf: Buffer): number[] {
    const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Array.from(float32);
  }

  private vecToBuffer(vec: number[]): Buffer {
    const float32 = new Float32Array(vec);
    return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
  }
}
