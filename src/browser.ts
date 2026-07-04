import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Snapshot, ActionResult } from "./types.js";

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
 * Thin wrapper over a Playwright Chromium session.
 *
 * Snapshotting enumerates visible interactive elements and stamps each with a
 * `data-sk-ref` attribute, so the agent can act on an element by its ref number.
 * Refs are re-assigned on every snapshot for now; the diff engine makes them stable
 * across turns so successive snapshots can be diffed instead of re-sent.
 */
export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;
  private popups: Page[] = [];

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
    const raw = await this.page.evaluate(
      ({ maxElements, maxText }) => {
        // Stable refs: keep any ref already on a node; only new nodes get a new
        // number. So the same element carries the same [ref] across turns, which
        // is what lets successive snapshots be diffed by ref.
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

        for (const el of Array.from(document.querySelectorAll(interactiveSelector))) {
          if (!isVisible(el)) continue;
          if (elements.length >= maxElements) {
            elementsTruncated = true;
            break;
          }
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
        }

        const fullText = ((document.body?.innerText ?? "") as string)
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
      },
      { maxElements: MAX_ELEMENTS, maxText: MAX_TEXT_CHARS },
    );

    return raw as unknown as Snapshot;
  }

  private locator(ref: number) {
    return this.page.locator(`[data-sk-ref="${ref}"]`);
  }

  async click(ref: number): Promise<ActionResult> {
    try {
      await this.locator(ref).click({ timeout: ACTION_TIMEOUT_MS });
      await this.settle();
      return { ok: true, detail: `clicked element ${ref}` };
    } catch (e) {
      return { ok: false, detail: `click failed on ${ref}: ${errMsg(e)}` };
    }
  }

  async type(ref: number, text: string, submit: boolean): Promise<ActionResult> {
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

  async selectOption(ref: number, value: string): Promise<ActionResult> {
    try {
      // Try by value, then fall back to visible label.
      const loc = this.locator(ref);
      try {
        await loc.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
      } catch {
        await loc.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS });
      }
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
   * of requiring click/type. We read the registry a WebMCP page maintains (the
   * origin-trial API populates it via navigator.modelContext / window.agent) and
   * return each tool's metadata; calling one runs the page's own handler.
   */
  async detectWebMcpTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    try {
      return await this.page.evaluate(() => {
        const g = globalThis as unknown as { __webmcp_tools?: Record<string, { name: string; description?: string; inputSchema?: unknown }> };
        const reg = g.__webmcp_tools;
        if (!reg) return [];
        return Object.values(reg).map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object", properties: {} },
        }));
      });
    } catch {
      return [];
    }
  }

  async callWebMcpTool(name: string, args: Record<string, unknown>): Promise<ActionResult> {
    try {
      const result = await this.page.evaluate(
        async ({ n, a }) => {
          const g = globalThis as unknown as { __webmcp_tools?: Record<string, { execute: (x: unknown) => unknown }> };
          const tool = g.__webmcp_tools?.[n];
          if (!tool) return { ok: false, detail: `no page tool named "${n}"` };
          const res = await tool.execute(a);
          if (res && typeof res === "object") {
            const r = res as { ok?: boolean; message?: string };
            return { ok: r.ok !== false, detail: String(r.message ?? JSON.stringify(res)) };
          }
          return { ok: true, detail: String(res) };
        },
        { n: name, a: args },
      );
      await this.settle();
      return result as ActionResult;
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
