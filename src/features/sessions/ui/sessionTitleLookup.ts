/**
 * Readable titles for sessions a pane only knows by ID, such as a fork's
 * source. The app registers its live session list; nothing here is stored.
 */
type Lookup = (sessionId: string) => string | undefined;

let lookup: Lookup = () => undefined;

export function provideSessionTitles(next: Lookup): () => void {
  lookup = next;
  return () => {
    if (lookup === next) lookup = () => undefined;
  };
}

export function sessionTitleFor(sessionId: string): string | undefined {
  return lookup(sessionId);
}
