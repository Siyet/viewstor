/** Extract a human-readable message from any thrown value. */
export function wrapError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
