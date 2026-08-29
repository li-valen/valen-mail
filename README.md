# Valen Mail

A self-hosted mail client built to replace Gmail for daily use: several
accounts in one inbox, conversations rather than messages, send tracking,
and the same app on the web, on a phone, and in a native macOS window.

It runs on one always-free VM.

---

## What it does

**One inbox, several accounts.** Up to ten Gmail accounts over IMAP with app
passwords, merged into a single timeline. Paging uses a compound keyset
cursor on `(date, account, uid)`, so two messages arriving in the same
second neither duplicate nor go missing — which a `before`-only cursor does
routinely once four mailboxes share a timeline.

**Conversations, not messages.** Opening mail shows the whole thread stacked
oldest-first — including your own replies out of Sent — collapsed to a line
each and opening in place. Closed messages fetch nothing, so a forty-message
thread costs one request rather than forty.

**Replying happens in the thread.** The composer opens at the foot of the
conversation instead of replacing it, so you can still read what you are
answering.

**Reading is sandboxed.** Message HTML renders in an iframe with no
`allow-scripts` and a restrictive CSP; nothing in a message body ever
executes. The frame measures its own content, so the page has one scrollbar
and never a second one inside the mail.

**Dark mode inverts, it does not recolour.** An email hardcodes its colours
against the white background every client has ever given it, so forcing a
dark background produces black-on-black paragraphs wherever the sender set a
text colour and no background. Inverting is a uniform transform, so the
contrast the sender chose survives and only the lightness flips. Images are
inverted back. There is a per-message escape to the original colours.

**Send tracking.** One pixel per recipient, so an open tells you *who*.
Attachments over a size threshold degrade tracking, and the composer says so
before you send, not after.

**Search operators.** `from:` `to:` `cc:` `subject:` `is:` `has:` `before:`
`after:`, negatable with `-`, over tens of thousands of messages. The search
results show a chip line saying how the query was read, so a typo'd operator
is visible rather than silently treated as literal text.

**Keyboard.** `j`/`k`, Enter, `u`, `s`, `r`/`a`/`f`, `e`, `#`, `x`, g-chords,
`?` for the full list.

**Everywhere.** Installable PWA with Web Push, plus a native macOS app.

---

## Repository layout

| Path | What it is |
|---|---|
| `sync/` | The service. IMAP IDLE, backfill, Postgres, and the JSON API the clients talk to. |
| `client/` | React PWA — inbox, reader, composer, tracking views. |
| `tracking/` | Separate deployment (Vercel Edge + Neon) that serves and records the tracking pixel. |
| `desktop/` | Tauri wrapper: the deployed client in a native macOS window, with its own notifications. |

- [Architecture](docs/architecture.md) — how the four pieces fit and why they are separate.
- [Self-hosting](docs/self-hosting.md) — what you need and how to stand it up.
- [Deploying the sync service](sync/deploy/README.md) — the VM build, tuning, and unit file.

---

## Running the tests

```bash
cd sync   && npm test    # ~1339 tests
cd client && npm test    # ~1700 tests
```

Both suites are framework-free by rule: **no test in this project renders a
component.** Anything that has to be verified is extracted into a plain
module and tested there, which is why the client's tests run in under two
seconds.

The suites are also mutation-checked rather than merely written. The
standing question for any new test is "would this fail if the behaviour were
inverted or deleted?" — and it is asked by actually doing it. That has
caught real no-op tests in this repository more than once, including one
that asserted an import line rather than the value it was supposed to pin.

---

## Honest limitations

- **Gmail only.** Accounts authenticate with app passwords over IMAP. There
  is no OAuth flow and no support for other providers.
- **The macOS app polls.** Its webview cannot do Web Push — `PushManager` is
  undefined and `Notification.requestPermission()` resolves `"denied"`
  without ever prompting — so the Rust side polls every 60s. The phone gets
  real push and is faster.
- **Attachments are never cached.** Metadata only; the bytes are fetched on
  demand.
- **Initial backfill is throttled** against Gmail's daily byte and
  connection limits, so the first sync of a large mailbox takes a while.
- **One user.** Authentication is a single master token, not accounts.

---

## License

MIT — see [LICENSE](LICENSE).
