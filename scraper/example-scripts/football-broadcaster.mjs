/**
 * Match the next fixture for sensor.team_tracker_bha against the listings on
 * live-footballontv.com and publish the TV broadcaster as a new sensor.
 *
 * Reads:  sensor.team_tracker_bha (team_tracker integration, expects state "PRE"
 *         with team_long_name/opponent_long_name/date attributes).
 * Writes: sensor.team_tracker_bha_broadcaster (state = channel name or a status
 *         string like "No match found" / "unavailable"; attributes include the
 *         event, kickoff, competition, full channel list and source URL).
 *
 * Source: https://www.live-footballontv.com/england-women-on-tv.html
 */

export const cron = '0 6,12 * * *'; // 06:00 and 12:00 daily

const SOURCE_ENTITY = 'sensor.team_tracker_bha';
const OUTPUT_ENTITY = 'sensor.team_tracker_bha_broadcaster';
const SOURCE_URL = 'https://www.live-footballontv.com/england-women-on-tv.html';

export default async function handler(context) {
  const { hass, cheerio } = context;
  const now = new Date().toISOString();

  try {
    if (!hass) {
      const payload = {
        success: false,
        error: 'hass client not available (running outside Home Assistant)',
      };
      console.warn(payload.error);
      return payload;
    }

    const source = await hass.getState(SOURCE_ENTITY);
    if (source.state !== 'PRE') {
      const payload = {
        success: true,
        matched: false,
        state: 'unavailable',
        reason: `source sensor not in PRE state (was "${source.state}")`,
      };
      await hass.setState(OUTPUT_ENTITY, 'unavailable', {
        friendly_name: 'BHA Broadcaster',
        reason: payload.reason,
        source_entity: SOURCE_ENTITY,
        source_url: SOURCE_URL,
        last_update: now,
      });
      return payload;
    }

    const a = source.attributes || {};
    const fixture = {
      teamShort: a.team_name,
      teamLong: a.team_long_name,
      opponentShort: a.opponent_name,
      opponentLong: a.opponent_long_name,
      kickoff: a.date,
      eventName: a.event_name,
    };

    if (!fixture.kickoff || !fixture.teamLong || !fixture.opponentLong) {
      throw new Error(
        `missing required attributes on ${SOURCE_ENTITY}: need date, team_long_name, opponent_long_name`
      );
    }

    const response = await fetch(SOURCE_URL);
    if (!response.ok) {
      throw new Error(
        `fetch ${SOURCE_URL} failed: ${response.status} ${response.statusText}`
      );
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    const fixtures = parseFixtures($);
    if (fixtures.length === 0) {
      console.warn('parseFixtures returned 0 rows; page markup may have changed');
    }

    const targetDate = ukDateKey(new Date(fixture.kickoff));
    const match = findMatch(fixtures, targetDate, fixture);

    let state;
    let channels = [];
    let matched = false;
    let competition = null;
    let kickoffTime = null;
    let teamsText = null;

    if (!match) {
      state = 'No match found';
    } else {
      matched = true;
      channels = match.channels;
      competition = match.competition;
      kickoffTime = match.kickoffTime;
      teamsText = match.teams;
      state = channels.length > 0 ? channels[0] : 'No broadcast listed';
    }

    const attributes = {
      friendly_name: 'BHA Broadcaster',
      matched,
      channels,
      competition,
      kickoff_time: kickoffTime,
      kickoff: fixture.kickoff,
      event_name: fixture.eventName,
      fixture_teams: teamsText,
      target_date: targetDate,
      source_entity: SOURCE_ENTITY,
      source_url: SOURCE_URL,
      last_update: now,
    };

    await hass.setState(OUTPUT_ENTITY, state, attributes);

    return { success: true, state, matched, channels, attributes };
  } catch (error) {
    console.error('football-broadcaster failed:', error);
    if (hass) {
      try {
        await hass.setState(OUTPUT_ENTITY, 'error', {
          friendly_name: 'BHA Broadcaster',
          error: error.message,
          source_entity: SOURCE_ENTITY,
          source_url: SOURCE_URL,
          last_update: now,
        });
      } catch (_) {
        // swallow — the original error is what matters
      }
    }
    return { success: false, error: error.message };
  }
}

/**
 * Walk the page and return fixtures as
 *   { dateKey, kickoffTime, teams, competition, channels[] }.
 * The page groups fixtures by date heading followed by fixture rows. Exact
 * class names drift occasionally, so we try known classes first and fall back
 * to a structural walk driven by heading elements.
 */
function parseFixtures($) {
  const results = [];
  let currentDateKey = null;

  // Fixture containers on the current version of the site use class
  // "fixture"; date headings use "MatchDate" (or similar heading tags). We
  // iterate every element in document order under the main listing area and
  // keep track of the most recent date heading seen.
  const root = $('#fixtures-schedule, .fixtures, body').first();
  root.find('*').each((_, el) => {
    const $el = $(el);
    const text = $el.clone().children().remove().end().text().trim();

    if (looksLikeDateHeading($el, text)) {
      const key = parseDateHeading(text);
      if (key) currentDateKey = key;
      return;
    }

    if (!currentDateKey) return;
    if (!looksLikeFixtureRow($el)) return;

    const kickoffTime = firstText(
      $el,
      '.fixture__time, .time, .kickoff, .KickOff'
    );
    const teams = firstText($el, '.fixture__teams, .teams, .Teams');
    const competition = firstText(
      $el,
      '.fixture__competition, .competition, .Competition'
    );
    const channelsRaw = firstText(
      $el,
      '.fixture__channel, .channel, .channels, .Channel'
    );

    if (!teams || !kickoffTime) return;

    const channels = channelsRaw
      ? channelsRaw
          .split(/\s*(?:,|\/| and )\s*/i)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    results.push({
      dateKey: currentDateKey,
      kickoffTime,
      teams,
      competition,
      channels,
    });
  });

  return dedupeFixtures(results);
}

function firstText($row, selector) {
  const node = $row.find(selector).first();
  if (!node.length) return null;
  const text = node.text().replace(/\s+/g, ' ').trim();
  return text || null;
}

function looksLikeDateHeading($el, text) {
  const tag = ($el.prop('tagName') || '').toLowerCase();
  if (!/^h[1-6]$/.test(tag) && !/matchdate|fixture__date|fixture-date/i.test($el.attr('class') || '')) {
    return false;
  }
  return /\b\d{1,2}(st|nd|rd|th)?\b/.test(text) && /\b20\d{2}\b/.test(text);
}

function looksLikeFixtureRow($el) {
  const cls = $el.attr('class') || '';
  if (/\bfixture(__row|-row|)\b/.test(cls)) return true;
  if (/\bmatch(__row|-row|)\b/.test(cls)) return true;
  return false;
}

function parseDateHeading(text) {
  // Expected shape e.g. "Saturday 25th April 2026".
  const cleaned = text.replace(/(\d+)(st|nd|rd|th)/i, '$1');
  const parsed = new Date(cleaned + ' UTC');
  if (Number.isNaN(parsed.getTime())) return null;
  return ymd(parsed);
}

function ukDateKey(date) {
  // live-footballontv.com groups by UK local date. Europe/London shifts
  // between GMT and BST; Intl handles that without pulling in a tz lib.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

function dedupeFixtures(fixtures) {
  const seen = new Set();
  const out = [];
  for (const f of fixtures) {
    const key = `${f.dateKey}|${f.kickoffTime}|${f.teams}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

function findMatch(fixtures, targetDate, fixture) {
  const wanted = [
    normaliseTeam(fixture.teamLong),
    normaliseTeam(fixture.teamShort),
  ].filter(Boolean);
  const wantedOpp = [
    normaliseTeam(fixture.opponentLong),
    normaliseTeam(fixture.opponentShort),
  ].filter(Boolean);

  for (const f of fixtures) {
    if (f.dateKey !== targetDate) continue;
    const sides = splitTeams(f.teams);
    if (!sides) continue;
    const [a, b] = sides.map(normaliseTeam);
    const homeMatch = anyMatch(a, wanted) && anyMatch(b, wantedOpp);
    const awayMatch = anyMatch(a, wantedOpp) && anyMatch(b, wanted);
    if (homeMatch || awayMatch) return f;
  }
  return null;
}

function splitTeams(teamsText) {
  const parts = teamsText.split(/\s+v(?:s)?\s+/i);
  if (parts.length !== 2) return null;
  return parts.map((p) => p.trim());
}

function normaliseTeam(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(fc|afc|women|ladies|wfc)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function anyMatch(candidate, wanted) {
  if (!candidate) return false;
  return wanted.some(
    (w) => w && (candidate === w || candidate.includes(w) || w.includes(candidate))
  );
}
