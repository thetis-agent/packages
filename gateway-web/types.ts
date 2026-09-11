/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type Contract = { "type": string; "id"?: string; "text"?: string; "from"?: number; "title"?: string; "scope"?: "mine" | "everyone"; "attachments"?: ({ "name": string; "mime": string; "bytes": number; "hash": string; "path": string; [key: string]: unknown; })[]; [key: string]: unknown; };
