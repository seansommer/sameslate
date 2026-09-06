# Google Feud fixes and Same Slate launch

The same Firebase project (`fued-728c4`) now supports both games. Keep its existing configuration and accounts. Do not create a replacement Firebase project or erase database data.

## 1. Publish the shared Firebase rules once

1. Open https://console.firebase.google.com/project/fued-728c4/database/fued-728c4-default-rtdb/rules.
2. Confirm **Realtime Database → Rules** is selected (not Firestore).
3. Copy the complete contents of `firebase-database.rules.json` from either repository. Both copies are identical.
4. Replace the rules editor contents and select **Publish**.
5. Refresh both games. Existing users and host/master roles remain in place.

This is needed for Same Slate rooms, hidden answers, shared messages and cross-game player-card records. Google Feud's existing paths remain intact.

## 2. Update the existing Google Feud suggestion Worker

1. Open https://dash.cloudflare.com/ and choose **Workers & Pages**.
2. Open **googlefeud-suggestions**, then **Edit code**.
3. Replace the editor contents with the complete `cloudflare-worker/deploy-worker.js` file from the Google Feud repository. It is a single-file version with no external module imports.
4. Deploy the Worker.
5. Keep the existing `SERPAPI_KEY` secret. Keep `ALLOWED_ORIGIN` set to `https://seansommer.github.io` (the origin has no `/googlefeud` path).

Same Slate makes no suggestion requests and requires no Cloudflare Worker or API key.

Autocomplete improvements preserve the provider's ranking, reject results that do not actually complete the prompt, and collapse duplicates caused by punctuation, capitalization or straightforward plural forms. Meaningfully different completions remain distinct. A weak question is skipped in favor of another prepared question. No missing answers are invented. Results still reflect the provider's current U.S. English autocomplete sample, which can differ from a person's personalized Google suggestions.

## 3. Enable GitHub Pages for the new repository

1. Open https://github.com/seansommer/sameslate/settings/pages.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open https://github.com/seansommer/sameslate/actions.
4. Open **Verify and deploy Same Slate**, select **Run workflow**, and run it on **main**. If the first automatic deployment already succeeded, skip this repeat run.
5. Open https://seansommer.github.io/sameslate/ after the workflow completes.

The workflow verifies scoring and Firebase rules with a demo emulator, builds static files, and publishes the app. It never publishes production Firebase rules or changes production database records.

## 4. Start a game

Use the same email and nickname used in Google Feud. Existing approved hosts can immediately create games. The master account can approve new host requests in either app.

Create a room with 2–32 players, choose one or both card types, and choose either 1 point for any match or 1 point for every other matching player. For example, four identical answers award each matching player 1 point in the first mode or 3 points in the second. Team mode, round timers, Total Points / Most Rounds Won, host score corrections, game history, records and player cards remain available.

Message Center is under **Menu** in both games. Every player has a permanent 16-character Message ID shown with their nickname and a copy button. Sending a new message requires the recipient’s ID and current nickname, with no email address. Existing users receive an ID automatically on sign-in or when they open Message Center. Publish the newest shared rules even if you previously published the initial launch rules. See [Message ID setup](MESSAGE_IDS.md). It delivers messages inside the apps, including replies and read status. It sends no external emails or push notifications. The existing family-trust email/nickname entry is not proof of email ownership, so these messages are appropriate for the game group, not sensitive communications.

Player cards display both games' records under the same profile. Each game keeps its own scoring totals, Hall of Fame and history. Nickname changes update the shared profile and both game histories. Deleting a game rolls back only that game's records.

## GitHub access

Current installation settings: https://github.com/settings/installations/156846746. Under repository access, keep **googlefeud** and **sameslate** selected.

## Google Feud behavior changes

- Players no longer press a next-round readiness button. The host starts each next round.
- Everyone sees every submitted answer and round score during review and recaps.
- Incoming player submissions update room status without rebuilding another player's answer or score form.
- Final-score drafts and board references survive refreshes and are scoped to player, game and round.
- Players viewing the recap follow the host automatically into the next round or finale.
- Each game maintains its own offline cache on the shared GitHub Pages origin.
