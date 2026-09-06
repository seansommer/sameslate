# Message ID update — both games

1. Open [Firebase Realtime Database → Rules](https://console.firebase.google.com/project/fued-728c4/database/fued-728c4-default-rtdb/rules).
2. Replace the rules editor with the **complete latest** `firebase-database.rules.json` from either repository, then choose **Publish**. Both copies are identical. Do this even if you published the earlier launch rules. Leave the database data in place.
3. Refresh Google Feud and Same Slate, then open **Menu → Message Center**.

New players receive a unique 16-character alphanumeric Message ID when their account is created. Existing players receive one automatically when they next sign in or open Message Center. The same permanent ID works in both games and on every device. **Copy ID & nickname** copies both details for sharing.

To start a conversation, enter the other player’s Message ID and current nickname. Both are required. Letter case and pasted spaces or hyphens in the ID are accepted. Changing a nickname keeps the ID and updates the required nickname. Existing messages and replies remain available, including conversations started before this update.

Messaging does not use email addresses. The games keep their existing email-and-nickname sign-in. Messages are delivered inside the apps. This update requires no Cloudflare changes, new Firebase project, external email service, or additional account setup.
