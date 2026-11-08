/**
 * Timezone helpers for scheduled publishing.
 *
 * Scheduled posts store a UTC `scheduledAt` plus the user-selected IANA
 * timezone, so the intended wall time survives daylight-saving transitions.
 * These helpers convert between the two without a date library, using only
 * Intl. DST edge cases, documented and tested:
 * - A wall time inside the spring-forward gap (e.g. 02:30 on the day clocks
 *   jump 02:00 -> 03:00) does not exist; it resolves forward to the first
 *   valid instant after the gap (02:30 -> 03:30 local).
 * - A wall time inside the fall-back fold (e.g. 01:30 on the day clocks
 *   fall back) happens twice; it resolves to the earlier occurrence.
 */

export function isValidIanaTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Zone offset at a UTC instant, in milliseconds (local - UTC). */
function zonedOffsetMs(timeZone: string, utcDate: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(utcDate);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second")
  );
  return asUtc - utcDate.getTime();
}

function wallParts(
  date: Date,
  timeZone: string
): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/**
 * Convert a local wall time (YYYY-MM-DD + HH:mm) in an IANA timezone to the
 * UTC instant it denotes. Throws on a malformed date, time, or timezone.
 */
export function wallTimeToUtc(
  date: string,
  time: string,
  timeZone: string
): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid date, expected YYYY-MM-DD");
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("Invalid time, expected HH:mm");
  }
  if (!isValidIanaTimezone(timeZone)) {
    throw new Error("Invalid IANA timezone");
  }
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("Invalid date or time");
  }
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  // Two offset lookups converge in every normal case and in the fall-back
  // fold (where the first lookup already lands on the earlier occurrence).
  // They never converge inside the spring-forward gap: there the first
  // estimate is the requested wall time shifted forward by the gap
  // (02:30 -> 03:30 local), which is the standard resolution.
  const offsetGuess = zonedOffsetMs(timeZone, new Date(wallAsUtc));
  const first = wallAsUtc - offsetGuess;
  const offsetFirst = zonedOffsetMs(timeZone, new Date(first));
  if (offsetFirst === offsetGuess) return new Date(first);
  const second = wallAsUtc - offsetFirst;
  if (zonedOffsetMs(timeZone, new Date(second)) === offsetFirst) {
    return new Date(second);
  }
  return new Date(first);
}

/** Split a UTC instant into its wall date/time in an IANA timezone. */
export function utcToWallParts(
  utcDate: Date,
  timeZone: string
): { date: string; time: string } {
  if (!isValidIanaTimezone(timeZone)) {
    throw new Error("Invalid IANA timezone");
  }
  return wallParts(utcDate, timeZone);
}

/** Human-readable rendering of a UTC instant in an IANA timezone. */
export function formatInTimezone(
  utcDate: Date,
  timeZone: string,
  options?: Intl.DateTimeFormatOptions
): string {
  if (!isValidIanaTimezone(timeZone)) {
    throw new Error("Invalid IANA timezone");
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...options,
  }).format(utcDate);
}

/** Curated timezone list for the composer. America/Boise first: the owner. */
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/Boise", label: "Boise (Mountain Time)" },
  { value: "America/Los_Angeles", label: "Los Angeles (Pacific Time)" },
  { value: "America/Denver", label: "Denver (Mountain Time)" },
  { value: "America/Phoenix", label: "Phoenix (Mountain Standard Time)" },
  { value: "America/Chicago", label: "Chicago (Central Time)" },
  { value: "America/New_York", label: "New York (Eastern Time)" },
  { value: "America/Anchorage", label: "Anchorage (Alaska Time)" },
  { value: "Pacific/Honolulu", label: "Honolulu (Hawaii Time)" },
  { value: "America/Toronto", label: "Toronto (Eastern Time)" },
  { value: "America/Mexico_City", label: "Mexico City (Central Time)" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Europe/Madrid", label: "Madrid" },
  { value: "Africa/Cairo", label: "Cairo" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Kolkata", label: "Kolkata" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Shanghai", label: "Shanghai" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Asia/Seoul", label: "Seoul" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "Pacific/Auckland", label: "Auckland" },
  { value: "UTC", label: "UTC" },
];
