export function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

export function decodeJson<T>(value: string): T {
  return JSON.parse(value) as T;
}
