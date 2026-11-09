// MacBook fork: Cloud threads started on another computer of the same account are adopted as normal Cloud threads.
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { cloudroom } from "../../src/services/cloudroom/commands.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import { PERSONAL_PROJECT_ID } from "@cloudroom/domain";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { cloudroomThreads, getThread } from "@cloudroom/db";
import { eq } from "drizzle-orm";

vi.mock("../../src/services/cloudroom/sandboxes.js", async (original) => ({ ...await original<object>(), cursorKeyRejected: async () => false }));

const listen = async (server: ReturnType<typeof createServer>) => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture did not listen");
  return `http://127.0.0.1:${address.port}`;
};

it("adopts awake threads from the account's other computers into the matching project, and leaves the rest alone", async () => {
  const harness = await createTestAppHarness();
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const service = cloudroom(harness.deps);
  const awake = new Set(["thr_windows1", "thr_windows2"]);
  let coreUrl = "";
  let main = "cr_main";
  const coreServer = createServer((req, res) => {
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.url === "/v1/sessions" && req.method === "GET") return json({ total: 3, sessions: [
      { session_id: "cr_old", harness: "codex", model: "gpt", provider: null, state: "closed", workspace: null, parent_session: null, current_request: null, queued: 0, last_sequence: 1, last_activity_ms: 300 },
      { session_id: main, harness: "claude-code", model: "claude-opus-5-5", provider: null, state: "idle", workspace: null, parent_session: null, current_request: null, queued: 0, last_sequence: 9, last_activity_ms: 200 },
      { session_id: "cr_child_x", harness: "codex", model: "gpt", provider: null, state: "idle", workspace: null, parent_session: "cr_main", current_request: null, queued: 0, last_sequence: 2, last_activity_ms: 400 },
    ] });
    if (req.url?.includes("/stream")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(); return; }
    return json({}, 404);
  });
  const websiteServer = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const input = text ? JSON.parse(text) : {};
    const json = (value: unknown) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (input.action === "awake") return json({ sandboxes: [...awake].map(thread => ({ thread, origin: coreUrl, token: "t".repeat(64) })) });
    return json({ thread: input.thread, state: "asleep", generation: 0, issue: null });
  });
  coreUrl = await listen(coreServer);
  const websiteUrl = await listen(websiteServer);
  try {
    await service.configure(null, { id: "11111111-1111-4111-8111-111111111111", email: "a@example.com" }, undefined, websiteUrl, "a".repeat(64));

    // The other computer's project id is unknown here; the project with the same name is used.
    expect(await service.adoptAccountThread({ thread: "thr_windows1", title: "DATACRAZY FLUXO", projectId: "proj_fromwindows", projectName: project.name.toUpperCase() })).toBe("adopted");
    const adopted = getThread(harness.deps.db, "thr_windows1")!;
    expect(adopted).toMatchObject({ executionTarget: "cloud", projectId: project.id, providerId: "claude-code", title: "DATACRAZY FLUXO" });
    // The open root session, not a closed one or a child.
    expect(harness.deps.db.select().from(cloudroomThreads).where(eq(cloudroomThreads.threadId, "thr_windows1")).get()).toMatchObject({ coreUrl: "sandbox:thr_windows1", sessionId: "cr_main", model: "claude-opus-5-5" });

    // Known threads are never touched again; sleeping sandboxes are never woken.
    expect(await service.adoptAccountThread({ thread: "thr_windows1", title: "Other", projectId: null, projectName: null })).toBe("known");
    expect(getThread(harness.deps.db, "thr_windows1")?.title).toBe("DATACRAZY FLUXO");
    expect(await service.adoptAccountThread({ thread: "thr_sleeping", title: "Asleep", projectId: null, projectName: null })).toBe("asleep");
    expect(getThread(harness.deps.db, "thr_sleeping")).toBeNull();

    // No matching project: the personal project.
    main = "cr_main2";
    expect(await service.adoptAccountThread({ thread: "thr_windows2", title: "Elsewhere", projectId: null, projectName: "unknown" })).toBe("adopted");
    expect(getThread(harness.deps.db, "thr_windows2")?.projectId).toBe(PERSONAL_PROJECT_ID);
  } finally {
    coreServer.close(); websiteServer.close();
    await harness.cleanup();
  }
});
