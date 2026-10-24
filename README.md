# AXIOM BOT

WhatsApp bot (Node.js + Baileys) for private chats and groups. Free-tier friendly, phone-only setup.

**Commands** (prefix `.`): menu, help, ping, awake, status, owner, ai, study, script, block, unblock, remove, tagall, vv, warn, warnings, antilink, autoreply.

## Deploy from an Android phone (about 25 minutes, ₦0)

1. **Files.** Download the zip, extract it with the Files app. All files are in one flat folder on purpose, so you can upload them in one go.
2. **GitHub.** Create repo `axiom-whatsapp-bot` (Private, tick *Add .gitignore: Node*). Tap *Add file > Upload files*, select every extracted file, *Commit changes*.
3. **MongoDB Atlas (stores your WhatsApp session).** cloud.mongodb.com > sign up > create a **Free (M0)** cluster > *Database Access*: add a user + password (letters and numbers only) > *Network Access*: add `0.0.0.0/0` (Render's free tier has no fixed IP) > *Connect > Drivers*: copy the `mongodb+srv://...` string and put your password in place of `<password>`.
4. **Gemini key (optional but recommended).** aistudio.google.com > *Get API key*. Without it the bot uses a keyless fallback that may be slower or less reliable.
5. **Render.** render.com > sign in with GitHub > *New > Web Service* > pick the repo. Settings: Runtime **Node**, Build `npm install`, Start `npm start`, Instance **Free**. Add environment variables:

   | Name | Value |
   |---|---|
   | OWNER_NUMBER | your number with country code, digits only (e.g. 2348012345678) |
   | MONGODB_URI | the Atlas string |
   | ADMIN_TOKEN | any long random text |
   | GEMINI_API_KEY | your key (optional) |
   | NOVADASH_NOTES | extra NovaDash facts the AI may use (optional) |

6. **Link WhatsApp.** Open `https://YOUR-APP.onrender.com/pair?token=YOUR_ADMIN_TOKEN`. On WhatsApp: *Settings > Linked devices > Link a device > Link with phone number instead*, type the code shown. (The code is also in Render > Logs.)
7. **Keep it awake.** Render's free service sleeps after 15 minutes without inbound requests. Create a free monitor at uptimerobot.com: HTTP(s), URL `https://YOUR-APP.onrender.com/health`, every 5 minutes. (UptimeRobot's free plan is for personal, non-commercial use; cron-job.org is an alternative to check.)
8. **Test.** In any chat send `.ping`.

The bot runs as a linked device on **your** WhatsApp account, so you are the owner automatically and your own messages can run owner commands in any chat.

## How things work

- `.vv` (consent-based): reply `.vv` to a view-once message to re-send it as normal media. It works only when the **sender** asks for their own media, or for media the owner sent. It never unlocks other people's view-once media. The bot keeps only an in-memory reference for 30 minutes and downloads nothing unless a permitted `.vv` happens.
- `.antilink on` deletes links from non-admins and warns them (bot must be a group admin). At the warning limit (default 3) the member is removed.
- `.autoreply` is per chat: `.autoreply add price | text`, `.autoreply default text` (private chats, once per hour per person), `on`, `off`, `list`, `del`, `clear`.
- `.ai [novadash|dropship|content|study] question`; reply to a message with `.ai explain this` to include it. `.study chemistry: what is a mole`. `.script topic`.
- Reconnects automatically with backoff; `/health` reports status (503 if disconnected too long); the process exits for a host restart if stuck 15 minutes.

## Security

Never commit `.env` or share `MONGODB_URI`: it contains your WhatsApp session, which is full access to the account. Use a strong Atlas password. Secrets are redacted from logs.

## Tests

`npm test` (Node 20+, no network needed). 46 tests cover utilities, storage, settings, auth persistence, AI client (mocked), every command, permissions, and reconnect logic with a simulated Baileys.

## Honest limitations

- Baileys is an **unofficial** library. WhatsApp can ban accounts that use it; spam, mass messaging and unknown contacts raise the risk. Use at your own risk.
- Not verified against real WhatsApp, Render, Atlas or Gemini in the build sandbox (no network there). First live run may need small fixes, especially Baileys v7 group id handling.
- Free hosting cannot promise 24/7: Render may restart or suspend free services at any time, wakes take about a minute, and 750 free hours/month barely covers one always-on service in a 31-day month.
- The AI keyless fallback and Gemini free limits can change without notice.
