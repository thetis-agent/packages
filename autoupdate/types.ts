/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type StatusFile = { "version": 1; "current": string; "available"?: string; "verified": boolean; "checkedAt": number; "stagedAt"?: number; "policy": "none" | "fixes" | "improvements"; [key: string]: unknown; };
export type Request = { "method": string; [key: string]: unknown; };
export type Update = { "known": false; [key: string]: unknown; } | { "known": true; "current": string; "available"?: string; "verified": boolean; "checkedAt": number; "stagedAt"?: number; "policy": "none" | "fixes" | "improvements"; [key: string]: unknown; };
export type Contract = StatusFile;
