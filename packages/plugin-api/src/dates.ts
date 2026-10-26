// Dates and times as Ivy writes them and the user reads them, local to the machine.

/**
 * A calendar date, YYYY-MM-DD, in the machine's timezone: the dates Ivy writes and the user
 * reads. Plugins share it so they agree on what "today" is.
 */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "21:40": a time of day, local, as Ivy writes and the user reads it. */
export function localTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
