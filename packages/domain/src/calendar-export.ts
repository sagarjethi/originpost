import { utf8Csv } from "./csv.js";
import { DomainError } from "./errors.js";
import type { ContentItem, Platform, PublishTarget } from "./types.js";

export const calendarExportTargetStatuses = ["pending", "queued", "action_required", "acknowledged", "publishing", "published", "failed", "cancelled"] as const;
export type CalendarExportTargetStatus = (typeof calendarExportTargetStatuses)[number];

export type CalendarExportFilter = {
  workspaceId: string;
  brandId: string;
  month: string;
  timeZone: string;
  platform?: Platform | "all";
  status?: CalendarExportTargetStatus | "all";
};

type DateParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function parts(value: Date, timeZone: string): DateParts {
  const entries = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const map = Object.fromEntries(entries.map((entry) => [entry.type, entry.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second) };
}

function assertTimeZone(timeZone: string): void {
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); }
  catch { throw new DomainError("Use a valid IANA time zone, such as Asia/Kolkata.", "calendar_export_timezone_invalid", 400); }
}

function localMidnightUtc(year: number, month: number, timeZone: string): number {
  const wanted = Date.UTC(year, month - 1, 1, 0, 0, 0);
  let instant = wanted;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = parts(new Date(instant), timeZone);
    instant += wanted - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
  }
  const verified = parts(new Date(instant), timeZone);
  if (verified.year !== year || verified.month !== month || verified.day !== 1 || verified.hour !== 0 || verified.minute !== 0) {
    throw new DomainError("The requested month has no local midnight in this time zone.", "calendar_export_month_boundary_invalid", 400);
  }
  return instant;
}

function monthRange(month: string, timeZone: string): { from: number; to: number } {
  const match = /^(\d{4})-(\d{2})$/u.exec(month);
  const year = Number(match?.[1]);
  const monthNumber = Number(match?.[2]);
  if (!match || monthNumber < 1 || monthNumber > 12) throw new DomainError("Month must use YYYY-MM.", "calendar_export_month_invalid", 400);
  const nextYear = monthNumber === 12 ? year + 1 : year;
  const nextMonth = monthNumber === 12 ? 1 : monthNumber + 1;
  return { from: localMidnightUtc(year, monthNumber, timeZone), to: localMidnightUtc(nextYear, nextMonth, timeZone) };
}

function localDateTime(iso: string, timeZone: string): string {
  const value = parts(new Date(iso), timeZone);
  return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")} ${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}:${String(value.second).padStart(2, "0")}`;
}

function targetRows(items: readonly ContentItem[], filter: CalendarExportFilter): Array<{ item: ContentItem; target: PublishTarget }> {
  assertTimeZone(filter.timeZone);
  const range = monthRange(filter.month, filter.timeZone);
  return items
    .filter((item) => item.workspaceId === filter.workspaceId && item.brandId === filter.brandId)
    .flatMap((item) => item.targets.map((target) => ({ item, target })))
    .filter(({ target }) => {
      const scheduled = Date.parse(target.scheduledFor);
      return Number.isFinite(scheduled)
        && scheduled >= range.from
        && scheduled < range.to
        && (!filter.platform || filter.platform === "all" || target.platform === filter.platform)
        && (!filter.status || filter.status === "all" || target.status === filter.status);
    })
    .sort((left, right) => left.target.scheduledFor.localeCompare(right.target.scheduledFor) || left.target.id.localeCompare(right.target.id));
}

export function calendarScheduleCsv(
  items: readonly ContentItem[],
  accountDisplayNames: ReadonlyMap<string, string>,
  filter: CalendarExportFilter,
): string {
  const headers = ["content_title", "platform", "account", "calendar_local", "calendar_timezone", "saved_local", "saved_timezone", "scheduled_for_utc", "content_status", "target_status", "delivery_mode"];
  const rows = targetRows(items, filter).map(({ item, target }) => {
    const savedTimeZone = target.timezone?.trim() || "UTC";
    let effectiveTimeZone = savedTimeZone;
    try { assertTimeZone(savedTimeZone); } catch { effectiveTimeZone = "UTC"; }
    return [
      item.title,
      target.platform,
      accountDisplayNames.get(target.accountId)?.trim() || "Unavailable",
      localDateTime(target.scheduledFor, filter.timeZone),
      filter.timeZone,
      localDateTime(target.scheduledFor, effectiveTimeZone),
      savedTimeZone,
      new Date(target.scheduledFor).toISOString(),
      item.status,
      target.status,
      target.deliveryMode,
    ];
  });
  return utf8Csv(headers, rows);
}
