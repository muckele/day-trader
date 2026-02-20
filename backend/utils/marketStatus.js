const TIME_ZONE = 'America/New_York';

function getTimeZoneParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);

  const lookup = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  }

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    weekday: lookup.weekday,
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second)
  };
}

function getTimeZoneOffset(date) {
  const parts = getTimeZoneParts(date);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

function makeDateInTimeZone(year, month, day, hour, minute) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = getTimeZoneOffset(utcGuess);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - offset);
}

function isWeekend(weekday) {
  return weekday === 'Sat' || weekday === 'Sun';
}

function nextBusinessDay(parts) {
  let probe = makeDateInTimeZone(parts.year, parts.month, parts.day, 12, 0);
  while (true) {
    probe = new Date(probe.getTime() + 24 * 60 * 60 * 1000);
    const probeParts = getTimeZoneParts(probe);
    if (!isWeekend(probeParts.weekday)) {
      return probeParts;
    }
  }
}

function getMarketStatus(now = new Date()) {
  const parts = getTimeZoneParts(now);
  const openTime = makeDateInTimeZone(parts.year, parts.month, parts.day, 9, 30);
  const closeTime = makeDateInTimeZone(parts.year, parts.month, parts.day, 16, 0);

  let status = 'CLOSED';
  let nextOpen;
  let nextClose;

  if (!isWeekend(parts.weekday) && now >= openTime && now < closeTime) {
    status = 'OPEN';
    nextClose = closeTime;
    const nextParts = nextBusinessDay(parts);
    nextOpen = makeDateInTimeZone(
      nextParts.year,
      nextParts.month,
      nextParts.day,
      9,
      30
    );
  } else if (!isWeekend(parts.weekday) && now < openTime) {
    nextOpen = openTime;
    nextClose = closeTime;
  } else {
    const nextParts = nextBusinessDay(parts);
    nextOpen = makeDateInTimeZone(
      nextParts.year,
      nextParts.month,
      nextParts.day,
      9,
      30
    );
    nextClose = makeDateInTimeZone(
      nextParts.year,
      nextParts.month,
      nextParts.day,
      16,
      0
    );
  }

  return {
    status,
    asOf: now.toISOString(),
    nextOpen: nextOpen?.toISOString(),
    nextClose: nextClose?.toISOString()
  };
}

module.exports = { getMarketStatus };
