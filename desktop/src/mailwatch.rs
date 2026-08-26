//! Which of a polled inbox page is "new mail worth a notification".
//!
//! Pure, and separated from the polling and the notification for exactly
//! the reason origin.rs is separated from the navigation closure: this is
//! the decision that can be wrong in ways nobody notices — a notification
//! that never fires, or fifty that fire at once — so it lives where a
//! test can call it directly, with no window, no network and no clock.
//!
//! # This is deliberately the sync service's shape, not a new one
//!
//! `sync/src/imap/new-mail-marks.ts` already decides this question for
//! Web Push, and its two load-bearing properties are reproduced here
//! rather than reinvented:
//!
//!  * **The first cycle only baselines.** A fresh process against an
//!    existing mailbox reports nothing, no matter how much mail it sees.
//!    That is what stops launching the app from firing a notification for
//!    every message already in the inbox.
//!  * **The bookkeeping is in-memory and resets on restart** — by design
//!    there too, and for the same reason: there is no durable resume point
//!    to trust, so every start re-earns "new" from a clean baseline
//!    instead of from stale state.
//!
//! It also inherits `sync/src/push/dispatch.ts`'s recency guard verbatim
//! (`NEW_MAIL_SANITY_WINDOW_MS`), so a message that is on its face old
//! never reads to the user as mail that just arrived.
//!
//! # Where it deliberately differs, and why that is not "a worse version"
//!
//! The sync service compares raw IMAP UIDs against a per-folder
//! high-water mark, which forces it to carry a UIDVALIDITY branch: when
//! the server renumbers a mailbox downward, `uid > previousMax` becomes
//! false forever and every notification stops silently.
//!
//! This process cannot see UIDVALIDITY at all — `GET /api/inbox` does not
//! expose it — so reproducing a high-water mark here would reproduce that
//! failure mode with no way to detect it. Instead it remembers the exact
//! `(account, uid)` pairs it has already accounted for. A renumbered
//! mailbox then produces pairs this process has not seen, which is the
//! correct answer, with no UIDVALIDITY branch to get wrong.
//!
//! The obvious cost of a set over a scalar is that it grows. It does not:
//! `is_recent` rejects anything older than the window before the set is
//! ever consulted, so an entry past the window can never change an
//! outcome and is pruned. What is retained is bounded by "mail that
//! arrived in the last hour", not by mailbox size.

use std::collections::HashMap;

/// The folder `GET /api/inbox?folder=inbox` reports rows from.
///
/// Checked rather than assumed. The sync service's own new-mail dispatch
/// is guarded to INBOX (see the INBOX-only guard `sync/src/imap/pool.ts`
/// applies before calling `notifyNewMail`), and this is the same guard:
/// it is what keeps the user's own sent mail out of the notifications,
/// since Sent is simply never a folder this poll asks for or accepts.
const INBOX_FOLDER: &str = "INBOX";

/// IMAP's read flag, as `sync/src/normalize.ts` emits it and as
/// `client/src/components/messageFlags.ts` reads it. Membership decides
/// read/unread; position in the array means nothing.
const SEEN_FLAG: &str = r"\Seen";

/// `NEW_MAIL_SANITY_WINDOW_MS` from `sync/src/push/dispatch.ts`, same
/// value and same reason: a message that is on its face old must not read
/// to the user as mail that just arrived, however novel it looks to the
/// bookkeeping. One hour is generous slack for real delivery delay.
const SANITY_WINDOW_MS: i64 = 60 * 60 * 1000;

/// How many notifications one poll may raise.
///
/// **Not a taste call.** Every notification this app posts occupies a
/// thread until the user answers it or the banner times out (see
/// notify.rs — the click callback is what brings the window forward, and
/// `NSUserNotificationCenter` only delivers it to a blocked caller). An
/// uncapped burst is therefore an uncapped thread count, so a quiet hour
/// followed by a mailing-list flush would spawn one thread per message.
///
/// The overflow is not dropped silently in the sense that matters: every
/// message the poll saw is still recorded as accounted for, so the ones
/// past the cap simply never buzz — they are still in the inbox, one
/// keystroke away, which is the right trade against a wall of banners.
const MAX_PER_POLL: usize = 5;

/// One row of `GET /api/inbox`, reduced to the fields this decision and
/// the notification actually use. Parsed at the network boundary in
/// inbox.rs; by the time a value reaches this module it is already
/// validated data rather than wire JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub account_id: String,
    pub uid: String,
    pub folder: String,
    pub subject: Option<String>,
    pub from_name: Option<String>,
    pub from_email: Option<String>,
    /// The message's own `Date`, in milliseconds since the epoch. `None`
    /// when the header was absent or unparsable — which is never
    /// notified for, exactly as `isRecentEnough` in dispatch.ts decides:
    /// no date is no basis for "this just arrived".
    pub date_ms: Option<i64>,
    pub flags: Vec<String>,
}

impl Message {
    /// `!flags.includes('\Seen')`, the same predicate as `isUnread` in
    /// client/src/components/messageFlags.ts.
    fn is_unread(&self) -> bool {
        !self.flags.iter().any(|flag| flag == SEEN_FLAG)
    }

    /// The notification's title. Gmail's shape, matching
    /// `buildMailNotification` in sync/src/push/dispatch.ts exactly: the
    /// SENDER is the title, because the OS already prefixes the app name
    /// and "who wants me" is what makes a banner glanceable.
    pub fn sender(&self) -> String {
        let named = self
            .from_name
            .as_deref()
            .or(self.from_email.as_deref())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        named.unwrap_or("New mail").to_string()
    }

    /// The notification's body — the subject, or dispatch.ts's same
    /// `'(no subject)'` placeholder.
    pub fn summary(&self) -> String {
        let subject = self
            .subject
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        subject.unwrap_or("(no subject)").to_string()
    }
}

/// A `(account, uid)` pair. Keyed per account because UIDs from different
/// accounts are independent numbering spaces — the same reasoning that
/// makes `NewMailMarks` key per (account, folder) rather than per account.
type MessageKey = (String, String);

/// Remembers what this process has already accounted for.
///
/// Consumed and returned by `accept` rather than mutated in place, so the
/// decision is a function of a state and a page and can be tested as one.
#[derive(Debug, Clone, Default)]
pub struct MailWatch {
    /// Every message already accounted for, with the date it was
    /// accounted for at, so stale entries can be pruned.
    accounted: HashMap<MessageKey, i64>,
    /// False until the first poll that actually returned. That poll
    /// establishes the baseline and notifies for nothing.
    baselined: bool,
}

impl MailWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Folds one poll's page into the watch and returns what to notify
    /// for, newest first.
    ///
    /// `page` is expected in the order `GET /api/inbox` returns it —
    /// newest first — which is the order the cap keeps: if more messages
    /// arrived in one interval than may be announced, the ones announced
    /// are the most recent.
    pub fn accept(&self, page: &[Message], now_ms: i64) -> (Self, Vec<Message>) {
        let mut accounted = self.accounted.clone();
        let was_baselined = self.baselined;
        let mut fresh: Vec<Message> = Vec::new();

        for message in page {
            if message.folder != INBOX_FOLDER {
                continue;
            }
            let Some(date_ms) = message.date_ms else {
                continue;
            };
            if !is_recent(date_ms, now_ms) {
                continue;
            }

            let key = (message.account_id.clone(), message.uid.clone());
            let already_accounted = accounted.insert(key, date_ms).is_some();
            if already_accounted || !was_baselined {
                continue;
            }
            // Recorded either way. A message that arrives already read
            // must not buzz if the user later marks it unread — the
            // notification is for arrival, not for flag changes.
            if message.is_unread() {
                fresh.push(message.clone());
            }
        }

        fresh.truncate(MAX_PER_POLL);
        accounted.retain(|_, date_ms| is_recent(*date_ms, now_ms));

        let next = Self {
            accounted,
            baselined: true,
        };
        (next, fresh)
    }
}

/// dispatch.ts's `isRecentEnough`, in Rust.
fn is_recent(date_ms: i64, now_ms: i64) -> bool {
    now_ms - date_ms <= SANITY_WINDOW_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn message(uid: &str, date_ms: i64, flags: &[&str]) -> Message {
        Message {
            account_id: "primary".into(),
            uid: uid.into(),
            folder: INBOX_FOLDER.into(),
            subject: Some("Subject".into()),
            from_name: Some("Sender".into()),
            from_email: Some("sender@example.com".into()),
            date_ms: Some(date_ms),
            flags: flags.iter().map(|f| (*f).to_string()).collect(),
        }
    }

    fn unread(uid: &str) -> Message {
        message(uid, NOW - 1_000, &[])
    }

    #[test]
    fn the_first_poll_baselines_and_announces_nothing() {
        let watch = MailWatch::new();
        let page = vec![unread("10"), unread("9"), unread("8")];

        let (_next, fresh) = watch.accept(&page, NOW);

        assert!(
            fresh.is_empty(),
            "launching against an existing inbox must not fire for mail already in it"
        );
    }

    #[test]
    fn a_message_that_arrives_after_the_baseline_is_announced_once() {
        let (watch, _) = MailWatch::new().accept(&[unread("10")], NOW);

        let (watch, first) = watch.accept(&[unread("11"), unread("10")], NOW);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].uid, "11");

        // The same page again — a re-poll of an unchanged mailbox.
        let (_watch, second) = watch.accept(&[unread("11"), unread("10")], NOW);
        assert!(second.is_empty(), "a re-poll must not re-announce the same message");
    }

    #[test]
    fn mail_the_user_has_already_read_is_not_announced() {
        let (watch, _) = MailWatch::new().accept(&[unread("10")], NOW);

        let seen = message("11", NOW - 1_000, &[r"\Seen"]);
        let (watch, fresh) = watch.accept(&[seen, unread("10")], NOW);
        assert!(fresh.is_empty(), "a message already marked \\Seen has been seen");

        // And marking it unread afterwards is a flag change, not an arrival.
        let (_watch, later) = watch.accept(&[unread("11"), unread("10")], NOW);
        assert!(later.is_empty());
    }

    #[test]
    fn old_mail_is_not_announced_however_novel_it_looks() {
        let (watch, _) = MailWatch::new().accept(&[unread("10")], NOW);

        let stale = message("11", NOW - SANITY_WINDOW_MS - 1, &[]);
        let (_watch, fresh) = watch.accept(&[stale], NOW);
        assert!(fresh.is_empty());
    }

    #[test]
    fn a_message_with_no_date_is_never_announced() {
        let (watch, _) = MailWatch::new().accept(&[unread("10")], NOW);

        let mut undated = unread("11");
        undated.date_ms = None;
        let (_watch, fresh) = watch.accept(&[undated], NOW);
        assert!(fresh.is_empty(), "no date is no basis for \"this just arrived\"");
    }

    #[test]
    fn only_inbox_rows_are_announced_which_is_what_excludes_sent_mail() {
        let (watch, _) = MailWatch::new().accept(&[unread("10")], NOW);

        let mut sent = unread("11");
        sent.folder = "[Gmail]/Sent Mail".into();
        let (_watch, fresh) = watch.accept(&[sent], NOW);
        assert!(fresh.is_empty());
    }

    #[test]
    fn uids_from_different_accounts_do_not_shadow_each_other() {
        let (watch, _) = MailWatch::new().accept(&[unread("500")], NOW);

        let mut other = unread("7");
        other.account_id = "secondary".into();
        let (_watch, fresh) = watch.accept(&[other], NOW);

        assert_eq!(
            fresh.len(),
            1,
            "a low UID in another account is not old mail — the numbering spaces are independent"
        );
        assert_eq!(fresh[0].account_id, "secondary");
    }

    #[test]
    fn a_renumbered_mailbox_still_announces_rather_than_going_silent() {
        let (watch, _) = MailWatch::new().accept(&[unread("40000")], NOW);

        // UIDVALIDITY changed and the server restarted numbering low. A
        // high-water mark would suppress this forever; a set does not.
        let (_watch, fresh) = watch.accept(&[unread("3")], NOW);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].uid, "3");
    }

    #[test]
    fn a_burst_is_capped_and_the_survivors_are_the_newest() {
        let (watch, _) = MailWatch::new().accept(&[unread("1")], NOW);

        let burst: Vec<Message> = (0..12).rev().map(|n| unread(&format!("{}", 10 + n))).collect();
        let (watch, fresh) = watch.accept(&burst, NOW);

        assert_eq!(fresh.len(), MAX_PER_POLL);
        assert_eq!(fresh[0].uid, "21", "the page is newest-first and so is the cap");

        // Everything in the burst was accounted for, capped or not, so the
        // next poll does not announce the overflow late.
        let (_watch, again) = watch.accept(&burst, NOW);
        assert!(again.is_empty());
    }

    #[test]
    fn entries_past_the_window_are_pruned_but_cannot_re_announce() {
        let (watch, _) = MailWatch::new().accept(&[unread("10")], NOW);
        let arrival = NOW;
        let (watch, fresh) = watch.accept(&[message("11", arrival, &[])], NOW);
        assert_eq!(fresh.len(), 1);

        let much_later = NOW + SANITY_WINDOW_MS + 1;
        let (watch, fresh) = watch.accept(&[message("11", arrival, &[])], much_later);
        assert!(fresh.is_empty(), "an entry pruned for age is also too old to notify");
        assert!(watch.accounted.is_empty(), "the set does not grow with mailbox size");
    }

    #[test]
    fn the_title_is_the_sender_and_the_body_is_the_subject() {
        let message = unread("1");
        assert_eq!(message.sender(), "Sender");
        assert_eq!(message.summary(), "Subject");
    }

    #[test]
    fn a_missing_name_falls_back_to_the_address_then_to_a_placeholder() {
        let mut message = unread("1");
        message.from_name = None;
        assert_eq!(message.sender(), "sender@example.com");

        message.from_email = Some("   ".into());
        assert_eq!(message.sender(), "New mail");

        message.subject = Some(String::new());
        assert_eq!(message.summary(), "(no subject)");
    }
}
