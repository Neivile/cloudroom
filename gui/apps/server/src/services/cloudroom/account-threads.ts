// MacBook fork: shows the Cloud threads this account started on its other computers (say, the Windows PC).
//
// The account's thread list lives behind the phone relay (/__cloud/threads), which takes a phone session. This
// pairs like the phone does, with this Mac's own relay credential, checks the session belongs to the signed-in
// account, then adopts each listed thread this Mac does not have yet (CloudroomService.adoptAccountThread). Adopted
// threads are normal Cloud threads: sends, photos, files, stop and history use the official code paths.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerAppDeps as Deps } from "../../types.js";
import type { PluginService } from "../plugins/plugin-service.js";
import { cloudroom } from "./commands.js";

const EVERY_MS = 60_000;
const SESSION_MS = 50 * 60_000;

type Credential = { serverUrl: string; credential: string };
type Session = { owner: string; origin: string; cookie: string; expires: number };
type Summary = { thread_id: string; title: string | null; project_id: string | null; project_name: string | null };

/** Only Cloudroom's own relay hosts, over HTTPS, without credentials or ports in the URL. */
function relayUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !(url.hostname === "cloudroom.run" || url.hostname.endsWith(".cloudroom.run")) || url.username || url.password || url.port) {
    throw new Error("Invalid relay host");
  }
  return url;
}

export function startAccountThreads(deps: Deps, plugins: PluginService, network: typeof fetch = fetch): () => void {
  let session: Session | null = null;
  let running = false;

  const owner = async (): Promise<string | null> => {
    const text = await readFile(join(deps.config.dataDir, "cloudroom.json"), "utf8").catch(() => "{}");
    const id = (JSON.parse(text) as { account?: { id?: unknown } }).account?.id;
    return typeof id === "string" && id ? id : null;
  };

  const credential = async (): Promise<Credential> => {
    const lookup = plugins.getRpcHandler("connect", "relayCredential");
    if (lookup.outcome !== "found") throw new Error("Connect unavailable");
    const result = await plugins.invokeRpcHandler("connect", "relayCredential", lookup.value, null, null as never);
    if (!result.ok) throw new Error("Connect unavailable");
    const value = result.result as Partial<Credential> | null;
    if (typeof value?.serverUrl !== "string" || typeof value.credential !== "string") throw new Error("Connect unavailable");
    return value as Credential;
  };

  const pair = async (account: string): Promise<Session> => {
    const key = await credential();
    const base = relayUrl(key.serverUrl).origin.replace(/\/\/[^.]+\./, "//");
    const code = await network(`${base}/api/phone-code`, { method: "POST", headers: { authorization: `Bearer ${key.credential}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000) });
    if (!code.ok) throw new Error("Pairing unavailable");
    let next = (await code.json() as { url: string }).url;
    for (let hop = 0; hop < 4; hop++) {
      const url = relayUrl(next);
      const response = await network(url.href, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      const cookie = response.headers.getSetCookie().find(value => !value.startsWith("__cf"))?.split(";")[0];
      if (cookie) {
        const token = cookie.slice(cookie.indexOf("=") + 1);
        const check = await network(`${base}/api/phone-session`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
        if (!check.ok || (await check.json() as { userId?: string }).userId !== account) throw new Error("Account mismatch");
        return { owner: account, origin: url.origin, cookie, expires: Date.now() + SESSION_MS };
      }
      const location = response.headers.get("location");
      if (!location) break;
      next = new URL(location, url).href;
    }
    throw new Error("Pairing did not complete");
  };

  const list = async (account: string): Promise<Summary[]> => {
    if (session?.owner !== account || session.expires < Date.now()) session = await pair(account);
    const response = await network(`${session.origin}/__cloud/threads`, { headers: { cookie: session.cookie, origin: session.origin, accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) {
      session = null;
      throw new Error(`Account threads unavailable (HTTP ${response.status})`);
    }
    return (await response.json() as { threads?: Summary[] }).threads ?? [];
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const account = await owner();
      if (!account) { session = null; return; }
      const service = cloudroom(deps);
      for (const entry of await list(account)) {
        if (await owner() !== account) return;
        await service.adoptAccountThread({ thread: entry.thread_id, title: entry.title, projectId: entry.project_id, projectName: entry.project_name })
          .catch((error: unknown) => deps.logger.warn({ threadId: entry.thread_id, error: error instanceof Error ? error.message : String(error) }, "MacBook: account thread not adopted"));
      }
    } catch (error) {
      deps.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "MacBook: account threads unavailable");
    } finally {
      running = false;
    }
  };

  const first = setTimeout(() => void tick(), 10_000);
  const timer = setInterval(() => void tick(), EVERY_MS);
  timer.unref?.();
  first.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
