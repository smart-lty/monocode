import type { Block } from "./session";
import {
  sanitizeSessionReferences,
  sentSessionReferences,
  type SessionReference,
} from "./sessionReferences";

/** Steer cannot change the provider's existing sandbox/transport configuration. */
export function referencesRequireNewTurn(
  blocks: readonly Block[],
  added: readonly SessionReference[] | undefined,
  operatorAccess: boolean,
): boolean {
  return (
    !operatorAccess &&
    sentSessionReferences(blocks).length === 0 &&
    sanitizeSessionReferences(added).length > 0
  );
}
