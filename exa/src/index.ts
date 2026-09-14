// @thetis/exa: web search, page contents, summaries, answers, and research runs through the
// Exa API, as tools for the model. The key comes from packages["@thetis/exa"].apiKey.
import type { Tool } from "@thetis/kernel";
import { createTools } from "./tools.js";

export { createClient, checkPath, ExaError, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "./client.js";
export type { ExaClient, ExaConfig, FetchLike, Query, RequestInitLike, ResponseLike } from "./client.js";
export { createTools } from "./tools.js";
export type { ToolDeps } from "./tools.js";
export * from "./format.js";

const tools = createTools();

export const search: Tool = tools.search;
export const contents: Tool = tools.contents;
export const summarize: Tool = tools.summarize;
export const findSimilar: Tool = tools.findSimilar;
export const answer: Tool = tools.answer;
export const research: Tool = tools.research;
export const researchGet: Tool = tools.researchGet;
export const researchCancel: Tool = tools.researchCancel;
export const researchList: Tool = tools.researchList;
export const request: Tool = tools.request;
