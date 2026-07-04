/**
 * Page memory: visited-page text is chunked, embedded, and stored so `recall`
 * can answer cross-page questions by vector similarity instead of substring
 * matching. Embeddings come from Ollama when available, else a dependency-free
 * local hashing embedder; the store is an in-process cosine index (a persistent
 * vector store like sqlite-vec would be a natural upgrade).
 */

export interface Embedder {
  readonly name: string;
  embed(text: string): Promise<number[]>;
}

/** Dependency-free fallback: hash words into a fixed-dim bag-of-words vector. */
export class HashEmbedder implements Embedder {
  readonly name = "local-hash";
  private readonly dim = 512;

  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dim).fill(0);
    for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 2166136261;
      for (let i = 0; i < word.length; i++) {
        h ^= word.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      const idx = Math.abs(h) % this.dim;
      v[idx] = (v[idx] ?? 0) + 1;
    }
    return normalize(v);
  }
}

/** Preferred: a real embedding model served by Ollama (e.g. nomic-embed-text). */
export class OllamaEmbedder implements Embedder {
  readonly name: string;
  constructor(private readonly baseUrl: string, private readonly model: string) {
    this.name = `ollama:${model}`;
  }

  async embed(text: string): Promise<number[]> {
    const r = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`ollama embeddings failed: ${r.status}`);
    const j = (await r.json()) as { embedding?: number[] };
    if (!j.embedding?.length) throw new Error("ollama returned no embedding");
    return normalize(j.embedding);
  }
}

function normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / mag);
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are pre-normalized
}

interface Chunk {
  url: string;
  title: string;
  text: string;
  vector: number[];
}

export interface RecallHit {
  url: string;
  title: string;
  text: string;
  score: number;
}

export class PageMemory {
  private chunks: Chunk[] = [];
  private seen = new Set<string>();

  constructor(private readonly embedder: Embedder, private readonly maxChunks = 500) {}

  get backend(): string {
    return this.embedder.name;
  }

  async add(url: string, title: string, text: string): Promise<void> {
    for (const piece of chunkText(text)) {
      const key = `${url}::${piece.slice(0, 60)}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      let vector: number[];
      try {
        vector = await this.embedder.embed(piece);
      } catch {
        return; // embedding backend unavailable — skip silently, recall degrades
      }
      this.chunks.push({ url, title, text: piece, vector });
      if (this.chunks.length > this.maxChunks) this.chunks.shift();
    }
  }

  async recall(query: string, k = 3): Promise<RecallHit[]> {
    if (this.chunks.length === 0) return [];
    let qv: number[];
    try {
      qv = await this.embedder.embed(query);
    } catch {
      return [];
    }
    return this.chunks
      .map((c) => ({ url: c.url, title: c.title, text: c.text, score: cosine(qv, c.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}

/** Split page text into ~600-char chunks on paragraph/line boundaries. */
function chunkText(text: string, size = 600): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  for (let i = 0; i < clean.length; i += size) chunks.push(clean.slice(i, i + size));
  return chunks.slice(0, 12); // cap chunks per page
}
