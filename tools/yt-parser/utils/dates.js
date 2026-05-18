const TZ_OFFSET_MINUTES = parseInt(
  process.env.COUNTERS_TZ_OFFSET_MIN || "180",
  10,
); // МСК = UTC+3

function localDateKey(d = new Date()) {
  const shifted = new Date(d.getTime() + TZ_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

module.exports = { localDateKey, TZ_OFFSET_MINUTES };
