import type {
  NormalizedSourceRecord,
  SourceKind,
  SourceParticipant
} from "../../core/types";

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function arrayFrom(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = object(payload);
  for (const key of keys) {
    if (Array.isArray(root[key])) return root[key];
  }
  if (root.data) return arrayFrom(root.data, keys);
  return [];
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function isoTime(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  if (value && typeof value === "object") {
    const entry = object(value);
    return isoTime(
      entry.datetime ?? entry.timestamp ?? entry.date ?? entry.time,
      fallback
    );
  }
  return fallback;
}

function contentText(value: unknown): string {
  if (typeof value !== "string") {
    const entry = object(value);
    return firstString(entry.text, entry.content, JSON.stringify(value));
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object") {
      const entry = object(parsed);
      return firstString(entry.text, entry.title, value);
    }
  } catch {
    // Plain text is already normalized.
  }
  return value;
}

function participant(
  value: unknown,
  role: SourceParticipant["role"],
  fallbackName?: string
): SourceParticipant | null {
  const entry = object(value);
  const id = firstString(entry.id, entry.open_id, entry.user_id, entry.sender_id);
  if (!id) return null;
  return {
    provider_id: id,
    name: firstString(entry.name, entry.display_name, fallbackName, id),
    role
  };
}

function isBotActor(value: unknown): boolean {
  const entry = object(value);
  const actorType = firstString(
    entry.type,
    entry.sender_type,
    entry.actor_type,
    entry.user_type
  ).toLowerCase();
  return (
    actorType === "bot" ||
    actorType === "app" ||
    Boolean(firstString(entry.open_bot_id, entry.bot_id))
  );
}

export function normalizeMessages(payload: unknown, kind: "mention" | "p2p"): NormalizedSourceRecord[] {
  return arrayFrom(payload, ["messages", "items", "results"]).flatMap((raw) => {
    const message = object(raw);
    const id = firstString(message.message_id, message.id);
    if (!id) return [];
    const senderActor: Record<string, unknown> = {
      ...object(message.sender),
      sender_type:
        object(message.sender).sender_type ?? message.sender_type
    };
    const partnerValue = message.chat_partner ?? message.partner ?? message.peer;
    const partnerActor: Record<string, unknown> = {
      ...object(partnerValue),
      actor_type:
        object(partnerValue).actor_type ??
        message.chat_partner_type ??
        message.partner_type ??
        message.peer_type
    };
    if (
      isBotActor(senderActor) ||
      (kind === "p2p" && isBotActor(partnerActor))
    ) {
      return [];
    }
    const sender = participant(message.sender, "sender", "Lark user");
    const partner = participant(partnerValue, "partner");
    const participants = [sender, partner].filter(Boolean) as SourceParticipant[];
    const text = contentText(message.content ?? message.body);
    return [
      {
        sourceId: `lark:message:${id}`,
        provider: "lark",
        kind,
        title: firstString(
          message.chat_name,
          kind === "mention" ? "Group mention" : "Direct message"
        ),
        text,
        occurredAt: isoTime(message.create_time ?? message.created_at),
        participants,
        metadata: {
          message_id: id,
          chat_id: message.chat_id,
          chat_type: message.chat_type ?? (kind === "p2p" ? "p2p" : "group"),
          chat_name: message.chat_name,
          sender_type: firstString(
            senderActor.type,
            senderActor.sender_type,
            senderActor.actor_type
          ),
          chat_partner_type: firstString(
            partnerActor.type,
            partnerActor.sender_type,
            partnerActor.actor_type
          ),
          thread_id: message.thread_id,
          mentions: message.mentions ?? [],
          deleted: Boolean(message.deleted),
          updated: Boolean(message.updated)
        }
      }
    ];
  });
}

export function normalizeCalendar(payload: unknown): NormalizedSourceRecord[] {
  return arrayFrom(payload, ["events", "items", "instances"]).flatMap((raw) => {
    const event = object(raw);
    const start = event.start_time ?? event.start ?? event.start_at;
    const occurredAt = isoTime(start);
    const id = firstString(event.event_id, event.id, event.uid);
    if (!id) return [];
    const location = firstString(
      object(event.location).name,
      event.location,
      object(event.room).name
    );
    const attendees = arrayFrom(event.attendees, ["items"])
      .map((entry) => participant(entry, "attendee", "Attendee"))
      .filter(Boolean) as SourceParticipant[];
    return [
      {
        sourceId: `lark:calendar:${id}`,
        provider: "lark",
        kind: "calendar",
        title: firstString(event.summary, event.title, "Calendar event"),
        text: firstString(event.description, location),
        occurredAt,
        participants: attendees,
        metadata: {
          event_id: id,
          start: occurredAt,
          end: isoTime(event.end_time ?? event.end ?? event.end_at, occurredAt),
          status: event.status,
          location,
          url: firstString(
            event.url,
            event.app_link,
            object(event.vchat).meeting_url
          )
        }
      }
    ];
  });
}

export function normalizeTasks(payload: unknown): NormalizedSourceRecord[] {
  return arrayFrom(payload, ["tasks", "items"]).flatMap((raw) => {
    const task = object(raw);
    const id = firstString(task.guid, task.task_id, task.id);
    if (!id) return [];
    const members = arrayFrom(task.members, ["items"])
      .map((entry) => participant(entry, "assignee", "Assignee"))
      .filter(Boolean) as SourceParticipant[];
    const completed =
      Boolean(task.completed_at) ||
      ["done", "completed"].includes(String(task.status ?? "").toLowerCase());
    if (completed) return [];
    return [
      {
        sourceId: `lark:task:${id}`,
        provider: "lark",
        kind: "task",
        title: firstString(task.summary, task.title, "Lark task"),
        text: firstString(task.description, task.notes),
        occurredAt: isoTime(task.created_at ?? task.create_time),
        participants: members,
        metadata: {
          task_id: id,
          completed,
          status: task.status,
          due_at: task.due_at ? isoTime(task.due_at) : null,
          url: task.url
        }
      }
    ];
  });
}

export function normalizeSelf(payload: unknown): NormalizedSourceRecord[] {
  const root = object(payload);
  const user = object(root.user ?? root);
  const id = firstString(user.open_id, user.user_id, user.id);
  if (!id) return [];
  const name = firstString(user.name, user.en_name, "Me");
  return [
    {
      sourceId: `lark:person:${id}`,
      provider: "lark",
      kind: "person",
      title: name,
      text: "",
      occurredAt: new Date().toISOString(),
      participants: [{ provider_id: id, name, role: "sender" }],
      metadata: {
        open_id: id,
        email: user.email,
        avatar_url: user.avatar_url
      }
    }
  ];
}

export function sourceKindDirectory(kind: SourceKind): string {
  if (kind === "calendar") return "calendar";
  if (kind === "task") return "tasks";
  if (kind === "p2p") return "dms";
  if (kind === "person") return "people";
  return "mentions";
}
