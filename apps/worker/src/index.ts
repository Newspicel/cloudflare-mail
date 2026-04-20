import { buildApi } from "./api/index.ts";
import { runCron } from "./cron.ts";
import type { Env } from "./env.ts";
import { handleInbound } from "./mail/receive.ts";

export { UserHub } from "./hub.ts";

const api = buildApi();

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      return api.fetch(req, env, ctx);
    }
    return env.ASSETS.fetch(req);
  },

  async email(msg: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleInbound(msg, env);
  },

  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env, new Date()));
  },
} satisfies ExportedHandler<Env>;
