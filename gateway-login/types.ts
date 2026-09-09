/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
export type Login = { "id": string; "password": string; [key: string]: unknown; };
export type Credential = { "id": string; "salt": string; "hash": string; [key: string]: unknown; };
export type Accounts = { "version": 1; "accounts": (Credential)[]; [key: string]: unknown; };
export type Session = { "sessionToken": string; "person": string; "role": "admin" | "reviewer" | "user"; [key: string]: unknown; };
export type Contract = Accounts;
