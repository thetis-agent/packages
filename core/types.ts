/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type SessionInfo = { "id": string; "surface": string; "prefixGeneration"?: number; "project"?: string; "title"?: string; "preview"?: string; "createdMs"?: number; "updatedMs"?: number; "archived"?: boolean; [key: string]: unknown; };
export type Contract = SessionInfo;
