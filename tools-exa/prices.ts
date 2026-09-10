/** Reserve reviewed upper bounds before vendor access; EXA-006, Exa pricing 2026-09-10. */
import { isObject } from '@/lib/schema/index.ts';
import type { ApiRequest } from './request.ts';
import type { Settings } from './types.ts';
const effortPrices: Readonly<Record<string, number>> = { minimal: 0.012, low: 0.025, medium: 0.1, high: 0.5, xhigh: 1 };
export function estimate(request: ApiRequest, prices: Settings): number {
  const body = request.body ?? {};
  switch (request.operation) {
    case 'exa_search': {
      const count = typeof body['numResults'] === 'number' ? body['numResults'] : 5;
      const base = body['type'] === 'deep-reasoning' ? prices.reasoningPrice : ['deep', 'deep-lite'].includes(String(body['type'])) ? prices.deepPrice : prices.searchPrice;
      const summary = isObject(body['contents']) && !!body['contents']['summary'];
      return base + Math.max(0, count - 10) * prices.resultPrice + (summary ? count * prices.contentPrice : 0);
    }
    case 'exa_contents': {
      const count = Array.isArray(body['urls']) ? body['urls'].length : 0;
      const modes = ['text', 'highlights', 'summary'].filter(name => !!body[name]).length;
      return count * modes * prices.contentPrice;
    }
    case 'exa_answer': return prices.answerPrice;
    case 'exa_agent_start': {
      const effort = String(body['effort']);
      return effortPrices[effort] ?? (isObject(body['budget']) && typeof body['budget']['maxCostDollars'] === 'number' ? body['budget']['maxCostDollars'] : Infinity);
    }
    case 'exa_agent_get': case 'exa_agent_cancel': case 'exa_agent_stop': return 0;
  }
}
