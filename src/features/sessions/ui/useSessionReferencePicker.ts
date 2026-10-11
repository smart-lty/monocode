import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionReferenceCandidate,
  SessionReferencePickerLoader,
} from "../data/sessionStore";
import type { SessionReferenceScope } from "../model/sessionPicker";

export type SessionPickerSearch = "title" | "content";

type Request = {
  scope: SessionReferenceScope;
  query: string;
  search: SessionPickerSearch;
};

type Results = {
  key: string | null;
  items: SessionReferenceCandidate[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: Results = {
  key: null,
  items: [],
  nextCursor: null,
  loading: false,
  error: null,
};

/** Pages through the backend's ranked results for one `#` token. A response
 * for an older scope/query/search is dropped, and rows that belong to an older
 * request are reported as not `ready` so Enter/Tab can't pick them. */
export function useSessionReferencePicker({
  loader,
  request,
  currentSessionId,
  projectCwd,
}: {
  loader?: SessionReferencePickerLoader;
  request: Request | null;
  currentSessionId?: string;
  /** Application project path; null when this chat has no project. */
  projectCwd: string | null;
}) {
  const key =
    request && loader && currentSessionId
      ? JSON.stringify([
          currentSessionId,
          projectCwd,
          request.scope,
          request.search,
          request.query.trim(),
        ])
      : null;
  const [results, setResults] = useState<Results>(EMPTY);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const latest = useRef({ key, results });
  latest.current = { key, results };
  const params = useRef({ loader, request, currentSessionId, projectCwd });
  params.current = { loader, request, currentSessionId, projectCwd };

  const fetchPage = useCallback((cursor: string | null) => {
    const { loader, request, currentSessionId, projectCwd } = params.current;
    if (!loader || !request || !currentSessionId) return null;
    if (request.scope === "project" && !projectCwd)
      return Promise.reject(
        new Error("This chat has no project. Type ## to search all projects."),
      );
    return loader({
      currentSessionId,
      projectCwd: projectCwd ?? "",
      scope: request.scope,
      query: request.query.trim(),
      search: request.search,
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
  }, []);

  useEffect(() => {
    const gen = ++generation.current;
    if (!key) {
      setResults(EMPTY);
      return;
    }
    setResults((current) => ({ ...current, loading: true, error: null }));
    const typed = params.current.request?.query.trim();
    const delay = !typed
      ? 0
      : params.current.request?.search === "content"
        ? 220
        : 90;
    const timer = window.setTimeout(() => {
      fetchPage(null)
        ?.then((page) => {
          if (generation.current !== gen) return;
          setResults({
            key,
            items: page.items,
            nextCursor: page.nextCursor,
            loading: false,
            error: null,
          });
        })
        .catch((error: unknown) => {
          if (generation.current !== gen) return;
          setResults({
            key,
            items: [],
            nextCursor: null,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [fetchPage, key, reload]);

  const loadMore = useCallback(() => {
    const { key, results } = latest.current;
    if (!key || results.key !== key || results.loading || !results.nextCursor)
      return;
    const gen = generation.current;
    setResults((current) => ({ ...current, loading: true }));
    fetchPage(results.nextCursor)
      ?.then((page) => {
        if (generation.current !== gen) return;
        setResults((current) => {
          const seen = new Set(current.items.map((item) => item.sessionId));
          return {
            ...current,
            items: [
              ...current.items,
              ...page.items.filter((item) => !seen.has(item.sessionId)),
            ],
            nextCursor: page.nextCursor,
            loading: false,
          };
        });
      })
      .catch((error: unknown) => {
        if (generation.current !== gen) return;
        const message = error instanceof Error ? error.message : String(error);
        // Sessions moved under the cursor: start this scope again.
        if (/scope changed/i.test(message)) {
          setReload((value) => value + 1);
          return;
        }
        setResults((current) => ({
          ...current,
          loading: false,
          error: message,
        }));
      });
  }, [fetchPage]);

  const ready = key !== null && results.key === key;
  return {
    ready,
    items: results.items,
    hasMore: ready && results.nextCursor !== null,
    loading: results.loading,
    error: ready ? results.error : null,
    loadMore,
  };
}
