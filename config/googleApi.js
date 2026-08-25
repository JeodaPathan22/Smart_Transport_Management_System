/**
 * Google API / live GPS tracking integration - FUTURE / INACTIVE.
 *
 * The university's buses do not currently have GPS hardware capable of
 * providing real-time location data, so this integration is intentionally
 * not implemented. This file only reserves a clear place in the
 * architecture for it.
 *
 * When real GPS hardware/data becomes available, a future developer can:
 *   1. Set `enabled: true` below (and provide the relevant API key via an
 *      environment variable - never hard-code credentials here).
 *   2. Implement a small service that reads real device positions and
 *      exposes them to the Student Dashboard / Routes page.
 *
 * Until then, no part of the app may render fake/simulated bus locations,
 * ETAs, or movement - only the official database-driven schedule (see
 * schedules table) and driver-posted text notices are shown to users.
 */

module.exports = {
  enabled: false,
  provider: 'google-maps-platform',
  note: 'Reserved for future GPS/live-tracking integration once bus hardware supports it. Currently inactive - no simulated or fake location data is generated anywhere in this app.',
};
