import type { DiscoveryJob, DiscoverySample, CalendarEvent } from '../discovery/providers.js';

const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const FULL_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const pad = (n: number) => String(n).padStart(2, '0');

function monthIndexOf(token: string): number {
  const t = token.trim().toLowerCase();
  const idx = FULL_MONTHS.findIndex(m => m.toLowerCase() === t || m.slice(0, 3).toLowerCase() === t);
  if (idx < 0) throw new Error(`Unknown FOMC month label: ${token}`);
  return idx;
}

/** Scrapes the official FOMC meeting calendar page (no RSS/ICS feed exists).
 *  Throws if zero meetings parse for the current year, so a layout change fails
 *  loudly instead of archiving an empty calendar. Never hand-writes dates. */
export function parseFomcCalendar(html: unknown, receivedAt = new Date().toISOString()): DiscoverySample {
  if (typeof html !== 'string' || html.length < 1000) throw new Error('Invalid FOMC calendar page');
  const currentYear = new Date(receivedAt).getUTCFullYear();
  const targetYears = new Set([currentYear, currentYear + 1]);
  const headingRe = /<a id="\d+">(\d{4}) FOMC Meetings<\/a>/g;
  const headings: { year: number; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(html))) headings.push({ year: Number(match[1]), start: headingRe.lastIndex, end: html.length });
  headings.forEach((h, i) => { if (headings[i + 1]) h.end = headings[i + 1].start; });

  const rowRe = /<strong>([A-Za-z]+(?:\/[A-Za-z]+)?)<\/strong><\/div>[\s\S]{0,120}?fomc-meeting__date[^>]*>([^<]+)<\/div>/g;
  const events: CalendarEvent[] = [];
  for (const heading of headings) {
    if (!targetYears.has(heading.year)) continue;
    const panel = html.slice(heading.start, heading.end);
    rowRe.lastIndex = 0;
    let row: RegExpExecArray | null;
    while ((row = rowRe.exec(panel))) {
      const monthText = row[1];
      const dateText = row[2].trim();
      const sep = dateText.includes('*');
      const cleaned = dateText.replace(/\*/g, '').replace(/\([^)]*\)/g, '').trim();
      const [startDayStr, endDayStr] = cleaned.split('-').map(s => s.trim());
      const startDay = Number(startDayStr);
      const endDay = endDayStr ? Number(endDayStr) : startDay;
      if (!Number.isInteger(startDay) || startDay < 1 || startDay > 31 || !Number.isInteger(endDay) || endDay < 1 || endDay > 31)
        throw new Error(`Invalid FOMC meeting date range: ${dateText}`);
      const [startMonthText, endMonthText] = monthText.split('/');
      const startMonth = monthIndexOf(startMonthText);
      const endMonth = endMonthText ? monthIndexOf(endMonthText) : startMonth;
      const endYear = heading.year + (endMonth < startMonth ? 1 : 0);
      events.push({
        eventType: 'fomc-meeting',
        title: `FOMC Meeting: ${monthText} ${dateText}, ${heading.year}`,
        startsOn: `${heading.year}-${pad(startMonth + 1)}-${pad(startDay)}`,
        endsOn: `${endYear}-${pad(endMonth + 1)}-${pad(endDay)}`,
        sep, sourceUrl: FOMC_CALENDAR_URL, methodologyVersion: 'fomc-calendar-scrape:v1',
      });
    }
  }
  if (!events.some(e => e.startsOn.startsWith(String(currentYear))))
    throw new Error(`No FOMC meetings parsed for ${currentYear}; page layout may have changed`);
  return { members: [], calendar: { events },
    notes: { source: 'Federal Reserve Board official FOMC meeting calendar', scrapedYears: [...targetYears] } };
}

export const fomcCalendarJob: DiscoveryJob = {
  id: 'federalreserve:fomc-calendar:v1', provider: 'federalreserve', kind: 'history', scope: 'macro_indicator',
  intervalSeconds: 604800, offsetSeconds: 3600, membership: 'sample', weight: 1,
  methodologyVersion: 'fomc-calendar-scrape:v1', endpoint: FOMC_CALENDAR_URL, responseFormat: 'text',
  parse: parseFomcCalendar,
};

// FRED release IDs must come from a `fred/releases` probe, never hand-recalled from
// memory. Until that probe is run and the four IDs below are filled in, this array
// stays empty (fails closed) rather than guessing IDs. Resolved 2026-09-11 via a live
// `fred/releases?api_key=...` probe (332 releases returned; matched by exact name):
// 10=Consumer Price Index, 50=Employment Situation, 53=Gross Domestic Product,
// 54=Personal Income and Outlays.
export const RELEASES: { id: string; releaseId: number | null; eventType: CalendarEvent['eventType']; title: string }[] = [
  { id: 'cpi', releaseId: 10, eventType: 'cpi-release', title: 'Consumer Price Index' },
  { id: 'employment', releaseId: 50, eventType: 'employment-release', title: 'Employment Situation' },
  { id: 'gdp', releaseId: 53, eventType: 'gdp-release', title: 'Gross Domestic Product' },
  { id: 'pce', releaseId: 54, eventType: 'pce-release', title: 'Personal Income and Outlays' },
];

export function parseFredReleaseDates(meta: typeof RELEASES[number], payload: unknown): DiscoverySample {
  const rows = (payload as { release_dates?: unknown } | null)?.release_dates;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Invalid FRED release dates for ${meta.id}`);
  const events: CalendarEvent[] = rows.map((row: any) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row?.date))) throw new Error(`Invalid FRED release date for ${meta.id}`);
    return { eventType: meta.eventType, title: meta.title, startsOn: row.date, endsOn: row.date, sep: null,
      sourceUrl: `https://fred.stlouisfed.org/release?rid=${meta.releaseId}`, methodologyVersion: 'fred-release-dates:v1' };
  });
  return { members: [], calendar: { events }, notes: { releaseId: meta.releaseId, scope: `FRED release/dates for ${meta.id}`,
    coverage: 'include_release_dates_with_no_data=true; future scheduled dates included' } };
}

export function releaseDatasetId(id: string): string {
  return `fred:release-dates:${id}:v1`;
}

export const fredReleaseDateJobs: DiscoveryJob[] = RELEASES.every(r => r.releaseId != null)
  ? RELEASES.map(meta => ({
      id: releaseDatasetId(meta.id), provider: 'fred', kind: 'history', scope: 'macro_indicator',
      intervalSeconds: 604800, offsetSeconds: 10800, membership: 'sample', weight: 1,
      methodologyVersion: 'fred-release-dates:v1',
      endpoint: `https://api.stlouisfed.org/fred/release/dates?release_id=${meta.releaseId}&include_release_dates_with_no_data=true&file_type=json`,
      parse: payload => parseFredReleaseDates(meta, payload),
    }))
  : [];
