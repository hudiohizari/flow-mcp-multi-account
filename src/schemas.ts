import { z } from "zod";
import { mediaShapes } from "./media-schemas.js";

export const sceneSchema = z.object({
  prompt: z.string().min(1).describe("Full English prompt for one clip: action, shot and camera move, location, style, light, sound."),
  type: z.enum(["video", "image"]).default("video"),
  model: z.string().optional().describe("Model label as shown in Flow, e.g. 'Omni 1.2 Flash' or 'Veo 3.1 - Lite'."),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).optional().describe("Video supports 16:9 and 9:16 only."),
  duration: z.number().int().min(3).max(15).optional().describe("Video length in seconds."),
  resolution: z.enum(["360p", "720p"]).optional().describe("Video resolution. Omni models only."),
  max_credits: z.number().int().min(0).default(25).describe("Safety cap: skipped if Flow quotes more credits than this."),
  variants: z.number().int().min(1).max(4).optional().describe("Outputs per prompt. Default 1."),
  first_frame: z.string().optional().describe("First frame: absolute image path, 'asset:<title>', or finished clip path."),
  first_frame_at: z.number().min(0).optional().describe("Frame second when first_frame is a clip."),
  last_frame: z.string().optional().describe("Last frame: absolute image path, 'asset:<title>', or finished clip path."),
  reference_images: z.array(z.string()).max(3).optional().describe("Reference media: absolute image paths or 'asset:<title>'."),
  download_quality: z.enum(["original", "upscaled"]).optional().describe("'upscaled' fetches 1080p video / 2K image. Default original."),
  retries: z.number().int().min(0).max(3).default(1).describe("Automatic retries when Flow reports failure."),
  technique: z.string().optional().describe("Id from flow_techniques."),
  on_screen_text: z.boolean().optional().describe("Video only: true when words should appear on screen."),
  outfit: z.string().max(300).optional().describe("Costume override for a referenced character."),
  reference_previous: z.boolean().optional().describe("Use previous scene's finished image as an extra reference."),
  chain_previous: z.boolean().optional().describe("Continue the previous video scene's last frame."),
});

const accountSelectorFields = {
  id: z.string().min(1).optional().describe("Account ID."),
  label: z.string().min(1).optional().describe("Account label (case-insensitive)."),
};

export const shapes = {
  status: { detailed: z.boolean().default(true).describe("false skips Chrome launch and plan/credits readout.") },
  generate: {
    project: z.string().min(1).describe("Folder name for the downloaded clips."),
    scenes: z.array(sceneSchema).min(1).max(100),
  },
  wait: {
    job_ids: z.array(z.string()).optional().describe("Job ids or task_id from still_working. Default: all queued jobs."),
    timeout_seconds: z.number().int().min(5).max(900).default(40).describe("Returns within about 40 s."),
  },
  cancel: { job_id: z.string() },
  retry: { job_ids: z.array(z.string()).optional().describe("Jobs to re-queue. Default: every failed job for active account.") },
  assets: { kind: z.enum(["image", "video", "scene"]).optional() },
  download: {
    project: z.string().min(1).describe("Local folder name under the output root."),
    assets: z.array(z.string().min(1)).max(30).default([]).describe("Titles or prefixes from flow_assets."),
    quality: z.enum(["original", "upscaled"]).default("original"),
    collection: z.string().min(1).optional().describe("Flow collection name to fetch as one ZIP."),
  },
  ...mediaShapes,
  agent: {
    project: z.string().min(1).describe("Folder name for the downloaded images."),
    scenes: z.array(z.string().min(1)).min(1).max(50).describe("One image description per scene."),
    aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:3", "3:4"]).default("16:9"),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    references: z.array(z.object({ image: z.string().min(1), name: z.string().min(1).max(40) })).max(10).optional(),
    scene_references: z.array(z.array(z.string())).optional(),
  },
  voices: {},
  edit: {
    project: z.string().min(1),
    asset: z.string().min(1),
    prompt: z.string().min(1),
    acknowledge_cost: z.literal(true),
    download_quality: z.enum(["original", "upscaled"]).optional(),
  },
  continue_shot: {
    project: z.string().min(1),
    from_asset: z.string().min(1),
    prompt: z.string().min(1),
    attach: z.array(z.string().min(1)).max(3).optional(),
    aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9"),
    mode: z.enum(["exact", "likeness"]).default("exact"),
    acknowledge_cost: z.literal(true),
    download_quality: z.enum(["original", "upscaled"]).optional(),
    force: z.boolean().optional(),
  },
  trash: { name: z.string().min(1) },
  set_key: { key: z.string().min(1).max(200) },
  discard: { path: z.string().min(1) },
  outputs: {},
  characters: {},
  cast: {},
  character_edit: {
    name: z.string().min(1),
    change: z.string().min(1).max(600).optional(),
    look: z.string().min(1).max(1500).optional(),
  },
  new_project: { title: z.string().max(80).optional() },
  character: {
    name: z.string().min(1).max(60),
    describe: z.string().max(1200).optional(),
    image: z.string().min(1).optional(),
    aspect_ratio: z.enum(["3:4", "1:1", "9:16", "16:9", "4:3"]).optional(),
    look: z.string().max(1200).optional(),
    personality: z.string().max(500).optional(),
    voice: z.string().optional(),
  },
  techniques: { category: z.enum(["camera", "product", "transition", "image"]).optional() },
  accounts: {},
  account_add: {
    label: z.string().describe("Display label for the new Google Flow account (1-60 chars, unique)."),
  },
  account_switch: accountSelectorFields,
  account_login: accountSelectorFields,
  account_rename: {
    id: z.string().min(1).optional().describe("Account ID."),
    current_label: z.string().min(1).optional().describe("Current account label when id is omitted."),
    label: z.string().describe("New trimmed display label (1-60 chars, unique)."),
  },
  account_enable: {
    ...accountSelectorFields,
    enabled: z.boolean().describe("Enable or disable this account."),
  },
  account_reorder: {
    ids: z.array(z.string().min(1)).min(1).describe("Complete ordered list of all registered account IDs."),
  },
  account_remove: accountSelectorFields,
  account_refresh: accountSelectorFields,
  account_config: {
    auto_failover: z.boolean().optional().describe("Enable or disable automatic credit failover across enabled accounts. Omit to read current setting."),
  },
};

export type Args<K extends keyof typeof shapes> = z.infer<z.ZodObject<(typeof shapes)[K]>>;
