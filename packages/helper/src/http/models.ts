import type { Ctx } from './context';

/** Model id that clients see when they don't pick a specific claude.ai model. */
export const DEFAULT_MODEL_ID = 'claude-web';

/** Models clients can list: the default plus the ones allowed in the extension's settings. */
export function listedModels(ctx: Ctx): string[] {
  return [DEFAULT_MODEL_ID, ...(ctx.link.status?.settings.models ?? [])];
}

/** Passes a model through to claude.ai only if it's allowed in the extension's settings. */
export function pickModel(ctx: Ctx, requested: unknown): string | undefined {
  if (typeof requested !== 'string') return undefined;
  return ctx.link.status?.settings.models.includes(requested) ? requested : undefined;
}

/** The model name echoed back in responses: whatever the client asked for, or the default. */
export function echoedModel(requested: unknown): string {
  return typeof requested === 'string' && requested ? requested : DEFAULT_MODEL_ID;
}
