import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export function useApi<T>(path: string, initial: T): {
  data: T;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api<T>(path));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    let active = true;
    api<T>(path)
      .then((result) => {
        if (active) {
          setData(result);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path]);

  return { data, loading, error, reload };
}
