const REDACTED = "[已脱敏]";
const CIRCULAR = "[循环引用]";
const MAX_DEPTH = 8;
const MAX_OBJECT_KEYS = 100;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4_000;
const MAX_STACK_LENGTH = 12_000;

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxy_authorization",
  "headers",
  "cookie",
  "set_cookie",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "client_secret",
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "openai_api_key",
  "prompt",
  "request_body",
  "response_body",
  "body",
  "text",
  "content",
  "stdin",
  "stdout",
  "stderr",
  "final_response",
  "finalresponse",
  "raw",
  "raw_request",
  "raw_response",
  "environment",
  "env"
]);

function normalizedKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizedKey(key));
}

export function redactLogString(value: string, maxLength = MAX_STRING_LENGTH): string {
  const redacted = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|sess)-[A-Za-z0-9._-]{8,}\b/gi, REDACTED)
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      REDACTED
    )
    .replace(
      /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
      (match) => `${match.split(":", 1)[0]}: ${REDACTED}`
    )
    .replace(
      /\b(?:OPENAI_API_KEY|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|CLIENT_SECRET|PASSWORD|PASSWD)\s*[:=]\s*["']?[^\s"',;]+["']?/gi,
      (match) => `${match.split(/[:=]/, 1)[0]}=${REDACTED}`
    )
    .replace(
      /([?&](?:api_key|access_token|refresh_token|token)=)[^&\s]+/gi,
      `$1${REDACTED}`
    )
    .replace(
      /\bAuthorization\s*:\s*[^\r\n]+/gi,
      `Authorization: ${REDACTED}`
    );
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}…[已截断]`;
}

function errorRecord(
  error: Error,
  seen: WeakSet<object>,
  depth: number
): Record<string, unknown> {
  const withCode = error as Error & { code?: unknown; cause?: unknown };
  const output: Record<string, unknown> = {
    name: redactLogString(error.name || "Error"),
    message: redactLogString(error.message || String(error))
  };
  if (error.stack) {
    output.stack = redactLogString(error.stack, MAX_STACK_LENGTH);
  }
  if (
    typeof withCode.code === "string" ||
    typeof withCode.code === "number"
  ) {
    output.code = withCode.code;
  }
  if (withCode.cause !== undefined) {
    output.cause = sanitizeLogValue(withCode.cause, seen, depth + 1);
  }
  return output;
}

export function sanitizeLogValue(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactLogString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[函数 ${value.name || "anonymous"}]`;
  if (depth >= MAX_DEPTH) return "[达到最大深度]";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof Error) {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    return errorRecord(value, seen, depth);
  }
  if (typeof value !== "object") return redactLogString(String(value));
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (Array.isArray(value)) {
    const selected = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeLogValue(entry, seen, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      selected.push(`[另有 ${value.length - MAX_ARRAY_ITEMS} 项已省略]`);
    }
    return selected;
  }

  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(value as Record<string, unknown>);
  } catch {
    return "[无法读取的对象]";
  }
  const output = Object.create(null) as Record<string, unknown>;
  for (const [rawKey, nested] of entries.slice(0, MAX_OBJECT_KEYS)) {
    const key = redactLogString(rawKey, 120);
    output[key] = isSensitiveLogKey(rawKey)
      ? REDACTED
      : sanitizeLogValue(nested, seen, depth + 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    output._omitted_keys = entries.length - MAX_OBJECT_KEYS;
  }
  return output;
}

export function sanitizeLogFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const value = sanitizeLogValue(fields);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
