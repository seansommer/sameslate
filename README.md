# Same Slate

Fill the blank. Find your match.

A multiplayer word-matching game for 2–32 people, built from the same interface and feature set as [Google Feud](https://seansommer.github.io/googlefeud/). Baloo 2 and Inter fonts, familiar game controls, new teal/gold artwork.

**Play:** https://seansommer.github.io/sameslate/
**Launch checklist:** [docs/LAUNCH.md](docs/LAUNCH.md)

## Game choices

- 500 `Word ____` cards and 500 `____ Word` cards. Enable either orientation or both.
- One point for any match, or one point for each other player with the same answer.
- 1–20 rounds, optional 10–300 second timer (30 seconds by default).
- Individual play or up to four named/colorable teams; host can play too.
- Win by Total Points or Most Rounds Won. Ties share the win.
- Automatic scoring, grouped answer reveals, host score corrections, and host-controlled round starts.

The built-in card bank is original general vocabulary, not a transcription of a commercial deck. Capitalization, punctuation, accents and extra whitespace are normalized; different spellings and plurals remain distinct. Blank or missing answers do not match.

## Preserved features

Shared email/nickname entry, master/host/player roles, host requests and approvals, custom card submissions and approval/editing, dashboards, game history, round details, game deletion with record rollback, Hall of Fame, player cards, individual/team celebrations, sound settings, synthesized music, mobile layouts, night mode, home links, app icons and offline shell. The footer retains **Created by Sean**.

A shared Message Center supports exact email/nickname lookup, replies, read status and deletion of your own copy. No emails or push notifications are sent. Existing family-trust login remains unchanged.

## Shared Firebase project

Both games use the existing `fued-728c4` Firebase Realtime Database and Anonymous Authentication setup. Keep the original Firebase configuration. Shared `users`, `sessions`, `loginLookup`, `hostRequests` and `mailboxes` paths connect both games. Same Slate's game data, card submissions and records use separate `sameSlate…` paths. Answers stay in `sameSlateAnswers` until reveal; ordinary players cannot read other players' private submissions. The host is trusted to run the game and can access submissions for scoring.

Publish the complete `firebase-database.rules.json` once. The identical file is in both repositories. Each player card displays both games' stats separately; scores with different rules are not added into one misleading leaderboard.

Same Slate needs no Google API, SerpApi subscription, Cloudflare Worker, new Firebase project, email provider or paid server.

## Development

The browser app uses native ES modules. Production loads Firebase 12.18.0 from Google's CDN; the npm packages are verification tools only.

```sh
npm ci
npm test
npm run test:database
npm run build
```

Database tests require Java 21 and download the Firebase demo emulator. They run only on `demo-same-slate`, never the production database. GitHub Actions performs these checks before publishing `dist/`.

The deployable static output includes only HTML, CSS, JavaScript, images and the offline manifest. Private service keys are not part of the app. Firebase's web configuration identifies the public project; access is controlled by database rules.
