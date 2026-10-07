// Calendar provider boundary (V3-M).
//
// Today the app syncs with other calendars through .ics files only
// (src/calendar/calendar.js: import as fixed events, export a range). A
// live provider such as Google Calendar would plug in here by implementing
// the same small interface:
//
//   {
//     id: string,
//     isConfigured(): boolean,                 // credentials present?
//     listEvents(from, to): Promise<Event[]>,  // read-only, same shape as calendar.js imports
//     exportEvents(events): Promise<void>,     // optional push
//   }
//
// Google Calendar is intentionally NOT enabled: it needs an OAuth client ID
// and consent screen that belong to the app owner (secrets this repo must
// not contain), so the UI never shows a "Connect Google" button. When the
// owner adds OAuth, implement `google` below and list it as available.

export const PROVIDERS = {
  ics: {
    id: 'ics',
    labelKey: 'calendar3.providerIcs',
    isConfigured: () => true,
  },
  google: {
    id: 'google',
    labelKey: 'calendar3.providerGoogle',
    // Requires VITE_GOOGLE_OAUTH_CLIENT_ID + a server-side token exchange.
    isConfigured: () => false,
  },
};

export function availableProviders() {
  return Object.values(PROVIDERS).filter((p) => p.isConfigured());
}
