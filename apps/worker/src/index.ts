import { buildApi } from "./api/index.ts";
import { runCron } from "./cron.ts";
import type { Env } from "./env.ts";
import { handleInbound } from "./mail/receive.ts";

export { UserHub } from "./hub.ts";

const api = buildApi();

// Defense-in-depth for the app shell: even with mail bodies isolated in a
// sandboxed iframe, a CSP blunts XSS from any *other* vector (our own code, a
// compromised dep). Everything the SPA loads is same-origin — hashed Vite
// modules, one stylesheet, SSE/fetch to /api, the service worker + manifest,
// and the srcdoc body frame — so the only non-'self' needs are inline styles
// (React `style=` props, base-ui) and `data:` images/fonts.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

// The app shell carries no security headers of its own; attach them as the
// asset response streams back. Headers from `ASSETS.fetch` are immutable, so
// re-wrap before mutating.
function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  out.headers.set("Content-Security-Policy", CSP);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  out.headers.set("X-Frame-Options", "DENY");
  return out;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      return api.fetch(req, env, ctx);
    }
    return withSecurityHeaders(await env.ASSETS.fetch(req));
  },

  async email(msg: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleInbound(msg, env, ctx);
  },

  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, new Date()));
  },
} satisfies ExportedHandler<Env>;
