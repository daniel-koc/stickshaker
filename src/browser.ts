import { chromium, type Browser, type BrowserContext, type Page, type Frame } from "playwright";
import type { Snapshot, ActionResult, ElementInfo } from "./types.js";

const MAX_ELEMENTS = 150;
const MAX_TEXT_CHARS = 6000;
const ACTION_TIMEOUT_MS = 8000;

export interface BrowserOptions {
  headless: boolean;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message.split("\n")[0]! : String(e);
}

/**
 * True for a Playwright error caused by a navigation tearing down the page's JS
 * context while an evaluate was in flight. A `<select onchange>` jump menu, a
 * meta-refresh, or a client-side redirect that outran settle() all produce this.
 */
function isNavigationRace(e: unknown): boolean {
  const m = errMsg(e).toLowerCase();
  return (
    m.includes("execution context was destroyed") ||
    m.includes("context was destroyed") ||
    m.includes("cannot find context") ||
    m.includes("frame was detached") ||
    m.includes("navigating and changing the content")
  );
}

function frameHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Runs IN one frame's document: enumerate visible interactive elements, stamp each
 * with a stable per-document `data-sk-ref`, and return them with FRAME-LOCAL numeric
 * refs plus the frame's visible text and per-document token. The walk covers the
 * COMPOSED tree: it recurses into every open shadow root (a flat querySelectorAll
 * cannot see into web components), so component-framework pages enumerate too —
 * and Playwright's CSS locators pierce open roots, so the stamped refs stay
 * actuatable with no changes on the actuation side. Closed shadow roots are out of
 * scope (no JS handle from outside; documented limitation). The BrowserSession
 * qualifies the refs across frames (`fN:local`) and merges the results. Kept at
 * module scope so it can be handed to both `page.mainFrame().evaluate` and each
 * child `frame.evaluate` — Playwright can execute it in cross-origin frames too.
 */
const enumerateInFrame = ({ maxElements, maxText }: { maxElements: number; maxText: number }) => {
  // Stable refs: keep any ref already on a node; only new nodes get a new number.
  // So the same element carries the same [ref] across turns, which is what lets
  // successive snapshots be diffed by ref.
  const counter = globalThis as unknown as { __skNextRef?: number };
  if (typeof counter.__skNextRef !== "number") counter.__skNextRef = 0;

  const isVisible = (el: Element): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return !(
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.opacity === "0"
    );
  };

  const interactiveSelector = [
    "a[href]", "button", "input", "textarea", "select",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]",
    "[role=tab]", "[role=menuitem]", "[role=option]", "[role=switch]",
    "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  const accessibleName = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();
    const text = (el as HTMLElement).innerText?.trim();
    if (text) return text;
    const placeholder = (el as HTMLInputElement).placeholder;
    if (placeholder) return placeholder.trim();
    const title = el.getAttribute("title");
    if (title) return title.trim();
    const alt = el.getAttribute("alt");
    if (alt) return alt.trim();
    // Never fall back to a secret field's value for the accessible name.
    const isPassword = el.tagName === "INPUT" && (el as HTMLInputElement).type === "password";
    const value = (el as HTMLInputElement).value;
    if (value && !isPassword) return value.trim();
    return "";
  };

  const elements: Array<Record<string, unknown>> = [];
  let elementsTruncated = false;
  const shadowTexts: string[] = [];

  const addElement = (el: Element): void => {
    let refAttr = el.getAttribute("data-sk-ref");
    if (refAttr === null) {
      refAttr = String(counter.__skNextRef!++);
      el.setAttribute("data-sk-ref", refAttr);
    }
    const ref = Number(refAttr);
    const tag = el.tagName.toLowerCase();
    const info: Record<string, unknown> = { ref, tag, name: accessibleName(el).slice(0, 120) };

    const role = el.getAttribute("role");
    if (role) info.role = role;
    const inputType = (el as HTMLInputElement).type;
    if (inputType && (tag === "input" || tag === "button")) info.type = inputType;
    if (tag === "a") {
      const href = (el as HTMLAnchorElement).href;
      if (href) info.href = href;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const value = (el as HTMLInputElement).value;
      // Never surface secret field contents into snapshots, traces, or reports.
      if (value) info.value = inputType === "password" ? "[redacted]" : value.slice(0, 80);
    }
    elements.push(info);
  };

  // Composed-tree walk: this root's interactive elements first, then recurse into
  // every OPEN shadow root it hosts (`.shadowRoot` is null for closed/UA roots).
  // The truncated flag is set only when a VISIBLE interactive element actually
  // exceeds the cap — a page with exactly maxElements must not read as truncated.
  const collect = (root: Document | ShadowRoot): void => {
    for (const el of Array.from(root.querySelectorAll(interactiveSelector))) {
      if (!isVisible(el)) continue;
      if (elements.length >= maxElements) {
        elementsTruncated = true;
        return;
      }
      addElement(el);
    }
    for (const host of Array.from(root.querySelectorAll("*"))) {
      if (elementsTruncated) return;
      const sr = (host as Element & { shadowRoot: ShadowRoot | null }).shadowRoot;
      if (!sr) continue;
      // innerText walks the NODE tree, not the flat tree, so shadow-rendered text
      // never reaches body.innerText — gather each root's text here. (Slotted
      // light-DOM content stays in the node tree and is already covered above;
      // nested roots are collected by their own recursion level, so no doubles.)
      const t = Array.from(sr.children)
        .map((c) => ((c as HTMLElement).innerText ?? ""))
        .join("\n")
        .trim();
      if (t) shadowTexts.push(t);
      collect(sr);
    }
  };
  collect(document);

  const fullText = [(document.body?.innerText ?? "") as string, ...shadowTexts]
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return {
    url: location.href,
    title: document.title,
    elements,
    text: fullText.slice(0, maxText),
    elementsTruncated,
    textTruncated: fullText.length > maxText,
    docToken: (globalThis as unknown as { __skDocToken?: string }).__skDocToken,
  };
};

/**
 * Thin wrapper over a Playwright Chromium session.
 *
 * Snapshotting enumerates visible interactive elements across the main frame AND
 * every child frame (iframes, same- and cross-origin), stamping each with a
 * `data-sk-ref` so the agent can act on it by its ref. Refs are stable across turns
 * (so snapshots can be diffed) and frame-qualified — bare (e.g. "5") for the main
 * frame, "fN:local" for an element inside child frame N — so refs never collide and
 * actuation can route each one back to its owning frame.
 */
export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;
  private popups: Page[] = [];
  // Stable frame ids across turns. Frame object identity is stable until a frame
  // detaches, so a ref like "f2:5" points to the same frame next turn.
  private frameIds = new Map<Frame, number>();
  private frameById = new Map<number, Frame>();
  private nextChildFrameId = 1;

  static async launch(opts: BrowserOptions): Promise<BrowserSession> {
    const s = new BrowserSession();
    s.browser = await chromium.launch({ headless: opts.headless });
    s.context = await s.browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Runs in every document before page scripts, setting up three things: (1) a
    // no-op __name shim (tsx/esbuild injects __name() into page.evaluate callbacks,
    // which don't exist in the page; harmless after a `tsc` build, required under
    // tsx); (2) a monotonic ref counter and a per-document token; (3) the WebMCP
    // registration API. The WebMCP shim is intentionally always-on for every origin
    // the agent visits — that's what lets a real WebMCP page work — which does make
    // `navigator.modelContext` / `window.agent` observable to every page.
    await s.context.addInitScript(() => {
      const g = globalThis as unknown as {
        __name?: (fn: unknown) => unknown;
        __skNextRef?: number;
        __skDocToken?: string;
        __webmcp_tools?: Record<string, unknown>;
        agent?: { provideContext?: (ctx: unknown) => void };
        navigator?: { modelContext?: Record<string, unknown> };
      };
      g.__name ??= (fn) => fn;
      // Monotonic ref counter, per document. Resets on navigation (fresh window),
      // which is exactly where the agent forces a keyframe.
      g.__skNextRef ??= 0;
      // Per-document token: a fresh JS context (any full navigation, including a
      // same-URL reload) gets a new value, so the agent can force a keyframe when
      // the document was replaced even though the URL string didn't change.
      g.__skDocToken ??= Math.random().toString(36).slice(2);
      // WebMCP origin-trial shim. On real origin-trial Chrome the browser provides
      // the tool-registration API (window.agent / navigator.modelContext); we
      // polyfill that same surface and mirror any registered tools into a registry
      // the agent reads, so a page written against the WebMCP API works under
      // Stickshaker without shipping its own shim.
      g.__webmcp_tools ??= {};
      const registry = g.__webmcp_tools;
      const register = (tool: unknown): void => {
        const t = tool as { name?: string } | null;
        if (t && typeof t.name === "string") registry[t.name] = t;
      };
      const provideContext = (ctx: unknown): void => {
        const list = (ctx as { tools?: unknown[] } | null)?.tools ?? [];
        for (const t of list) register(t);
      };
      const agent = g.agent ?? (g.agent = {});
      agent.provideContext ??= provideContext;
      try {
        const nav = g.navigator;
        if (nav) {
          const mc = (nav.modelContext ?? (nav.modelContext = {})) as {
            provideContext?: (ctx: unknown) => void;
            registerTool?: (t: unknown) => void;
          };
          mc.provideContext ??= provideContext;
          mc.registerTool ??= register;
        }
      } catch {
        /* navigator can be read-only in some contexts — the window.agent path still works */
      }
    });
    s.page = await s.context.newPage();
    // Track popups/new tabs opened AFTER the main page (the main page's own `page`
    // event already fired above). The agent drives only the main page, so these are
    // enforced against policy and closed via drainPopups().
    s.context.on("page", (p) => {
      s.popups.push(p);
    });
    return s;
  }

  private async settle(): Promise<void> {
    try {
      await this.page.waitForLoadState("networkidle", { timeout: 3000 });
    } catch {
      // networkidle never fires on long-polling / streaming pages — not an error.
    }
  }

  async navigate(url: string): Promise<ActionResult> {
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.settle();
      return { ok: true, detail: `navigated to ${url}` };
    } catch (e) {
      return { ok: false, detail: `navigate failed: ${errMsg(e)}` };
    }
  }

  async snapshot(): Promise<Snapshot> {
    try {
      return await this.captureSnapshot();
    } catch (e) {
      // A navigation can destroy the JS context while the evaluate is running —
      // e.g. a <select onchange> jump menu, a meta-refresh, or a client-side
      // redirect that outran settle(). Rather than let an uncaught throw abort the
      // whole run (agent.ts snapshots bare after each action), wait for the new
      // document to commit and capture once more. Every caller gets this safety net.
      if (!isNavigationRace(e)) throw e;
      await this.page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await this.settle();
      return await this.captureSnapshot();
    }
  }

  /** Stable id for a frame across turns (the main frame is always 0). */
  private frameIdOf(f: Frame): number {
    const existing = this.frameIds.get(f);
    if (existing !== undefined) return existing;
    const id = f === this.page.mainFrame() ? 0 : this.nextChildFrameId++;
    this.frameIds.set(f, id);
    this.frameById.set(id, f);
    return id;
  }

  private async captureSnapshot(): Promise<Snapshot> {
    const main = this.page.mainFrame();
    const elements: ElementInfo[] = [];
    const texts: string[] = [];
    const tokens: string[] = [];
    let elementsTruncated = false;
    let textTruncated = false;
    let remaining = MAX_ELEMENTS;

    // Main frame first, OUTSIDE the per-frame try/catch: a nav race here must reach
    // snapshot()'s retry, not be swallowed as an empty snapshot.
    const mainRaw = await main.evaluate(enumerateInFrame, { maxElements: remaining, maxText: MAX_TEXT_CHARS });
    for (const el of mainRaw.elements) elements.push({ ...(el as unknown as ElementInfo), ref: String(el.ref) });
    remaining -= mainRaw.elements.length;
    elementsTruncated ||= mainRaw.elementsTruncated;
    textTruncated ||= mainRaw.textTruncated;
    tokens.push(String(mainRaw.docToken ?? ""));
    if (mainRaw.text) texts.push(mainRaw.text);

    // Child frames (iframes, same- and cross-origin — Playwright can evaluate in
    // both). Each is enumerated independently and its refs are frame-qualified
    // ("fN:local") so they never collide. A frame that is mid-navigation, detached,
    // or otherwise unavailable is skipped this turn rather than failing the snapshot.
    for (const f of this.page.frames()) {
      if (f === main) continue;
      if (remaining <= 0) { elementsTruncated = true; break; }
      const id = this.frameIdOf(f);
      try {
        const raw = await f.evaluate(enumerateInFrame, { maxElements: remaining, maxText: MAX_TEXT_CHARS });
        for (const el of raw.elements) elements.push({ ...(el as unknown as ElementInfo), ref: `f${id}:${String(el.ref)}` });
        remaining -= raw.elements.length;
        elementsTruncated ||= raw.elementsTruncated;
        textTruncated ||= raw.textTruncated;
        tokens.push(`${id}=${String(raw.docToken ?? "")}`);
        if (raw.text.trim()) texts.push(`[frame f${id} — ${frameHost(raw.url)}]\n${raw.text}`);
      } catch {
        /* frame navigating / detached / unavailable — skip it this turn */
      }
    }

    let text = texts.join("\n\n");
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      textTruncated = true;
    }

    return {
      url: main.url(),
      title: mainRaw.title,
      elements,
      text,
      elementsTruncated,
      textTruncated,
      // Aggregate of every frame's per-document token: a reload of ANY frame — or a
      // frame appearing/disappearing — changes this, so agent.ts forces a keyframe
      // and never diffs a replaced document against stale refs.
      docToken: tokens.join("|"),
    };
  }

  /** Resolve a (possibly frame-qualified) ref to a Playwright locator in its frame. */
  private locator(ref: string) {
    const m = /^f(\d+):(\d+)$/.exec(ref);
    if (m) {
      const frame = this.frameById.get(Number(m[1]));
      if (frame && !frame.isDetached()) return frame.locator(`[data-sk-ref="${m[2]}"]`);
      // The frame is gone (detached / navigated away): return a locator that matches
      // nothing, so the action fails cleanly and the agent re-snapshots and replans.
      return this.page.mainFrame().locator(`[data-sk-ref="__detached_frame__"]`);
    }
    return this.page.mainFrame().locator(`[data-sk-ref="${ref}"]`);
  }

  async click(ref: string): Promise<ActionResult> {
    try {
      await this.locator(ref).click({ timeout: ACTION_TIMEOUT_MS });
      await this.settle();
      return { ok: true, detail: `clicked element ${ref}` };
    } catch (e) {
      return { ok: false, detail: `click failed on ${ref}: ${errMsg(e)}` };
    }
  }

  async type(ref: string, text: string, submit: boolean): Promise<ActionResult> {
    try {
      const loc = this.locator(ref);
      await loc.fill(text, { timeout: ACTION_TIMEOUT_MS });
      if (submit) {
        await loc.press("Enter");
        await this.settle();
      }
      return { ok: true, detail: `typed into element ${ref}${submit ? " and submitted" : ""}` };
    } catch (e) {
      return { ok: false, detail: `type failed on ${ref}: ${errMsg(e)}` };
    }
  }

  async selectOption(ref: string, value: string): Promise<ActionResult> {
    try {
      // Try by value, then fall back to visible label.
      const loc = this.locator(ref);
      try {
        await loc.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
      } catch {
        await loc.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS });
      }
      // Parity with click/type: a <select onchange> can navigate (a jump menu), so
      // let it commit before the caller snapshots.
      await this.settle();
      return { ok: true, detail: `selected ${JSON.stringify(value)} in element ${ref}` };
    } catch (e) {
      return { ok: false, detail: `select failed on ${ref}: ${errMsg(e)}` };
    }
  }

  async scroll(direction: "up" | "down"): Promise<ActionResult> {
    const dy = direction === "up" ? -800 : 800;
    await this.page.mouse.wheel(0, dy);
    await this.page.waitForTimeout(400);
    return { ok: true, detail: `scrolled ${direction}` };
  }

  async goBack(): Promise<ActionResult> {
    const before = this.page.url();
    try {
      await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
      await this.settle();
      // page.goBack resolves to null (no throw) when there is no history entry; the
      // URL is unchanged in that case, so report it honestly rather than "navigated".
      if (this.page.url() === before) return { ok: false, detail: "no previous page to return to" };
      return { ok: true, detail: "navigated back" };
    } catch (e) {
      return { ok: false, detail: `go_back failed: ${errMsg(e)}` };
    }
  }

  /**
   * WebMCP: pages in the Chrome origin trial expose typed tools to agents instead
   * of requiring click/type. The registration shim is injected into EVERY document
   * (see addInitScript), so an embedded frame can register tools too — we read each
   * frame's registry and tag every tool with its owning frame's stable id, so a
   * call routes back to the right document. Main-frame tools carry frameId 0.
   */
  async detectWebMcpTools(): Promise<Array<{ frameId: number; name: string; description: string; inputSchema: unknown }>> {
    const out: Array<{ frameId: number; name: string; description: string; inputSchema: unknown }> = [];
    for (const f of this.page.frames()) {
      try {
        const tools = await f.evaluate(() => {
          const g = globalThis as unknown as { __webmcp_tools?: Record<string, { name: string; description?: string; inputSchema?: unknown }> };
          const reg = g.__webmcp_tools;
          if (!reg) return [];
          return Object.values(reg).map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          }));
        });
        if (!tools.length) continue;
        const frameId = this.frameIdOf(f);
        for (const t of tools) out.push({ frameId, ...t });
      } catch {
        /* frame navigating / detached — skip its tools this turn */
      }
    }
    return out;
  }

  async callWebMcpTool(frameId: number, name: string, args: Record<string, unknown>): Promise<ActionResult> {
    const frame = frameId === 0 ? this.page.mainFrame() : this.frameById.get(frameId);
    if (!frame || frame.isDetached()) {
      return { ok: false, detail: `the frame that provided tool "${name}" is no longer on the page` };
    }
    try {
      const result = await frame.evaluate(
        async ({ n, a }) => {
          // The result string is page-controlled: cap it in the page world so a
          // hostile tool can't ship megabytes across the boundary, ballooning the
          // observation (and with it every later model call).
          const cap = (s: string): string => (s.length > 4000 ? s.slice(0, 4000) : s);
          const g = globalThis as unknown as { __webmcp_tools?: Record<string, { execute: (x: unknown) => unknown }> };
          const tool = g.__webmcp_tools?.[n];
          if (!tool) return { ok: false, detail: `no page tool named "${n}"` };
          const res = await tool.execute(a);
          if (res && typeof res === "object") {
            const r = res as { ok?: boolean; message?: string };
            return { ok: r.ok !== false, detail: cap(String(r.message ?? JSON.stringify(res))) };
          }
          return { ok: true, detail: cap(String(res)) };
        },
        { n: name, a: args },
      );
      await this.settle();
      const r = result as ActionResult;
      return r.detail.length > 2000 ? { ok: r.ok, detail: r.detail.slice(0, 2000) + "… [result truncated]" } : r;
    } catch (e) {
      return { ok: false, detail: `webmcp call "${name}" failed: ${errMsg(e)}` };
    }
  }

  /**
   * Return the URLs of any popups/new tabs opened since the last drain, and close
   * them. The agent only drives the main page, so a popup is either an escape hatch
   * around the guardrail (the caller enforces policy on the returned URLs) or dead
   * weight — either way it gets closed here.
   */
  async drainPopups(): Promise<string[]> {
    const popups = this.popups;
    this.popups = [];
    const urls = await Promise.all(
      popups.map(async (p) => {
        try {
          if (p.isClosed()) return "";
          await p.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
          const url = p.isClosed() ? "" : p.url();
          if (!p.isClosed()) await p.close();
          return url;
        } catch {
          return "";
        }
      }),
    );
    return urls.filter(Boolean);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
