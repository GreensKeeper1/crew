# Crew Films comments and sign-up

Viewers can read comments on every movie, trailer and poster. To leave one they
sign up once: their **email is the user name** and they **pick a 6-digit code**.
A cookie keeps them signed in on that device for a year. The owner gets an email
for each new sign-up.

Nothing here costs money or needs a new account: the online part runs on the
owner's own Google account, and the show part runs on any computer at home.

```
 phones / laptops ──Wi-Fi──► show box on the home LAN (server/crew_server.py)
 4K projector browser ─────►   • the gallery + films from media/ (no Internet needed)
                               • comments + sign-ups in server/data/crew.db
                               • when Internet is back: syncs ▲▼ every minute
                                                             │
 anyone online ─► GitHub Pages gallery ──► Google Apps Script + Sheet (Code.gs)
                                             • same comments, same sign-ups
                                             • emails the owner on each sign-up
```

## The pieces

| File | What it is |
|---|---|
| `comments/comments.js`, `comments.css` | Adds the Comment buttons and the sign-up / comment window to `movies.html`. |
| `comments/config.js` | The online service's URL. Empty = comments stay hidden on the public site. |
| `server/crew_server.py` | The show server for offline nights. Python 3 standard library only. |
| `server/apps_script/Code.gs` | The online service (Apps Script web app bound to a Google Sheet). |

`movies.html` needs these three tags before `</body>`. Whatever regenerates the
gallery must keep them (the show server puts them back by itself if they go missing):

```html
<link rel="stylesheet" href="comments/comments.css"><script src="comments/config.js"></script><script src="comments/comments.js" defer></script>
```

## Offline show (no Internet)

On the show box, in the repo folder:

```
python3 server/crew_server.py init          # once: makes server/crew.conf.json (kept out of git)
python3 server/crew_server.py fetch-media   # while online: copies every film into media/
python3 server/crew_server.py serve         # the show, on port 8080
```

Open `http://<show-box>:8080/movies.html` on the projector and on phones on the same
Wi-Fi. Films play from the show box with seeking, so a 4K projector streams over the LAN.
Comments and sign-ups made at the show are saved there and marked
"waiting to go online" until the box can reach the online service.

`python3 server/crew_server.py hide --list` and `hide <id>` hide a comment locally.

## Online service (Google Apps Script)

1. Make a Google Sheet called "Crew Films comments". Extensions > Apps Script. Paste `Code.gs`.
2. Project Settings > Script Properties: `PEPPER` (copy `pepper` from `crew.conf.json`),
   `OWNER_EMAIL`, `SYNC_KEY` (any long random string), and `NOTIFY` = `on` to send the sign-up emails.
3. Run `setup` once and accept Google's permission prompt (Sheets + send email as you).
4. Deploy > New deployment > Web app. Execute as **Me**, access **Anyone**. Copy the `/exec` URL.
5. Put that URL in `comments/config.js` (`ONLINE_API`) and in `crew.conf.json`
   (`online_api`), plus the same `sync_key`.

Moderation: type `TRUE` in a comment's `hidden` column. Delete a viewer by deleting
their row in `Users`.

## Security and privacy, honestly

* A 6-digit code has one million combinations. It is a light lock for comments, not
  a password. It is never stored as typed: each is salted and HMAC-SHA256'd with a
  secret pepper that lives only in Script Properties and `crew.conf.json`.
* After 5 wrong codes an email is locked for 15 minutes. Online, sign-ins pause for
  an hour after 200 wrong codes in total; on the LAN, a device that keeps failing is
  slowed down. Posting is limited to 5 comments a minute.
* The cookie holds a random token, not the code; only the token's hash is stored.
  The online page sets it from script, so it isn't HttpOnly. Fine for comments, not
  for anything that matters.
* Emails are never shown to other viewers. The sign-up window has a short note
  saying what the email is used for and that people can ask to be deleted.
* Comment text is always shown as plain text, so nobody can inject code into the page.
