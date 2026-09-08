export type CalendarTarget = {
  id: string;
  platform: string;
  accountId: string;
  draftId: string;
  deliveryMode?: "auto_publish" | "manual_handoff";
  status: string;
  scheduledFor: string;
  timezone?: string;
  queueAssignment?: { origin: "queue_assigned"; reservationId: string; profileId: string; profileVersion: number; localDate: string; localTime: string; timezone: string; utcOffset: string };
};

export type CalendarContentItem = {
  id: string;
  version?: number;
  title: string;
  summary: string;
  status: string;
  targets: CalendarTarget[];
};

export type CalendarEntry = {
  key: string;
  contentId: string;
  contentVersion?: number;
  contentTitle: string;
  contentSummary: string;
  contentStatus: string;
  target: CalendarTarget;
};

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const numericParts = (value: Date | string, timeZone: string): DateParts => {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const result = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
    second: Number(result.second),
  };
};

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function browserTimeZone(): string {
  const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (value === "Asia/Calcutta") return "Asia/Kolkata";
  return value && isValidTimeZone(value) ? value : "UTC";
}

export function dateKeyInZone(value: Date | string, timeZone: string): string {
  const parts = numericParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function monthKeyInZone(value: Date | string, timeZone: string): string {
  return dateKeyInZone(value, timeZone).slice(0, 7);
}

export function formatInZone(value: string, timeZone: string, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
    ...options,
  }).format(new Date(value));
}

export function formatUtc(value: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(new Date(value));
}

export function toLocalInputValue(value: string, timeZone: string): string {
  const parts = numericParts(value, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function zonedDateTimeToUtc(value: string, timeZone: string): string {
  if (!isValidTimeZone(timeZone)) throw new Error("Use a valid IANA time zone, such as Asia/Kolkata.");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid date and time.");
  const desired: DateParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
  };
  const desiredUtc = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, 0);
  let instant = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = numericParts(new Date(instant), timeZone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    instant += desiredUtc - actualAsUtc;
  }
  const verified = numericParts(new Date(instant), timeZone);
  if (verified.year !== desired.year || verified.month !== desired.month || verified.day !== desired.day || verified.hour !== desired.hour || verified.minute !== desired.minute) {
    throw new Error("That local time does not exist in this time zone. Choose another time.");
  }
  return new Date(instant).toISOString();
}

export function flattenCalendarEntries(items: CalendarContentItem[]): CalendarEntry[] {
  return items.flatMap((item) => item.targets.map((target) => ({
    key: `${item.id}:${target.id}`,
    contentId: item.id,
    ...(item.version ? { contentVersion: item.version } : {}),
    contentTitle: item.title,
    contentSummary: item.summary,
    contentStatus: item.status,
    target,
  }))).sort((left, right) => left.target.scheduledFor.localeCompare(right.target.scheduledFor));
}

export function calendarEntriesForMonth(entries: readonly CalendarEntry[], monthKey: string, timeZone: string): CalendarEntry[] {
  return entries.filter((entry) => monthKeyInZone(entry.target.scheduledFor, timeZone) === monthKey);
}

export function monthRangeInZone(monthKey: string, timeZone: string): { from: string; to: string } {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthKey)) throw new Error("Choose a valid calendar month.");
  return {
    from: zonedDateTimeToUtc(`${monthKey}-01T00:00`, timeZone),
    to: zonedDateTimeToUtc(`${shiftMonth(monthKey, 1)}-01T00:00`, timeZone),
  };
}

export function monthDays(monthKey: string): Array<{ key: string; day: number; inMonth: boolean }> {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return [];
  const year = Number(match[1]);
  const month = Number(match[2]);
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mondayOffset = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const cells: Array<{ key: string; day: number; inMonth: boolean }> = [];
  for (let offset = mondayOffset; offset > 0; offset -= 1) cells.push({ key: `before-${offset}`, day: 0, inMonth: false });
  for (let day = 1; day <= count; day += 1) cells.push({ key: `${monthKey}-${String(day).padStart(2, "0")}`, day, inMonth: true });
  while (cells.length % 7) cells.push({ key: `after-${cells.length}`, day: 0, inMonth: false });
  return cells;
}

export function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number);
  const value = new Date(Date.UTC(year!, month! - 1 + delta, 1));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}
