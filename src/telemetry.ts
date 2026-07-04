import { context, trace, SpanStatusCode, type Span, type Tracer } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { appendFileSync, writeFileSync } from "node:fs";

function hrToMs(hr: [number, number]): number {
  return hr[0] * 1000 + hr[1] / 1e6;
}

/** Writes OpenTelemetry spans to a JSONL file — real OTel, zero collector infra. */
class FileSpanExporter {
  constructor(private readonly path: string) {
    writeFileSync(path, "");
  }
  export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): void {
    try {
      for (const s of spans) {
        const parent = s as unknown as { parentSpanContext?: { spanId?: string }; parentSpanId?: string };
        appendFileSync(
          this.path,
          JSON.stringify({
            name: s.name,
            traceId: s.spanContext().traceId,
            spanId: s.spanContext().spanId,
            parentSpanId: parent.parentSpanContext?.spanId ?? parent.parentSpanId ?? null,
            startMs: hrToMs(s.startTime),
            durationMs: hrToMs(s.duration),
            attributes: s.attributes,
            status: s.status,
          }) + "\n",
        );
      }
      resultCallback({ code: 0 });
    } catch {
      resultCallback({ code: 1 });
    }
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Telemetry {
  tracer: Tracer;
  shutdown: () => Promise<void>;
}

/** Best-effort: on any OTel setup error, fall back to a no-op tracer. */
export function initTelemetry(spansPath: string): Telemetry {
  try {
    const exporter = new FileSpanExporter(spansPath) as unknown as SpanExporter;
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    return { tracer: provider.getTracer("stickshaker"), shutdown: () => provider.shutdown() };
  } catch {
    return { tracer: trace.getTracer("stickshaker-noop"), shutdown: () => Promise.resolve() };
  }
}

export { context, trace, SpanStatusCode };
export type { Span };
