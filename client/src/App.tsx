import './shell.css';

/**
 * The app shell: an inbox region and a rail region, per client/DESIGN.md
 * §4.1's grid ("toolbar rail" / "inbox rail"). Renders no real content —
 * Task 4 fills the inbox with InboxList, Task 5 fills the rail with
 * OpensRail.
 *
 * The toolbar is an empty landmark for the same reason: DESIGN.md §6
 * component #2 specs an account filter, theme toggle, and rail toggle for
 * it, none of which this task builds.
 */
export default function App() {
  return (
    <div className="shell">
      <header className="toolbar" aria-label="Toolbar">
        {/* Task 4+: AccountFilter, ThemeToggle, rail toggle
            (client/DESIGN.md §6, component #2 Toolbar). */}
      </header>

      <main className="inbox" aria-label="Inbox">
        <div className="inbox__inner">{/* Task 4: InboxList */}</div>
      </main>

      <aside className="rail" aria-label="Opens tracking">
        {/*
          Task 5: OpensRail.

          Ruling from task-3-brief.md: `self`-classified events are
          suppressed from the rail's list but counted, shown as one muted
          line ("N views from you") rather than dropped silently. DESIGN.md
          itself does not specify this affordance's exact placement or copy
          (its §9 flags the underlying question and offers this as the
          alternative to hiding self-views outright, without picking exact
          wording), so per the task's own instruction this slot is left for
          Task 5 rather than guessed here.
        */}
      </aside>
    </div>
  );
}
