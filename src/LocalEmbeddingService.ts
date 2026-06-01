import * as ort from 'onnxruntime-web';
import * as fs from 'fs';
import * as path from 'path';

const EMBEDDING_DIM = 512;
const MODEL_CACHE_DIR = process.env.TRANSFORMERS_CACHE || path.join(process.env.HOME || '/tmp', '.cache', 'huggingface', 'hub');
const BGE_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

const CLS_TOKEN_ID = 101;
const SEP_TOKEN_ID = 102;
const UNK_TOKEN_ID = 100;
const MAX_SEQ_LEN = 512;

let session: ort.InferenceSession | null = null;
let vocab: Map<string, number> = new Map();
let cjkWords: Set<string> = new Set();
let initPromise: Promise<void> | null = null;
let initError: string | null = null;

const downloadFile = async (url: string, destPath: string): Promise<void> => {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(destPath)) return;

  console.log(`[LocalEmbedding] Downloading: ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Failed to download ${url}: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
};

const ensureModelFiles = async (): Promise<string> => {
  const modelDir = path.join(MODEL_CACHE_DIR, 'models--Xenova--bge-small-zh-v1.5', 'snapshots', 'default');

  if (fs.existsSync(path.join(modelDir, 'onnx', 'model.onnx')) && fs.existsSync(path.join(modelDir, 'tokenizer.json'))) {
    return modelDir;
  }

  const baseUrl = 'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/main';
  const files: Array<{ url: string; dest: string }> = [
    { url: `${baseUrl}/onnx/model.onnx`, dest: path.join(modelDir, 'onnx', 'model.onnx') },
    { url: `${baseUrl}/tokenizer.json`, dest: path.join(modelDir, 'tokenizer.json') },
    { url: `${baseUrl}/config.json`, dest: path.join(modelDir, 'config.json') },
  ];

  for (const file of files) {
    await downloadFile(file.url, file.dest);
  }

  return modelDir;
};

const loadVocabFromTokenizerJson = (tokenizerPath: string): { vocab: Map<string, number>; cjkWords: Set<string> } => {
  const data = JSON.parse(fs.readFileSync(tokenizerPath, 'utf-8'));
  const vocabMap = new Map<string, number>();
  const cjkSet = new Set<string>();

  if (data.model?.vocab) {
    for (const [token, id] of Object.entries(data.model.vocab)) {
      vocabMap.set(token, id as number);
      const clean = token.replace(/^##/, '');
      if (clean.length >= 2 && /[\u4e00-\u9fff]/.test(clean)) {
        cjkSet.add(clean);
      }
    }
  }

  return { vocab: vocabMap, cjkWords: cjkSet };
};

const basicTokenize = (text: string): string[] => {
  const tokens: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (/[\u4e00-\u9fff]/.test(ch)) {
      let cjkRun = '';
      while (i < text.length && /[\u4e00-\u9fff]/.test(text[i])) {
        cjkRun += text[i];
        i++;
      }

      let pos = 0;
      while (pos < cjkRun.length) {
        let matched = false;
        for (let len = Math.min(4, cjkRun.length - pos); len >= 2; len--) {
          const candidate = cjkRun.substring(pos, pos + len);
          if (cjkWords.has(candidate)) {
            tokens.push(candidate);
            pos += len;
            matched = true;
            break;
          }
        }
        if (!matched) {
          tokens.push(cjkRun[pos]);
          pos++;
        }
      }
      continue;
    }

    if (/[^\w\s]/.test(ch)) {
      tokens.push(ch.toLowerCase());
      i++;
      continue;
    }

    let word = '';
    while (i < text.length && /\w/.test(text[i]) && !/[\u4e00-\u9fff]/.test(text[i])) {
      word += text[i].toLowerCase();
      i++;
    }
    if (word) tokens.push(word);
  }

  return tokens;
};

const wordPieceTokenize = (word: string, vocabMap: Map<string, number>): number[] => {
  if (vocabMap.has(word)) return [vocabMap.get(word)!];

  const tokens: number[] = [];
  let start = 0;

  while (start < word.length) {
    let end = word.length;
    let found = false;

    while (start < end) {
      const substr = start === 0 ? word.slice(start, end) : '##' + word.slice(start, end);
      if (vocabMap.has(substr)) {
        tokens.push(vocabMap.get(substr)!);
        found = true;
        break;
      }
      end--;
    }

    if (!found) {
      tokens.push(UNK_TOKEN_ID);
      start++;
    } else {
      start = end;
    }
  }

  return tokens;
};

const tokenize = (text: string): { inputIds: number[]; attentionMask: number[]; tokenTypeIds: number[] } => {
  const inputIds: number[] = [CLS_TOKEN_ID];
  const attentionMask: number[] = [1];
  const tokenTypeIds: number[] = [0];

  const words = basicTokenize(text);

  for (const word of words) {
    if (inputIds.length >= MAX_SEQ_LEN - 1) break;

    const subTokens = wordPieceTokenize(word, vocab);

    for (const tokenId of subTokens) {
      if (inputIds.length >= MAX_SEQ_LEN - 1) break;
      inputIds.push(tokenId);
      attentionMask.push(1);
      tokenTypeIds.push(0);
    }
  }

  inputIds.push(SEP_TOKEN_ID);
  attentionMask.push(1);
  tokenTypeIds.push(0);

  return { inputIds, attentionMask, tokenTypeIds };
};

export const ensureInitialized = async (): Promise<void> => {
  if (session && vocab.size > 0) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const modelDir = await ensureModelFiles();

      ort.env.wasm.wasmPaths = undefined;
      ort.env.wasm.numThreads = 1;

      session = await ort.InferenceSession.create(path.join(modelDir, 'onnx', 'model.onnx'), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      const loaded = loadVocabFromTokenizerJson(path.join(modelDir, 'tokenizer.json'));
      vocab = loaded.vocab;
      cjkWords = loaded.cjkWords;

      initError = null;
      console.log(`[LocalEmbedding] Model loaded: dim=${EMBEDDING_DIM}, vocab=${vocab.size}, cjkWords=${cjkWords.size}, session=${session.inputNames}`);
    } catch (e: any) {
      initError = e?.message || String(e);
      console.error(`[LocalEmbedding] Failed to initialize:`, e);
      throw e;
    }
  })();

  return initPromise;
};

export const isReady = (): boolean => session !== null && vocab.size > 0;

export const getLastError = (): string | null => initError;

export const getEmbeddingDim = (): number => EMBEDDING_DIM;

export const embed = async (text: string, isQuery: boolean = false): Promise<number[]> => {
  await ensureInitialized();
  if (!session) throw new Error('Embedding service not initialized');

  const input = isQuery ? BGE_QUERY_PREFIX + text : text;

  const { inputIds, attentionMask, tokenTypeIds } = tokenize(input);

  const seqLen = inputIds.length;

  const inputIdsTensor = new ort.Tensor('int64', BigInt64Array.from(inputIds.map(id => BigInt(id))), [1, seqLen]);
  const attentionMaskTensor = new ort.Tensor('int64', BigInt64Array.from(attentionMask.map(m => BigInt(m))), [1, seqLen]);
  const tokenTypeIdsTensor = new ort.Tensor('int64', BigInt64Array.from(tokenTypeIds.map(id => BigInt(id))), [1, seqLen]);

  const feeds: Record<string, ort.Tensor> = {};
  const inputNames = session.inputNames;
  if (inputNames.includes('input_ids')) feeds['input_ids'] = inputIdsTensor;
  if (inputNames.includes('attention_mask')) feeds['attention_mask'] = attentionMaskTensor;
  if (inputNames.includes('token_type_ids')) feeds['token_type_ids'] = tokenTypeIdsTensor;

  const results = await session.run(feeds);
  const lastHidden = results[session.outputNames[0]];

  const data = lastHidden.data as Float32Array;
  const hiddenDim = lastHidden.dims[2];

  const pooled = new Float32Array(hiddenDim);
  let maskSum = 0;
  for (let i = 0; i < seqLen; i++) {
    const mask = attentionMask[i] || 1;
    maskSum += mask;
    for (let j = 0; j < hiddenDim; j++) {
      pooled[j] += data[i * hiddenDim + j] * mask;
    }
  }

  for (let j = 0; j < hiddenDim; j++) {
    pooled[j] /= maskSum;
  }

  let norm = 0;
  for (let j = 0; j < hiddenDim; j++) {
    norm += pooled[j] * pooled[j];
  }
  norm = Math.sqrt(norm);

  const normalized = new Float32Array(hiddenDim);
  for (let j = 0; j < hiddenDim; j++) {
    normalized[j] = norm > 0 ? pooled[j] / norm : 0;
  }

  return Array.from(normalized);
};

export const embedBatch = async (texts: string[], isQuery: boolean = false): Promise<number[][]> => {
  if (texts.length === 0) return [];
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embed(text, isQuery));
  }
  return results;
};
