import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HashEmbedder, OllamaEmbedder, PageMemory } from "../src/memory.js";

describe("HashEmbedder", () => {
  it("is deterministic and unit-normalized", async () => {
    const e = new HashEmbedder();
    const a = await e.embed("the quick brown fox");
    const b = await e.embed("the quick brown fox");
    assert.deepEqual(a, b);
    const mag = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(mag - 1) < 1e-9, `magnitude ${mag}`);
  });

  it("distinguishes different texts", async () => {
    const e = new HashEmbedder();
    assert.notDeepEqual(await e.embed("zebra stripes savanna"), await e.embed("stock market futures"));
  });
});

describe("PageMemory", () => {
  it("recalls the page whose words match the query, ranked first", async () => {
    const mem = new PageMemory(new HashEmbedder());
    await mem.add("http://a", "Animals", "the zebra and the giraffe live on the savanna plains");
    await mem.add("http://b", "Finance", "quarterly revenue grew and the stock market rallied");
    const hits = await mem.recall("zebra savanna", 2);
    assert.equal(hits[0]?.url, "http://a");
    assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
  });

  it("caps results at k", async () => {
    const mem = new PageMemory(new HashEmbedder());
    for (let i = 0; i < 5; i++) await mem.add(`http://p${i}`, "t", `unique page number ${i} words here`);
    assert.equal((await mem.recall("page words", 3)).length, 3);
  });

  it("dedupes identical url+content chunks", async () => {
    const mem = new PageMemory(new HashEmbedder());
    await mem.add("http://a", "T", "same content revisited");
    await mem.add("http://a", "T", "same content revisited");
    assert.equal((await mem.recall("content revisited", 10)).length, 1);
  });

  it("evicts oldest chunks past maxChunks", async () => {
    const mem = new PageMemory(new HashEmbedder(), 2);
    await mem.add("http://old", "T", "alpha bravo charlie");
    await mem.add("http://mid", "T", "delta echo foxtrot");
    await mem.add("http://new", "T", "golf hotel india");
    const hits = await mem.recall("anything", 10);
    assert.equal(hits.length, 2);
    assert.ok(!hits.some((h) => h.url === "http://old"), "oldest chunk evicted");
  });

  it("caps chunks per page at 12", async () => {
    const mem = new PageMemory(new HashEmbedder());
    // ~18k chars of DISTINCT words (identical windows would be deduped by design).
    const text = Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ");
    await mem.add("http://big", "T", text);
    assert.equal((await mem.recall("w42 w43", 50)).length, 12);
  });

  it("ignores empty text and empty stores", async () => {
    const mem = new PageMemory(new HashEmbedder());
    assert.deepEqual(await mem.recall("anything"), []);
    await mem.add("http://a", "T", "   \n  ");
    assert.deepEqual(await mem.recall("anything"), []);
  });

  it("degrades silently when the embedding backend is unreachable", async () => {
    // Port 9 (discard) — nothing listens there; embed() rejects.
    const mem = new PageMemory(new OllamaEmbedder("http://127.0.0.1:9", "nomic-embed-text"));
    await mem.add("http://a", "T", "some page text"); // must not throw
    assert.deepEqual(await mem.recall("some page"), []);
    assert.equal(mem.backend, "ollama:nomic-embed-text");
  });
});
