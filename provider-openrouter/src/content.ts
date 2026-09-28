import type { ContentPart, Message, ProviderContext } from "@thetis/runtime/contracts";
import { contentText, isAssetPart, isTextPart, normalizeContent } from "@thetis/runtime/lib/content";
import type { OpenAiContentPart, OpenAiWireMessage } from "@thetis/prompt-cache";

const IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const AUDIO: Record<string, string> = { "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg", "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/aiff": "aiff" };

/** This adapter owns modality policy. The runtime carries every JSON content kind unchanged. */
export async function wireContent(message: Message, context?: ProviderContext): Promise<OpenAiWireMessage["content"]> {
  const parts = normalizeContent(message.content);
  if (parts.every(isTextPart)) return contentText(parts);
  if (message.role !== "user") throw new Error(`OpenRouter cannot send non-text content with role ${message.role}`);
  const output: OpenAiContentPart[] = [];
  for (const part of parts) output.push(await wirePart(part, context));
  return output;
}

/**
 * A tool result split for the wire. The chat-completions format lets a `tool` message carry text only, so
 * the text stays in the tool message and the media (a screenshot, say) comes back as parts for a `user`
 * message the caller puts after the run of tool messages, the way OpenAI-compatible agents show a model what
 * a tool saw. Each medium leaves a line in the tool text saying where it went, so the model can tie the two
 * together. A model known not to take images gets that line instead of the image, and nothing is thrown.
 */
export async function wireToolResult(message: Message, context: ProviderContext | undefined, accepts: (mediaType: string) => boolean): Promise<{ text: string; media: OpenAiContentPart[] }> {
  const parts = normalizeContent(message.content);
  if (parts.every(isTextPart)) return { text: contentText(parts), media: [] };
  let text = "";
  const media: OpenAiContentPart[] = [];
  const label = message.name ? `${message.name}` : "the tool";
  for (const part of parts) {
    if (isTextPart(part)) { text += part.data.text; continue; }
    const name = isAssetPart(part) ? part.data.name ?? part.data.mediaType : part.type;
    if (isAssetPart(part) && !accepts(part.data.mediaType)) {
      text += `\n[${name}: not shown, this model does not take ${part.data.mediaType.split("/")[0]} input]`;
      continue;
    }
    try {
      const wired = await wirePart(part, context);
      media.push({ type: "text", text: `[${name}, returned by ${label}${message.toolCallId ? ` (${message.toolCallId})` : ""}]` }, wired);
      text += `\n[${name}: attached in the next message]`;
    } catch (error) {
      text += `\n[${name}: could not be sent: ${error instanceof Error ? error.message : String(error)}]`;
    }
  }
  return { text: text.replace(/^\n/, ""), media };
}

async function wirePart(part: ContentPart, context?: ProviderContext): Promise<OpenAiContentPart> {
  if (isTextPart(part)) return { type: "text", text: part.data.text };
  if (!isAssetPart(part)) throw new Error(`OpenRouter does not support content type ${part.type}`);
  if (!context) throw new Error("OpenRouter needs an asset reader for attached media");
  const { asset, data } = await context.assets.read(part.data.id);
  if (asset.mediaType !== part.data.mediaType) throw new Error(`asset ${asset.id} has a different media type`);
  if (IMAGES.has(asset.mediaType)) return { type: "image_url", image_url: { url: `data:${asset.mediaType};base64,${data}` } };
  if (AUDIO[asset.mediaType]) return { type: "input_audio", input_audio: { data, format: AUDIO[asset.mediaType] } };
  if (asset.mediaType === "application/pdf") return { type: "file", file: { filename: asset.name ?? "document.pdf", file_data: `data:application/pdf;base64,${data}` } };
  throw new Error(`OpenRouter does not support asset media type ${asset.mediaType}`);
}
