import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { BrowserSession } from "../src/browser.js";
import { startSite, type SiteHandle } from "./helpers.js";

/**
 * Integration tests against real Chromium (no API key). One shared session —
 * every test starts with its own navigation, so state does not leak; the two
 * tests that need pristine history launch their own session.
 */

let site: SiteHandle;
let b: BrowserSession;

before(async () => {
  site = await startSite((path, url) => {
    switch (path) {
      case "/basic":
        return `<html><body>
          <h1>Basic</h1>
          <a href="/other">A link</a>
          <input placeholder="user name">
          <input type="password" value="hunter2" placeholder="pass">
          <p>visible paragraph text</p>
        </body></html>`;
      case "/many": {
        const links = Array.from({ length: 200 }, (_, i) => `<a href="/l${i}">link ${i}</a>`).join(" ");
        return `<html><body>${links}<p>${"x".repeat(9000)}</p></body></html>`;
      }
      case "/jumpmenu":
        return `<html><body><select id="s" onchange="if(this.value)location.href='/landed'">
          <option value="">choose</option><option value="go">Go</option></select></body></html>`;
      case "/bounce":
        return `<html><body><script>setTimeout(function(){location.href='/landed'},0)</script></body></html>`;
      case "/landed":
        return `<html><body><h1>Landed</h1><button>onward</button></body></html>`;
      case "/popup":
        return `<html><body><button id="p" onclick="window.open('${site.away}/landed')">open</button></body></html>`;
      case "/framehost":
        // A same-origin iframe (/panel) and a CROSS-origin one (localhost /panel2).
        return `<html><body><h1>Host</h1><p>outer host text</p>
          <iframe src="/panel"></iframe>
          <iframe src="${site.away}/panel2"></iframe>
          </body></html>`;
      case "/panel":
        return `<html><body><p>same-origin panel text ZEBRA</p>
          <button onclick="document.getElementById('o').textContent='revealed PANEL-3F7K'">Reveal panel</button>
          <input placeholder="panel field"><div id="o"></div></body></html>`;
      case "/panel2":
        return `<html><body><p>cross-origin panel text GIRAFFE</p>
          <button>Cross button</button></body></html>`;
      case "/webmcp": {
        return {
          html: `<html><body><h1>Tools</h1><div id="r"></div><script>
            var api = (window.agent && window.agent.provideContext) ? window.agent : null;
            if (api) api.provideContext({ tools: [{
              name: "add_numbers",
              description: "Adds a and b.",
              inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
              execute: function(x){ return { ok: true, message: "sum=" + (x.a + x.b) }; }
            }, {
              name: "huge_result",
              description: "Returns a giant string.",
              inputSchema: { type: "object", properties: {} },
              execute: function(){ return { ok: true, message: Array(100000).join("A") }; }
            }, {
              name: "throws",
              description: "Always fails.",
              inputSchema: { type: "object", properties: {} },
              execute: function(){ throw new Error("page-side boom"); }
            }]});
            var mc = navigator.modelContext;
            if (mc && mc.registerTool) mc.registerTool({
              name: "via_register",
              description: "Registered one at a time.",
              inputSchema: { type: "object", properties: {} },
              execute: function(){ return "plain string result"; }
            });
          </script></body></html>`,
        };
      }
      default:
        return `<html><body><h1>page ${path}</h1></body></html>`;
    }
  });
  b = await BrowserSession.launch({ headless: true });
});

after(async () => {
  await b.close();
  await site.close();
});

describe("snapshot", () => {
  it("enumerates visible interactive elements with refs, redacting password values", async () => {
    await b.navigate(`${site.ok}/basic`);
    const s = await b.snapshot();
    assert.ok(s.elements.length >= 3);
    const pw = s.elements.find((e) => e.type === "password");
    assert.equal(pw?.value, "[redacted]");
    assert.ok(!JSON.stringify(s).includes("hunter2"), "secret never appears anywhere in the snapshot");
    assert.match(s.text, /visible paragraph text/);
    assert.ok(s.docToken, "docToken present");
  });

  it("keeps refs stable across snapshots and assigns new refs only to new nodes", async () => {
    await b.navigate(`${site.ok}/basic`);
    const s1 = await b.snapshot();
    const link1 = s1.elements.find((e) => e.tag === "a");
    const s2 = await b.snapshot();
    const link2 = s2.elements.find((e) => e.tag === "a");
    assert.equal(link1?.ref, link2?.ref);
    await b.page.evaluate(() => {
      const btn = document.createElement("button");
      btn.textContent = "fresh";
      document.body.appendChild(btn);
    });
    const s3 = await b.snapshot();
    const fresh = s3.elements.find((e) => e.name === "fresh");
    assert.ok(fresh, "new element found");
    assert.ok(!s1.elements.some((e) => e.ref === fresh?.ref), "new element got an unused ref");
    assert.equal(s3.elements.find((e) => e.tag === "a")?.ref, link1?.ref, "old element kept its ref");
  });

  it("issues a fresh docToken when the document is replaced (same URL reload)", async () => {
    await b.navigate(`${site.ok}/basic`);
    const t1 = (await b.snapshot()).docToken;
    await b.navigate(`${site.ok}/basic`);
    const t2 = (await b.snapshot()).docToken;
    assert.ok(t1 && t2 && t1 !== t2);
  });

  it("truncates element lists and page text with explicit flags", async () => {
    await b.navigate(`${site.ok}/many`);
    const s = await b.snapshot();
    assert.equal(s.elements.length, 150);
    assert.equal(s.elementsTruncated, true);
    assert.equal(s.text.length, 6000);
    assert.equal(s.textTruncated, true);
  });
});

describe("navigation-race resilience (regression: jump menus and instant redirects)", () => {
  it("survives a select-onchange navigation and lands on the target", async () => {
    for (let i = 0; i < 3; i++) {
      await b.navigate(`${site.ok}/jumpmenu`);
      const s = await b.snapshot();
      const sel = s.elements.find((e) => e.tag === "select");
      assert.ok(sel);
      const r = await b.selectOption(sel.ref, "go");
      assert.equal(r.ok, true);
      const after0 = await b.snapshot(); // must not throw "Execution context was destroyed"
      assert.match(after0.url, /\/landed$/);
    }
  });

  it("survives a 0ms client-side redirect", async () => {
    for (let i = 0; i < 3; i++) {
      await b.navigate(`${site.ok}/bounce`);
      const s = await b.snapshot();
      assert.match(s.url, /\/landed$/);
    }
  });
});

describe("iframes (cross-frame piercing + actuation)", () => {
  it("enumerates interactive elements from same- AND cross-origin child frames with frame-qualified refs", async () => {
    await b.navigate(`${site.ok}/framehost`);
    const s = await b.snapshot();
    const reveal = s.elements.find((e) => e.name === "Reveal panel");
    const cross = s.elements.find((e) => e.name === "Cross button");
    assert.ok(reveal, "same-origin frame button found");
    assert.ok(cross, "cross-origin frame button found");
    assert.match(reveal.ref, /^f\d+:\d+$/, `frame-qualified ref, got ${reveal?.ref}`);
    assert.match(cross.ref, /^f\d+:\d+$/);
    assert.notEqual(reveal.ref.split(":")[0], cross.ref.split(":")[0], "different frames get different ids");
  });

  it("merges every frame's visible text (main + same- + cross-origin)", async () => {
    await b.navigate(`${site.ok}/framehost`);
    const s = await b.snapshot();
    assert.match(s.text, /outer host text/);
    assert.match(s.text, /same-origin panel text ZEBRA/);
    assert.match(s.text, /cross-origin panel text GIRAFFE/);
  });

  it("clicks a button inside a child frame via its frame-qualified ref", async () => {
    await b.navigate(`${site.ok}/framehost`);
    let s = await b.snapshot();
    const reveal = s.elements.find((e) => e.name === "Reveal panel");
    assert.ok(reveal);
    const r = await b.click(reveal.ref);
    assert.equal(r.ok, true, r.detail);
    s = await b.snapshot();
    assert.match(s.text, /revealed PANEL-3F7K/, "the in-frame click took effect");
  });

  it("types into an input inside a child frame", async () => {
    await b.navigate(`${site.ok}/framehost`);
    let s = await b.snapshot();
    const field = s.elements.find((e) => e.name === "panel field");
    assert.ok(field);
    const r = await b.type(field.ref, "hello frame", false);
    assert.equal(r.ok, true, r.detail);
    s = await b.snapshot();
    const after = s.elements.find((e) => e.name === "panel field" || e.value === "hello frame");
    assert.equal(after?.value, "hello frame");
  });

  it("keeps a child-frame element's ref stable across snapshots", async () => {
    await b.navigate(`${site.ok}/framehost`);
    const r1 = (await b.snapshot()).elements.find((e) => e.name === "Reveal panel")?.ref;
    const r2 = (await b.snapshot()).elements.find((e) => e.name === "Reveal panel")?.ref;
    assert.ok(r1 && r1 === r2, `stable frame ref: ${r1} vs ${r2}`);
  });

  it("changes the aggregate docToken when a child frame reloads (forces a keyframe)", async () => {
    await b.navigate(`${site.ok}/framehost`);
    const t1 = (await b.snapshot()).docToken;
    // Reload just the same-origin iframe's document.
    await b.page.evaluate(() => {
      const f = document.querySelector("iframe");
      if (f) (f as HTMLIFrameElement).contentWindow?.location.reload();
    });
    await b.page.waitForTimeout(300);
    const t2 = (await b.snapshot()).docToken;
    assert.notEqual(t1, t2, "a child-frame reload changes the aggregate token");
  });
});

describe("goBack", () => {
  it("reports ok:false when there is no history", async () => {
    const fresh = await BrowserSession.launch({ headless: true });
    try {
      const r = await fresh.goBack();
      assert.equal(r.ok, false);
      assert.match(r.detail, /no previous page/);
    } finally {
      await fresh.close();
    }
  });

  it("navigates back through real history", async () => {
    const fresh = await BrowserSession.launch({ headless: true });
    try {
      await fresh.navigate(`${site.ok}/basic`);
      await fresh.navigate(`${site.ok}/landed`);
      const r = await fresh.goBack();
      assert.equal(r.ok, true);
      assert.match((await fresh.snapshot()).url, /\/basic$/);
    } finally {
      await fresh.close();
    }
  });
});

describe("popups", () => {
  it("drains an action-opened popup: returns its URL and closes it", async () => {
    await b.navigate(`${site.ok}/popup`);
    await b.drainPopups(); // clear anything stale from earlier tests
    const s = await b.snapshot();
    const btn = s.elements.find((e) => e.tag === "button");
    assert.ok(btn);
    await Promise.all([
      b.page.context().waitForEvent("page"),
      b.click(btn.ref),
    ]);
    const urls = await b.drainPopups();
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, new RegExp(`^${site.away.replace(/[.:/]/g, "\\$&")}/landed`));
    assert.equal(b.page.context().pages().length, 1, "popup was closed");
    assert.deepEqual(await b.drainPopups(), [], "drain resets");
  });
});

describe("WebMCP bridge", () => {
  it("detects tools registered via window.agent.provideContext AND navigator.modelContext.registerTool", async () => {
    await b.navigate(`${site.ok}/webmcp`);
    const tools = await b.detectWebMcpTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["add_numbers", "huge_result", "throws", "via_register"]);
    const add = tools.find((t) => t.name === "add_numbers");
    assert.equal(add?.description, "Adds a and b.");
    assert.equal((add?.inputSchema as { type?: string }).type, "object");
  });

  it("calls a page tool and returns its result", async () => {
    await b.navigate(`${site.ok}/webmcp`);
    const r = await b.callWebMcpTool("add_numbers", { a: 2, b: 40 });
    assert.deepEqual(r, { ok: true, detail: "sum=42" });
  });

  it("supports tools that return a plain string", async () => {
    await b.navigate(`${site.ok}/webmcp`);
    const r = await b.callWebMcpTool("via_register", {});
    assert.deepEqual(r, { ok: true, detail: "plain string result" });
  });

  it("caps a hostile giant result", async () => {
    await b.navigate(`${site.ok}/webmcp`);
    const r = await b.callWebMcpTool("huge_result", {});
    assert.equal(r.ok, true);
    assert.ok(r.detail.length <= 2100, `detail length ${r.detail.length}`);
    assert.match(r.detail, /\[result truncated\]$/);
  });

  it("reports unknown tools and page-side exceptions as failures, not throws", async () => {
    await b.navigate(`${site.ok}/webmcp`);
    assert.equal((await b.callWebMcpTool("no_such_tool", {})).ok, false);
    const boom = await b.callWebMcpTool("throws", {});
    assert.equal(boom.ok, false);
    assert.match(boom.detail, /failed/);
  });
});
