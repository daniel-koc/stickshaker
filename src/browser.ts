import { readFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Locator } from "playwright";
import type { Snapshot, ActionResult, ElementInfo } from "./types.js";

const MAX_ELEMENTS = 150;
const MAX_TEXT_CHARS = 6000;
const ACTION_TIMEOUT_MS = 8000;
const EVAL_DEADLINE_MS = 10000;

export interface BrowserOptions {
  headless: boolean;
  /**
   * Path to a Playwright storage-state JSON file (cookies + localStorage), applied
   * when the context is created — an authenticated session from the first request.
   * The file holds credentials by definition, so its VALUES are never kept, logged,
   * or attached to an error here; callers that record anything record the path.
   */
  storageState?: string | undefined;
  /**
   * Child-frame admission check. A frame whose URL fails it is not enumerated
   * (a visible note marks the omission), its text never reaches the snapshot,
   * and its page-provided tools are neither detected nor callable. This is how
   * the caller's destination policy extends into embedded documents — without
   * it, an iframe on a denied origin would be a policy-free read. The main
   * frame is exempt: callers enforce main-tab landings themselves (with
   * pull-back and content withholding, which need the snapshot to exist).
   */
  frameAllowed?: ((url: string) => boolean) | undefined;
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
 * Bound a page-world evaluation. Page code participates in these promises — a
 * WebMCP tool's execute() is page code by definition, an iframe can simply never
 * finish loading, and enumeration touches page-overridable DOM accessors — so
 * without a deadline a hostile or broken page can hang the promise forever,
 * wedging the agent loop (and the MCP server's serialized handler chain, where
 * every later call queues behind the stuck one). Rejects on timeout instead;
 * the losing promise is silenced so a late settlement can't crash the process.
 */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      p.catch(() => {});
      reject(new Error(`${what} did not complete within ${ms / 1000}s`));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
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
  private frameAllowed?: ((url: string) => boolean) | undefined;
  private popups: Page[] = [];
  // Stable frame ids across turns. Frame object identity is stable until a frame
  // detaches, so a ref like "f2:5" points to the same frame next turn.
  private frameIds = new Map<Frame, number>();
  private frameById = new Map<number, Frame>();
  private nextChildFrameId = 1;

  static async launch(opts: BrowserOptions): Promise<BrowserSession> {
    // Validate the storage state up front: Playwright would eventually throw on a
    // bad file, but the error should name the actual problem before any browser
    // launches — and a WRONG file (say, a package.json) must fail loudly rather
    // than silently yield an unauthenticated session. Parsed only for its shape;
    // the contents are credentials and are deliberately not kept or echoed.
    if (opts.storageState) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(opts.storageState, "utf8"));
      } catch (e) {
        throw new Error(`cannot load storage state file ${opts.storageState}: ${errMsg(e)}`);
      }
      const shape = parsed as { cookies?: unknown; origins?: unknown } | null;
      if (
        shape === null || typeof shape !== "object" || Array.isArray(shape) ||
        (shape.cookies === undefined && shape.origins === undefined) ||
        (shape.cookies !== undefined && !Array.isArray(shape.cookies)) ||
        (shape.origins !== undefined && !Array.isArray(shape.origins))
      ) {
        throw new Error(`${opts.storageState} does not look like a Playwright storage state file (expected a JSON object with "cookies" / "origins" arrays)`);
      }
    }
    const s = new BrowserSession();
    s.frameAllowed = opts.frameAllowed;
    s.browser = await chromium.launch({ headless: opts.headless });
    s.context = await s.browser.newContext({
      viewport: { width: 1280, height: 800 },
      ...(opts.storageState ? { storageState: opts.storageState } : {}),
    });
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
    // Prune the frame-id maps when a frame detaches. Detached frames can never be
    // located again (locator/callWebMcpTool treat a missing id exactly like a
    // detached one), so keeping them would only leak Frame objects — which matters
    // in the long-lived MCP server, where one session may cross thousands of pages.
    s.page.on("framedetached", (f) => {
      const id = s.frameIds.get(f);
      if (id !== undefined) {
        s.frameIds.delete(f);
        s.frameById.delete(id);
      }
    });
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
    const mainRaw = await withDeadline(
      main.evaluate(enumerateInFrame, { maxElements: remaining, maxText: MAX_TEXT_CHARS }),
      EVAL_DEADLINE_MS,
      "page snapshot",
    );
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
    // Every frame is visited even once the element budget is spent — its text and
    // doc token must still be collected (skipping a frame would both drop its text
    // and churn the aggregate docToken, forcing spurious keyframes), and the in-page
    // walk sets the truncated flag only if a visible element actually got cut.
    for (const f of this.page.frames()) {
      if (f === main) continue;
      // Policy extension into embedded documents: a frame on a disallowed origin
      // is omitted entirely — no elements, no text, no ref-map entry — with a
      // note so the model (and the trace reader) can see something was withheld.
      if (this.frameAllowed && !this.frameAllowed(f.url())) {
        texts.push(`[an embedded frame on ${frameHost(f.url())} was omitted by policy]`);
        continue;
      }
      const id = this.frameIdOf(f);
      try {
        const raw = await withDeadline(
          f.evaluate(enumerateInFrame, { maxElements: Math.max(0, remaining), maxText: MAX_TEXT_CHARS }),
          EVAL_DEADLINE_MS,
          `frame f${id} snapshot`,
        );
        for (const el of raw.elements) elements.push({ ...(el as unknown as ElementInfo), ref: `f${id}:${String(el.ref)}` });
        remaining -= raw.elements.length;
        elementsTruncated ||= raw.elementsTruncated;
        textTruncated ||= raw.textTruncated;
        tokens.push(`${id}=${String(raw.docToken ?? "")}`);
        if (raw.text.trim()) texts.push(`[frame f${id} — ${frameHost(raw.url)}]\n${raw.text}`);
      } catch {
        /* frame navigating / detached / unavailable / stuck loading — skip it this turn */
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

  /**
   * Resolve a (possibly frame-qualified) ref to a locator in its frame, enforcing
   * frame liveness and the frame policy. Fast, specific errors beat an 8s
   * no-match timeout: the agent re-snapshots and replans immediately.
   */
  private resolveRef(ref: string): { loc: Locator } | { err: string } {
    const m = /^f(\d+):(\d+)$/.exec(ref);
    if (!m) return { loc: this.page.mainFrame().locator(`[data-sk-ref="${ref}"]`) };
    const frame = this.frameById.get(Number(m[1]));
    if (!frame || frame.isDetached()) {
      return { err: `the frame for ref ${ref} is no longer on the page — take a fresh snapshot` };
    }
    // A frame can become disallowed after its refs were handed out (it navigated,
    // or the MCP session's origin anchor was set by the first navigate). Actuating
    // into it would be an action on a policy-denied document — refuse, exactly
    // like callWebMcpTool refuses a call into such a frame.
    if (this.frameAllowed && !this.frameAllowed(frame.url())) {
      return { err: `the frame for ref ${ref} is on a policy-denied origin` };
    }
    return { loc: frame.locator(`[data-sk-ref="${m[2]}"]`) };
  }

  async click(ref: string): Promise<ActionResult> {
    const r = this.resolveRef(ref);
    if ("err" in r) return { ok: false, detail: `click failed on ${ref}: ${r.err}` };
    try {
      await r.loc.click({ timeout: ACTION_TIMEOUT_MS });
      await this.settle();
      return { ok: true, detail: `clicked element ${ref}` };
    } catch (e) {
      return { ok: false, detail: `click failed on ${ref}: ${errMsg(e)}` };
    }
  }

  async type(ref: string, text: string, submit: boolean): Promise<ActionResult> {
    const r = this.resolveRef(ref);
    if ("err" in r) return { ok: false, detail: `type failed on ${ref}: ${r.err}` };
    try {
      await r.loc.fill(text, { timeout: ACTION_TIMEOUT_MS });
      if (submit) {
        await r.loc.press("Enter");
        await this.settle();
      }
      return { ok: true, detail: `typed into element ${ref}${submit ? " and submitted" : ""}` };
    } catch (e) {
      return { ok: false, detail: `type failed on ${ref}: ${errMsg(e)}` };
    }
  }

  async selectOption(ref: string, value: string): Promise<ActionResult> {
    const r = this.resolveRef(ref);
    if ("err" in r) return { ok: false, detail: `select failed on ${ref}: ${r.err}` };
    try {
      // Try by value, then fall back to visible label.
      try {
        await r.loc.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
      } catch {
        await r.loc.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS });
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
    try {
      await this.page.mouse.wheel(0, dy);
      await this.page.waitForTimeout(400);
      return { ok: true, detail: `scrolled ${direction}` };
    } catch (e) {
      return { ok: false, detail: `scroll failed: ${errMsg(e)}` };
    }
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
      // A policy-omitted frame's tools are attacker-controlled metadata from a
      // document the policy excludes — never offer them.
      if (f !== this.page.mainFrame() && this.frameAllowed && !this.frameAllowed(f.url())) continue;
      try {
        const tools = await withDeadline(
          f.evaluate(() => {
            const g = globalThis as unknown as { __webmcp_tools?: Record<string, { name: string; description?: string; inputSchema?: unknown }> };
            const reg = g.__webmcp_tools;
            if (!reg) return [];
            return Object.values(reg).map((t) => ({
              name: t.name,
              description: t.description ?? "",
              inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            }));
          }),
          EVAL_DEADLINE_MS,
          "page-tool detection",
        );
        if (!tools.length) continue;
        const frameId = this.frameIdOf(f);
        for (const t of tools) out.push({ frameId, ...t });
      } catch {
        /* frame navigating / detached / stuck — skip its tools this turn */
      }
    }
    return out;
  }

  async callWebMcpTool(frameId: number, name: string, args: Record<string, unknown>, deadlineMs = EVAL_DEADLINE_MS): Promise<ActionResult> {
    const frame = frameId === 0 ? this.page.mainFrame() : this.frameById.get(frameId);
    if (!frame || frame.isDetached()) {
      return { ok: false, detail: `the frame that provided tool "${name}" is no longer on the page` };
    }
    // A frame can become disallowed after its id was handed out (the MCP session's
    // origin anchor is set by the first navigate, or the frame itself navigated), so
    // re-check here even though detection already skipped it — refuse, don't execute.
    if (frameId !== 0 && this.frameAllowed && !this.frameAllowed(frame.url())) {
      return { ok: false, detail: `the frame that provided tool "${name}" is on a policy-denied origin` };
    }
    try {
      // execute() is page code: the deadline turns a tool that never settles (a
      // promise-that-never-resolves DoS) into an ordinary failed action.
      const result = await withDeadline(
        frame.evaluate(
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
        ),
        deadlineMs,
        `page tool "${name}"`,
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
