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

  static async launch(opts: BrowserOptions): Promise<BrowserSession> {
    const s = new BrowserSession();
    s.browser = await chromium.launch({ headless: opts.headless });
    s.context = await s.browser.newContext({ viewport: { width: 1280, height: 800 } });
    // The dev runner (tsx/esbuild) rewrites page.evaluate callbacks with __name()
    // calls to preserve function names; those helpers don't exist in the page, so
    // define a no-op shim. Harmless after a `tsc` build, required under tsx.
    await s.context.addInitScript(() => {
      (globalThis as unknown as { __name?: (fn: unknown) => unknown }).__name ??= (fn) => fn;
    });
    s.page = await s.context.newPage();
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
        document
          .querySelectorAll("[data-sk-ref]")
          .forEach((el) => el.removeAttribute("data-sk-ref"));

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
          const value = (el as HTMLInputElement).value;
          if (value) return value.trim();
          return "";
        };

        const elements: Array<Record<string, unknown>> = [];
        let elementsTruncated = false;
        let ref = 0;

        for (const el of Array.from(document.querySelectorAll(interactiveSelector))) {
          if (!isVisible(el)) continue;
          if (elements.length >= maxElements) {
            elementsTruncated = true;
            break;
          }
          el.setAttribute("data-sk-ref", String(ref));
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
            if (value) info.value = value.slice(0, 80);
          }
          elements.push(info);
          ref++;
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
    try {
      await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 });
      await this.settle();
      return { ok: true, detail: "navigated back" };
    } catch (e) {
      return { ok: false, detail: `go_back failed: ${errMsg(e)}` };
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
