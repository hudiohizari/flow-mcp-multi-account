#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getConfig } from "./config.js";
import { LocalCore, shapes, type Core } from "./core.js";
import { registerAccountTools } from "./mcp-accounts.js";
import { createPatienceRunner } from "./mcp-patience.js";
import { PLAYBOOK } from "./playbook.js";
import { RemoteCore } from "./remote.js";
import { startOwnerServer } from "./server.js";

const cfg = getConfig();
const local = new LocalCore();
const handle = await startOwnerServer(local, {
  getCastDir: () => local.getActiveCastDir(),
  getRegistryError: () => local.getRegistryError(),
});
const core: Core = handle.role === "client" ? new RemoteCore() : local;
const studio = handle.role === "none" ? undefined : `http://127.0.0.1:${cfg.port}`;

if (handle.role === "owner") {
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.allSettled([handle.close(), local.close()]).then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

const server = new McpServer({ name: "flow-mcp", version: "0.2.0" });
const { reply, patient, waitFor, slowCalls, hasSlowCalls } = createPatienceRunner(core, cfg.patienceMs);

registerAccountTools(server, core, { reply, patient });

server.registerTool(
  "flow_status",
  {
    title: "Flow status",
    description:
      "Check the Flow Chrome session (signed in, project open, plan, credits left) and the generation queue. Call this first; it says what the user must fix before generating, and returns the prompt playbook.",
    inputSchema: shapes.status,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) =>
    reply(core.status(args), {
      studio,
      playbook: PLAYBOOK,
      ...(hasSlowCalls() ? { slow_calls: slowCalls() } : {}),
    }),
);

server.registerTool(
  "flow_generate",
  {
    title: "Queue Flow generations",
    description:
      "Queue one clip or image per scene in the open Flow project. Runs one at a time with human-like pauses and spends Google AI credits within max_credits. Returns job ids immediately; use flow_wait for results.",
    inputSchema: shapes.generate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.generate(args)),
);

server.registerTool(
  "flow_wait",
  {
    title: "Wait for Flow jobs",
    description:
      "Wait for queued jobs (default: all), or for the task_id of a call that answered still_working, then return their status, results and file paths.",
    inputSchema: shapes.wait,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(waitFor(args)),
);

server.registerTool(
  "flow_cancel",
  {
    title: "Cancel a queued Flow job",
    description: "Cancel a job that has not started yet. A running generation cannot be cancelled.",
    inputSchema: shapes.cancel,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  (args) => reply(core.cancel(args)),
);

server.registerTool(
  "flow_retry",
  {
    title: "Retry failed Flow jobs",
    description: "Put failed jobs back in the queue with the same settings and file names for the active account.",
    inputSchema: shapes.retry,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.retry(args)),
);

server.registerTool(
  "flow_assets",
  {
    title: "List project media",
    description: "List the images and videos in the open Flow project (title and kind).",
    inputSchema: shapes.assets,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_assets", core.assets(args))),
);

server.registerTool(
  "flow_download",
  {
    title: "Download existing project media",
    description: "Download media that already exists in the Flow project without regenerating it.",
    inputSchema: shapes.download,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  (args) => reply(patient("flow_download", core.download(args))),
);

server.registerTool(
  "flow_agent_images",
  {
    title: "Fast image batch via Flow's agent",
    description: "Hand up to 50 image scenes to Flow's Agent mode and download the finished collection ZIP.",
    inputSchema: shapes.agent,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.agent(args)),
);

server.registerTool(
  "flow_edit",
  {
    title: "Edit an existing video",
    description: "Video-to-video edit of a clip already in the Flow project. Queued like a generation; use flow_wait for the file.",
    inputSchema: shapes.edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(core.edit(args)),
);

server.registerTool(
  "flow_continue",
  {
    title: "Continue a clip, keeping a character attached",
    description: "Start a new clip from the last frame of one already in the project using Flow's agent mode.",
    inputSchema: shapes.continue_shot,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_continue", core.continue_shot(args))),
);

server.registerTool(
  "flow_trash",
  {
    title: "Move an item to Flow's Trash",
    description: "Move one image, video or scene in the open Flow project to Flow's Trash by exact title.",
    inputSchema: shapes.trash,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_trash", core.trash(args))),
);

server.registerTool(
  "flow_character",
  {
    title: "Create a reusable character",
    description: "Create a reusable Flow character (person, mascot, product). Free.",
    inputSchema: shapes.character,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_character", core.character(args))),
);

server.registerTool(
  "flow_character_edit",
  {
    title: "Restyle an existing character",
    description: "Change how an existing character looks in place and save the new portrait.",
    inputSchema: shapes.character_edit,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_character_edit", core.character_edit(args))),
);

server.registerTool(
  "flow_new_project",
  {
    title: "Start a new Flow project",
    description: "Create a new, empty Google Flow project and open it in the Flow window.",
    inputSchema: shapes.new_project,
    annotations: { openWorldHint: true },
  },
  (args) => reply(patient("flow_new_project", core.new_project(args))),
);

server.registerTool(
  "flow_characters",
  {
    title: "List characters",
    description: "List the reusable characters in the open Flow project.",
    inputSchema: shapes.characters,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () => reply(patient("flow_characters", core.characters())),
);

server.registerTool(
  "flow_techniques",
  {
    title: "Film technique presets",
    description: "List ready-made prompt phrases for camera moves, product shots, transitions and image commands.",
    inputSchema: shapes.techniques,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(core.techniques(args)),
);

server.registerTool(
  "flow_narrate",
  {
    title: "Record narration",
    description: "Record narration as an .m4a using Kokoro (local) or Gemini TTS.",
    inputSchema: shapes.narrate,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  (args) => reply(patient("flow_narrate", core.narrate(args))),
);

server.registerTool(
  "flow_voices",
  {
    title: "List Flow voices",
    description: "Narrator voices available for flow_narrate (Kokoro and Google AI Studio).",
    inputSchema: shapes.voices,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  () => reply(core.voices()),
);

server.registerTool(
  "flow_assemble",
  {
    title: "Assemble clips into one video",
    description: "Join downloaded scene clips in order into one MP4 with local ffmpeg.",
    inputSchema: shapes.assemble,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  (args) => reply(patient("flow_assemble", core.assemble(args))),
);

server.registerTool(
  "flow_transcribe",
  {
    title: "Hear the words in a video or audio file",
    description: "Transcribe a video or audio file locally with whisper.cpp.",
    inputSchema: shapes.transcribe,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  (args) => reply(patient("flow_transcribe", core.transcribe(args))),
);

server.registerTool(
  "flow_captions",
  {
    title: "Add captions to a video",
    description: "Burn spoken-word captions into a video locally.",
    inputSchema: shapes.captions,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  (args) => reply(patient("flow_captions", core.captions(args))),
);

server.registerTool(
  "flow_presenter",
  {
    title: "Talking presenter over footage",
    description: "Build an explainer from a talking presenter recording over footage.",
    inputSchema: shapes.presenter,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  (args) => reply(patient("flow_presenter", core.presenter(args))),
);

await server.connect(new StdioServerTransport());
