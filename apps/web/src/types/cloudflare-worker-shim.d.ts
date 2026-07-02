// Ambient stand-ins for Cloudflare Workers runtime types referenced by
// @cfmail/worker sources. The web app imports the worker's route schema
// type-only (`hc<AppType>` — see lib/api.ts), which pulls worker sources into
// this package's type program. The worker's own typecheck uses the real
// `@cloudflare/workers-types`; here the names only need to resolve — the web
// app never touches these values, so loose shapes are fine. Callback-taking
// members get explicit signatures so worker handler params keep a contextual
// type (no implicit-any errors); everything else rides an index signature.

interface D1Database {
  [key: string]: any;
  prepare(sql: string): D1PreparedStatementShim;
}
interface D1PreparedStatementShim {
  [key: string]: any;
  bind(...values: unknown[]): D1PreparedStatementShim;
  all<T = unknown>(): Promise<{ results?: T[]; [key: string]: any }>;
  first<T = unknown>(): Promise<T | null>;
  run<T = unknown>(): Promise<{ results?: T[]; [key: string]: any }>;
  raw<T = unknown>(): Promise<T[]>;
}

interface R2Bucket {
  [key: string]: any;
  list(options?: any): Promise<{ [key: string]: any; objects: any[] }>;
}
interface SendEmail {
  [key: string]: any;
}
interface DurableObjectNamespace {
  [key: string]: any;
}
interface Fetcher {
  [key: string]: any;
}
interface Ai {
  [key: string]: any;
}

interface HTMLRewriterContentHandlersShim {
  element?(element: any): void | Promise<void>;
  comments?(comment: any): void | Promise<void>;
  text?(text: any): void | Promise<void>;
  doctype?(doctype: any): void | Promise<void>;
  end?(end: any): void | Promise<void>;
}
declare class HTMLRewriter {
  on(selector: string, handlers: HTMLRewriterContentHandlersShim): HTMLRewriter;
  onDocument(handlers: HTMLRewriterContentHandlersShim): HTMLRewriter;
  transform(response: Response): Response;
}

declare module "cloudflare:workers" {
  export class DurableObject<TEnv = unknown> {
    [key: string]: any;
    constructor(...args: any[]);
    ctx: any;
    env: TEnv;
    fetch(request: Request): Response | Promise<Response>;
    alarm(): void | Promise<void>;
  }
}

declare module "cloudflare:email" {
  export class EmailMessage {
    [key: string]: any;
    constructor(from: string, to: string, raw: unknown);
    readonly from: string;
    readonly to: string;
  }
}
