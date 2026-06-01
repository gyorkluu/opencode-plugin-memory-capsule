export interface TextChunk {
  id: string;
  sourceId: string;
  sourcePath: string;
  text: string;
  index: number;
  startOffset: number;
  endOffset: number;
}

const CHUNK_MAX_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 200;

export const chunkDocument = (
  content: string,
  sourceId: string,
  sourcePath: string
): TextChunk[] => {
  const lines = content.split('\n');
  const chunks: TextChunk[] = [];
  let currentChunk = '';
  let chunkStartLine = 0;
  let chunkIndex = 0;
  let charOffset = 0;

  const flush = (endLine: number) => {
    const text = currentChunk.trim();
    if (text.length === 0) return;

    chunks.push({
      id: `${sourceId}::chunk_${chunkIndex}`,
      sourceId,
      sourcePath,
      text,
      index: chunkIndex,
      startOffset: charOffset,
      endOffset: charOffset + text.length,
    });

    chunkIndex++;
    charOffset += text.length + 1;

    const overlapLines = lines.slice(
      Math.max(chunkStartLine, endLine - countLinesForOverlap(currentChunk)),
      endLine
    );
    currentChunk = overlapLines.join('\n') + '\n';
    chunkStartLine = Math.max(chunkStartLine, endLine - overlapLines.length);
  };

  const countLinesForOverlap = (chunk: string): number => {
    const targetChars = CHUNK_OVERLAP_CHARS;
    let count = 0;
    let acc = 0;
    const lns = chunk.split('\n');
    for (let i = lns.length - 1; i >= 0; i--) {
      acc += lns[i].length + 1;
      count++;
      if (acc >= targetChars) break;
    }
    return count;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (currentChunk.length + line.length + 1 > CHUNK_MAX_CHARS && currentChunk.trim().length > 0) {
      flush(i);
    }
    currentChunk += line + '\n';
  }

  if (currentChunk.trim().length > 0) {
    chunks.push({
      id: `${sourceId}::chunk_${chunkIndex}`,
      sourceId,
      sourcePath,
      text: currentChunk.trim(),
      index: chunkIndex,
      startOffset: charOffset,
      endOffset: charOffset + currentChunk.trim().length,
    });
  }

  return chunks;
};

export const estimateTokenCount = (text: string): number => {
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g) || []).length;
  const restLength = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + restLength * 0.25);
};
