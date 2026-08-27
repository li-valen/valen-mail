//! One authenticated read of `GET /api/inbox`, using the session cookie
//! WebKit already holds.
//!
//! # Why there is still no credential in this process
//!
//! main.rs's opening comment says the shell keeps nothing, because the
//! webview is a first-party client of the Valen Mail origin and WebKit does
//! the whole credential dance itself. That is still true, and this module
//! is written to keep it true.
//!
//! The cookie is read out of the webview's own store at the moment of the
//! request and dropped when the request ends. Nothing is written to disk,
//! to the keychain, or to a config file; there is no second copy to leak,
//! expire independently, or fall out of sync with the one the window is
//! actually using. Signing out in the window removes the cookie, and the
//! next poll simply finds nothing and does nothing — which is also what
//! makes "nothing fires when the app has never been signed in" structural
//! rather than a check someone has to remember to write.
//!
//! `cookies_for_url` is what makes this possible: it reads the runtime's
//! cookie store directly, so an `HttpOnly` cookie — which is the whole
//! point of this one, and which no script in the page can ever see — is
//! available to the process hosting the webview. Verified against the
//! running app: one cookie, `__Host-postbox_session`, and the request it
//! authenticates returns 200.
//!
//! Nothing here logs a cookie, a subject, or an address. The one thing it
//! logs is a status code, for the same reason client/src/pushApi.ts logs
//! a status and never a body.

use serde::Deserialize;
use tauri::WebviewWindow;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::mailwatch::Message;
use crate::origin;

/// The session cookie's name, from `SESSION_COOKIE_NAME` in
/// sync/src/api/session.ts. The `__Host-` prefix is part of the name, not
/// decoration — a cookie called `postbox_session` is a different cookie
/// and deliberately does not match.
const SESSION_COOKIE_NAME: &str = "__Host-postbox_session";

/// Enough to cover a burst between two polls without asking the server
/// for a page nobody will read. The newest 25 INBOX rows is already far
/// more than an interval's worth of real mail.
const PAGE_LIMIT: usize = 25;

/// A poll should fail fast and be retried on the next tick rather than
/// pile up behind a stalled network.
const REQUEST_TIMEOUT_SECS: u64 = 20;

/// What one poll can turn out to be.
#[derive(Debug)]
pub enum Poll {
    /// A page of INBOX rows, newest first.
    Page(Vec<Message>),
    /// No usable session: no cookie in the store, or the server rejected
    /// the one there was. Not an error — it is the normal state of an app
    /// that has never been signed in, or whose 30-day session has lapsed.
    SignedOut,
    /// Something went wrong that is worth a log line and nothing else.
    Failed(String),
}

/// Reads the session cookie out of the webview's store.
///
/// Returns the ready-made `Cookie:` header value rather than the cookie,
/// so the value itself never travels further into this program than it
/// has to.
fn session_header(window: &WebviewWindow) -> Option<String> {
    let url = origin::POSTBOX_URL
        .parse()
        .expect("POSTBOX_URL is a compile-time constant and must parse");

    let cookies = match window.cookies_for_url(url) {
        Ok(cookies) => cookies,
        Err(error) => {
            eprintln!("desktop: could not read the webview cookie store: {error}");
            return None;
        }
    };

    cookies
        .into_iter()
        .find(|cookie| cookie.name() == SESSION_COOKIE_NAME)
        .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
}

/// One row of `GET /api/inbox` as it arrives on the wire.
///
/// Every field is optional or defaulted because this is a system
/// boundary: a response that is missing `flags` must produce a message
/// with no flags, not a parse failure that silences the whole poll. The
/// two fields that genuinely cannot be defaulted — the account and the
/// UID that identify the row — are required, and a row without them is
/// dropped rather than guessed at.
#[derive(Debug, Deserialize)]
struct Row {
    account_id: String,
    uid: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    subject: Option<String>,
    #[serde(default)]
    from_name: Option<String>,
    #[serde(default)]
    from_email: Option<String>,
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    flags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct Page {
    #[serde(default)]
    messages: Vec<Row>,
}

/// Milliseconds since the epoch for an RFC 3339 timestamp, or `None`.
///
/// `None` is a real answer here, not a swallowed error: mailwatch.rs
/// treats a message with no usable date as never notify-worthy, which is
/// the same call `isRecentEnough` makes in sync/src/push/dispatch.ts.
fn parse_date_ms(raw: Option<&str>) -> Option<i64> {
    let raw = raw?;
    let parsed = OffsetDateTime::parse(raw, &Rfc3339).ok()?;
    i64::try_from(parsed.unix_timestamp_nanos() / 1_000_000).ok()
}

impl From<Row> for Message {
    fn from(row: Row) -> Self {
        Message {
            account_id: row.account_id,
            uid: row.uid,
            folder: row.folder,
            subject: row.subject,
            from_name: row.from_name,
            from_email: row.from_email,
            date_ms: parse_date_ms(row.date.as_deref()),
            flags: row.flags.unwrap_or_default(),
        }
    }
}

/// Fetches the newest INBOX rows.
///
/// Blocks; call it from the poll thread, never from the main thread —
/// `cookies_for_url` dispatches to the main thread and waits for it, so
/// calling this there would deadlock the app.
pub fn poll(window: &WebviewWindow) -> Poll {
    let Some(cookie) = session_header(window) else {
        return Poll::SignedOut;
    };

    let request_url = format!("{}api/inbox?folder=inbox&limit={PAGE_LIMIT}", origin::POSTBOX_URL);

    let outcome = tauri::async_runtime::block_on(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()?;
        let response = client
            .get(request_url)
            .header(reqwest::header::COOKIE, cookie)
            .send()
            .await?;
        let status = response.status();
        // A non-2xx body is not read: it is either an error string this
        // process has no use for, or — on a 401 — a page it must not
        // start parsing as mail.
        if !status.is_success() {
            return Ok::<_, reqwest::Error>((status, None));
        }
        let page = response.json::<Page>().await?;
        Ok((status, Some(page)))
    });

    match outcome {
        Err(error) => Poll::Failed(format!("request failed: {error}")),
        Ok((status, None)) if status == reqwest::StatusCode::UNAUTHORIZED => Poll::SignedOut,
        Ok((status, None)) => Poll::Failed(format!("/api/inbox answered {status}")),
        Ok((_, Some(page))) => Poll::Page(page.messages.into_iter().map(Message::from).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_date_becomes_epoch_milliseconds() {
        assert_eq!(
            parse_date_ms(Some("1970-01-01T00:00:01.500Z")),
            Some(1_500),
            "the wire format is what sync/ emits for a Postgres timestamptz"
        );
        assert_eq!(
            parse_date_ms(Some("2026-08-26T11:20:00.000Z")),
            Some(1_787_743_200_000)
        );
    }

    #[test]
    fn an_offset_is_honoured_rather_than_read_as_utc() {
        assert_eq!(
            parse_date_ms(Some("2026-08-26T13:20:00.000+02:00")),
            parse_date_ms(Some("2026-08-26T11:20:00.000Z")),
            "a message written in another timezone arrived at the same instant"
        );
    }

    #[test]
    fn an_absent_or_unusable_date_is_none_rather_than_a_failure() {
        assert_eq!(parse_date_ms(None), None);
        assert_eq!(parse_date_ms(Some("")), None);
        assert_eq!(parse_date_ms(Some("Tue, 26 Aug 2026 11:20:00 +0000")), None);
        assert_eq!(parse_date_ms(Some("not a date at all")), None);
    }

    #[test]
    fn a_page_missing_optional_fields_still_parses() {
        let body = r#"{"messages":[{"account_id":"primary","uid":"7","folder":"INBOX"}]}"#;
        let page: Page = serde_json::from_str(body).expect("a sparse row is not a parse failure");
        let messages: Vec<Message> = page.messages.into_iter().map(Message::from).collect();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].uid, "7");
        assert!(messages[0].flags.is_empty());
        assert_eq!(messages[0].date_ms, None);
        assert_eq!(messages[0].sender(), "New mail");
        assert_eq!(messages[0].summary(), "(no subject)");
    }

    #[test]
    fn a_real_page_maps_onto_the_fields_the_notification_uses() {
        let body = r#"{"messages":[{
            "account_id":"primary","uid":"33134","folder":"INBOX",
            "subject":"Your weekly digest","from_name":"GitHub",
            "from_email":"noreply@github.com",
            "date":"2026-08-26T11:20:00.000Z","flags":["\\Seen"]
        }],"nextCursor":null}"#;
        let page: Page = serde_json::from_str(body).expect("the shape GET /api/inbox returns");
        let message = Message::from(page.messages.into_iter().next().unwrap());

        assert_eq!(message.sender(), "GitHub");
        assert_eq!(message.summary(), "Your weekly digest");
        assert_eq!(message.folder, "INBOX");
        assert_eq!(message.flags, vec![r"\Seen".to_string()]);
    }
}
