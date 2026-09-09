/** Generated from schema.json; defend wire compatibility (ADR 0006). Do not edit. */
import type * as Provider from '../../contracts/provider/types.ts';
export type Contract = { "requestBytes": number; "cacheEntries": number; "scriptEvents": number; "maximumCost": number; "scriptBytes": number; "captureBytes": number; "scripts": ((Provider.ResponseEvent)[])[]; "modelId": string; [key: string]: unknown; };
