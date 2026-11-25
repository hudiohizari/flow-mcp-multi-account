import { z } from "zod";

export const captionFields = {
  video: z.string().min(1).describe("Absolute path of the video to caption: any MP4 or MOV on this computer, such as a film made with flow_assemble."),
  style: z
    .enum(["bold", "highlight", "reveal", "clean", "boxed"])
    .default("bold")
    .describe(
      "bold: big capitals, 1-3 words at a time, the spoken word lights up (the short-form look). highlight: the spoken word sits on a coloured block. reveal: words appear as they are said. clean: classic subtitles. boxed: white words on a dark band.",
    ),
  position: z
    .union([z.enum(["bottom", "middle", "top"]), z.number().min(0).max(100)])
    .default("bottom")
    .describe("bottom, middle or top - or a number for an exact height: how far down the frame the middle of the caption sits, 0 = top edge, 100 = bottom edge."),
  size: z
    .union([z.enum(["small", "medium", "large"]), z.number().min(40).max(250)])
    .default("medium")
    .describe("small, medium, large, or a percentage of the style's normal size (100 = medium, 150 = half again as big)."),
  lead: z
    .number()
    .min(-0.5)
    .max(0.5)
    .optional()
    .describe("Seconds the highlight runs ahead of the voice. Default 0.12; raise it if words still light up late, lower it if early."),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Highlight colour as #RRGGBB, for bold, highlight and reveal."),
  letters: z
    .enum(["as_said", "capitals", "lowercase"])
    .optional()
    .describe("as_said keeps normal capitals (sentence starts, names); capitals is the high-energy short-form look; lowercase is the calm, casual look, and names still keep their capital in it. Default: capitals for bold, as_said for the rest."),
  names: z
    .array(z.string().min(1))
    .max(50)
    .optional()
    .describe("Lowercase only: names to keep capitalised even where they start a sentence (e.g. [\"Juno\"]). Names in the middle of a sentence are found by themselves."),
  text: z.string().max(50_000).optional().describe("Corrected words, to fix anything misheard. Timings are kept for every word that still matches; a line break starts a new caption."),
  words: z
    .array(z.object({ text: z.string().min(1), start: z.number().min(0), end: z.number().min(0) }))
    .max(5000)
    .optional()
    .describe("Word timings to use instead of hearing the whole video, e.g. from flow_transcribe on each clip of a joined film, shifted by where each clip starts in it. Use it when the film's own sound (music, a train, crowd) throws the timing off. text still corrects the words on top."),
  language: z
    .string()
    .default("auto")
    .describe(
      "Spoken language as a code: en, es, fr, de, pt, tr, ja, zh, ar... Pass it whenever you know it. auto detects it (a 60 MB detector downloads once). English uses a 148 MB model; every other language a 574 MB one, each downloaded the first time.",
    ),
};

export const mediaShapes = {
  assemble: {
    project: z.string().min(1).describe("Same project name used in flow_generate."),
    clips: z.array(z.string()).optional().describe("Absolute clip paths in play order. Default: every scene-NN.mp4 in the project folder (first variant of each)."),
    music: z.string().optional().describe("Absolute path to a music file; looped and trimmed to the film length."),
    music_volume: z.number().min(0).max(1).default(0.25),
    end_hold: z.object({ seconds: z.number().min(0).max(10), fade: z.number().min(0).max(10).optional() }).optional().describe("Hold the last frame this many seconds at the end, fading to black over its last `fade` seconds."),
    music_curve: z.array(z.object({ at: z.number().min(0), volume: z.number().min(0).max(2) })).optional().describe("Music level over the film on top of music_volume: {at: seconds, volume}, straight lines between points. Fade in, drop for a quiet moment, rise for the ending."),
    duck_music: z.boolean().optional().describe("Pull the music down automatically while the voiceover speaks, and let it back up in the gaps."),
    clip_volume: z
      .number()
      .min(0)
      .max(1)
      .default(1)
      .describe("Volume of the clips' own sound, 0-1. Lower it (around 0.2-0.3) so a narration sits clearly on top; 1 keeps it as recorded."),
    voiceover: z.string().optional().describe("Absolute path to a voiceover audio file, starts at 0:00."),
    voice_lines: z
      .array(
        z.object({
          file: z.string().min(1).describe("Take to cut the line from: audio or video (its sound is used)."),
          from: z.number().min(0).optional().describe("Start of the line within the take, seconds (from flow_transcribe word times)."),
          to: z.number().min(0).optional().describe("End of the line within the take, seconds."),
          at: z.number().min(0).describe("Where the line starts in the film, seconds."),
          max_seconds: z.number().min(0.2).optional().describe("Longest it may last; a longer line is sped up slightly (at most 1.25x)."),
        }),
      )
      .max(60)
      .optional()
      .describe("A timed voiceover built from separate lines, each placed at its own moment in the film. Replaces `voiceover`."),
    output_name: z.string().default("final"),
    hold_last_frame: z.boolean().default(true).describe("Freeze the final frame so a longer voiceover is not cut off."),
    trims: z
      .array(
        z
          .object({
            from: z.number().min(0).optional(),
            to: z.number().min(0).optional(),
            volume: z.number().min(0).max(2).optional().describe("This clip's own sound level, 1 = as made."),
            fade_in: z.number().min(0).max(2).optional().describe("Seconds to fade this clip's sound in."),
            fade_out: z.number().min(0).max(2).optional().describe("Seconds to fade this clip's sound out."),
            soften_in: z.number().min(0).max(3).optional().describe("Soften the opening transition over this many seconds."),
            saturation: z.number().min(0.5).max(2).optional().describe("Scales this clip's colour (1 = as is)."),
            crop: z
              .object({
                x: z.number().min(0).max(1).optional().describe("Left edge, as a fraction of the width. Default: centred."),
                y: z.number().min(0).max(1).optional().describe("Top edge, as a fraction of the height. Default: centred."),
                w: z.number().min(0.1).max(1).describe("Width kept, as a fraction (0.8 = a 1.25x punch-in)."),
                h: z.number().min(0.1).max(1).optional().describe("Height kept; defaults to w, which keeps the frame's shape."),
              })
              .optional()
              .describe("Punch in on part of this clip."),
          })
          .nullable(),
      )
      .optional()
      .describe("One entry per clip, in play order: the seconds of that clip to keep."),
    end_card: z
      .object({
        text: z.string().min(1).max(120).describe("The words, e.g. 'Link in bio'."),
        seconds: z.number().min(1).max(10).optional().describe("How long it shows. Default 2.5."),
      })
      .optional()
      .describe("A closing card over the film's own last frame."),
    inserts: z
      .array(
        z.object({
          clip: z.string().min(1).describe("Absolute path of the cutaway clip."),
          over: z.number().int().min(1).describe("Which clip it covers, counting from 1 in play order."),
          at: z.number().min(0).describe("Where it starts, in seconds into that clip's kept part."),
          seconds: z.number().min(0.2).optional().describe("How long it shows."),
          from: z.number().min(0).optional().describe("Start inside the cutaway clip. Default 0."),
          volume: z.number().min(0).max(1).optional().describe("The cutaway's own sound under the covered clip's sound. Default 0.3."),
          crop: z.object({ x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional(), w: z.number().min(0.1).max(1), h: z.number().min(0.1).max(1).optional() }).optional(),
        }),
      )
      .optional()
      .describe("B-roll cutaways."),
    size: z.string().regex(/^\d{2,4}x\d{2,4}$/).optional().describe("Film size as WIDTHxHEIGHT."),
    loudness: z.number().min(-30).max(-9).optional().describe("Level the finished film's sound to this loudness in LUFS."),
    remove_watermark: z.boolean().optional().describe("Paint out the sparkle mark in the bottom-right corner."),
    watermark_margin: z.number().min(0).max(40).optional().describe("Grow the watermark mask by this many pixels."),
  },
  transcribe: {
    video: z.string().min(1).describe("Absolute path of a video or audio file on this computer."),
    language: z.string().default("auto").describe("Spoken language code (en, es, tr, ja...) or auto."),
    words: z.boolean().default(true).describe("Include every word with its start and end time in seconds."),
  },
  caption_preview: captionFields,
  presenter: {
    project: z.string().min(1).describe("Films folder to save into."),
    presenter: z.string().min(1).describe("Absolute path of the talking recording."),
    segments: z
      .array(
        z.object({
          from: z.number().min(0),
          to: z.number().min(0),
          layout: z.enum(["full", "corner"]),
          zoom: z.object({ from: z.number().min(1).max(3).optional(), to: z.number().min(1).max(3).optional(), x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional() }).optional(),
          background: z.object({
            clip: z.string().min(1),
            from: z.number().min(0).optional(),
            retime: z.array(z.object({ from: z.number().min(0), to: z.number().min(0), speed: z.number().min(0.1).max(8) })).optional(),
          }).optional(),
          shrink: z.number().min(0.1).max(3).optional(),
        }),
      )
      .min(1),
    corner: z
      .object({
        position: z.enum(["bottom-right", "bottom-left", "top-right", "top-left"]).optional(),
        size: z.number().min(0.15).max(0.7).optional(),
        face: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.1).max(1) }).optional(),
        margin: z.number().min(0).max(0.2).optional(),
        ring_color: z.string().optional(),
      })
      .optional(),
    size: z.string().regex(/^\d{2,4}x\d{2,4}$/).optional(),
    output_name: z.string().optional(),
  },
  captions: {
    ...captionFields,
    project: z.string().optional().describe("Films folder to save into."),
  },
  caption_setup: {},
  narrate: {
    project: z.string().min(1).describe("Folder for the narration audio."),
    engine: z.enum(["kokoro", "gemini"]).default("kokoro"),
    text: z.string().min(1).max(3000),
    voice: z.string().min(1).optional(),
    speed: z.number().min(0.5).max(2).optional(),
    style: z.string().max(200).optional(),
  },
};
