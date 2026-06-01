import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { CapsuleEngine } from '../src/CapsuleEngine.js';
import { CapsulePluginConfigSchema, CognitiveCapsule } from '../src/types.js';
import * as LocalEmbedding from '../src/LocalEmbeddingService.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const config = CapsulePluginConfigSchema.parse({
  matchThreshold: 0.35 // Use slightly lower threshold for test flexibility
});

describe('Memory Capsule 2.0 - Scenario Matching & Git Sync', () => {
  let TEST_DIR: string;
  let engine: CapsuleEngine;

  beforeEach(async () => {
    TEST_DIR = path.join('/tmp', 'capsule-v2-sync-test-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7));
    fs.mkdirSync(TEST_DIR, { recursive: true });
    
    // Ensure BGE embedding model is loaded
    await LocalEmbedding.ensureInitialized();
    engine = new CapsuleEngine(config, TEST_DIR);
  });

  afterEach(() => {
    if (engine) {
      engine.close();
    }
    try {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {}
  });

  const embedFn = async (text: string, isQuery = false) => {
    return LocalEmbedding.embed(text, isQuery);
  };

  it('1. should vectorize and query capsules based on scenario description', async () => {
    const title1 = 'Vue-Watcher-Cleanup';
    const cap1: CognitiveCapsule = {
      id: crypto.createHash('md5').update(title1).digest('hex'),
      title: title1,
      version: '1.0.0',
      scenario: 'When writing Vue 3 watchers in component setup function',
      staticTriggers: { fileExtensions: ['.vue'], dependencies: ['vue'], astKeywords: [] },
      semanticDescription: 'Ensure watchers are stopped when component setup closes or unmounts',
      payload: {
        defectPattern: 'watchEffect runs infinitely after component is unmounted',
        invariantConstraint: 'Always call the stop handle inside onUnmounted hook'
      },
      genealogy: { parentCapsuleIds: [], rootSourceChunkIds: [] },
      createdAt: Date.now()
    };

    const title2 = 'Docker-Base-Image-Security';
    const cap2: CognitiveCapsule = {
      id: crypto.createHash('md5').update(title2).digest('hex'),
      title: title2,
      version: '1.0.0',
      scenario: 'Configuring Dockerfiles for Node.js production service containerization',
      staticTriggers: { fileExtensions: ['Dockerfile'], dependencies: [], astKeywords: [] },
      semanticDescription: 'Use alpine base image for minimal vulnerability surface',
      payload: {
        defectPattern: 'Using full node:latest image brings critical OS level bugs',
        invariantConstraint: 'Always specify node:alpine or node:slim as base'
      },
      genealogy: { parentCapsuleIds: [], rootSourceChunkIds: [] },
      createdAt: Date.now()
    };

    // Register both
    await engine.verifyAndRegister(cap1, embedFn);
    await engine.verifyAndRegister(cap2, embedFn);

    expect(engine.getCapsuleCount()).toBe(2);

    // Query 1: Vue component logic - should match cap1
    const ctxVue = {
      fileExtension: '.vue',
      activeDeps: ['vue'],
      fileContent: '',
      query: 'I am creating a Vue watch pattern and want to clean up watchers'
    };
    const matchedVue = await engine.routeCapsules(ctxVue, embedFn);
    expect(matchedVue.length).toBeGreaterThanOrEqual(1);
    expect(matchedVue[0]!.title).toBe('Vue-Watcher-Cleanup');

    // Query 2: Docker production - should match cap2
    const ctxDocker = {
      fileExtension: 'Dockerfile',
      activeDeps: [],
      fileContent: '',
      query: 'Deploying Node app in container with Dockerfile'
    };
    const matchedDocker = await engine.routeCapsules(ctxDocker, embedFn);
    expect(matchedDocker.length).toBeGreaterThanOrEqual(1);
    expect(matchedDocker[0]!.title).toBe('Docker-Base-Image-Security');
  });

  it('2. should serialize SQLite capsules to KNOWLEDGE-BASE.md and parse them back', async () => {
    const title = 'React-State-Stale-Closure';
    const cap: CognitiveCapsule = {
      id: crypto.createHash('md5').update(title).digest('hex'),
      title,
      version: '2.1.0',
      scenario: 'Writing async callbacks inside React useEffect hooks',
      staticTriggers: { fileExtensions: ['.tsx'], dependencies: ['react'], astKeywords: ['useEffect'] },
      semanticDescription: 'Avoid using variables that change over time without listing them in dependencies',
      payload: {
        defectPattern: 'Callback references old state values due to closure',
        invariantConstraint: 'Pass state setter functional updates or add to dependency array'
      },
      genealogy: { parentCapsuleIds: [], rootSourceChunkIds: [] },
      createdAt: Date.now()
    };

    await engine.verifyAndRegister(cap, embedFn);
    
    // Sync DB -> Markdown
    engine.syncToCodebaseMarkdown(TEST_DIR);

    const mdPath = path.join(TEST_DIR, '.opencode', 'KNOWLEDGE-BASE.md');
    expect(fs.existsSync(mdPath)).toBe(true);

    const mdContent = fs.readFileSync(mdPath, 'utf-8');
    expect(mdContent).toContain('Cognitive Capsule: React-State-Stale-Closure');
    expect(mdContent).toContain('**Scenario**: Writing async callbacks inside React useEffect hooks');
    expect(mdContent).toContain('**Invariant**: Pass state setter functional updates or add to dependency array');

    // Now clear SQLite DB to simulate starting on a new checkout/clean state
    engine.close();
    const dbPath = path.join(TEST_DIR, '.opencode', 'capsule.db');
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    
    // Reinitialize engine
    engine = new CapsuleEngine(config, TEST_DIR);
    expect(engine.getCapsuleCount()).toBe(0);

    // Sync Markdown -> DB
    await engine.syncFromCodebaseMarkdown(TEST_DIR, embedFn);
    expect(engine.getCapsuleCount()).toBe(1);

    const reloaded = engine.getAllCapsules()[0]!;
    expect(reloaded.title).toBe(title);
    expect(reloaded.scenario).toBe(cap.scenario);
    expect(reloaded.payload.invariantConstraint).toBe(cap.payload.invariantConstraint);
    expect(reloaded.version).toBe('2.1.0');
    expect(reloaded.staticTriggers.fileExtensions).toContain('.tsx');
  });

  it('3. should sync updates, additions, and deletions from KNOWLEDGE-BASE.md back to SQLite', async () => {
    // 1. Manually create KNOWLEDGE-BASE.md with 2 capsules
    const mdDir = path.join(TEST_DIR, '.opencode');
    fs.mkdirSync(mdDir, { recursive: true });
    const mdPath = path.join(mdDir, 'KNOWLEDGE-BASE.md');

    const initialMarkdown = `# OpenCode Memory Capsules

This file is automatically synchronized with the OpenCode Memory Capsule database.
Manual changes here will be synced back to the database on start.

---

* **Cognitive Capsule: Rule-A**
  - **Scenario**: Scenario description for A
  - **Pattern**: Pattern description A
  - **Invariant**: Invariant constraint A
  - **Version**: 1.2.3
  - **File Extensions**: .ts, .js

* **Cognitive Capsule: Rule-B**
  - **Scenario**: Scenario description for B
  - **Pattern**: Pattern description B
  - **Invariant**: Invariant constraint B
`;
    fs.writeFileSync(mdPath, initialMarkdown, 'utf-8');

    // Sync to DB
    await engine.syncFromCodebaseMarkdown(TEST_DIR, embedFn);
    expect(engine.getCapsuleCount()).toBe(2);

    const capA = engine.getAllCapsules().find(c => c.title === 'Rule-A')!;
    expect(capA.version).toBe('1.2.3');
    expect(capA.staticTriggers.fileExtensions).toEqual(['.ts', '.js']);

    // 2. Modify Rule-A, delete Rule-B, and add Rule-C in markdown
    const updatedMarkdown = `# OpenCode Memory Capsules

This file is automatically synchronized with the OpenCode Memory Capsule database.

---

* **Cognitive Capsule: Rule-A**
  - **Scenario**: Scenario description for A - Modified
  - **Pattern**: Pattern description A
  - **Invariant**: Invariant constraint A - Updated
  - **Version**: 1.2.4
  - **File Extensions**: .ts

* **Cognitive Capsule: Rule-C**
  - **Scenario**: Scenario description for C
  - **Pattern**: Pattern description C
  - **Invariant**: Invariant constraint C
`;
    fs.writeFileSync(mdPath, updatedMarkdown, 'utf-8');

    // Sync to DB again
    await engine.syncFromCodebaseMarkdown(TEST_DIR, embedFn);

    // Verify DB count and contents
    expect(engine.getCapsuleCount()).toBe(2); // Rule-A, Rule-C (Rule-B was garbage collected)
    
    const capsules = engine.getAllCapsules();
    
    const dbA = capsules.find(c => c.title === 'Rule-A')!;
    expect(dbA.scenario).toBe('Scenario description for A - Modified');
    expect(dbA.payload.invariantConstraint).toBe('Invariant constraint A - Updated');
    expect(dbA.version).toBe('1.2.4');
    expect(dbA.staticTriggers.fileExtensions).toEqual(['.ts']);

    const dbB = capsules.find(c => c.title === 'Rule-B');
    expect(dbB).toBeUndefined(); // Rule-B must be deleted

    const dbC = capsules.find(c => c.title === 'Rule-C')!;
    expect(dbC.scenario).toBe('Scenario description for C');
    expect(dbC.payload.invariantConstraint).toBe('Invariant constraint C');
  });
});
