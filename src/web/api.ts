let csrfTokenPromise: Promise<string> | null = null;

function isMutation(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

async function getCsrfToken(): Promise<string> {
  csrfTokenPromise ??= fetch("/api/security/csrf", {
    headers: { Accept: "application/json" }
  }).then(async (response) => {
    const payload = (await response.json()) as {
      token?: string;
      error?: string;
    };
    if (!response.ok || !payload.token) {
      throw new Error(payload.error ?? "无法获取本地写入令牌");
    }
    return payload.token;
  });
  return csrfTokenPromise;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const mutation = isMutation(init);
  const csrfToken = mutation ? await getCsrfToken() : null;
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "x-context-space-csrf": csrfToken } : {}),
      ...init?.headers
    }
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed with status ${response.status}`);
  }
  return payload;
}
