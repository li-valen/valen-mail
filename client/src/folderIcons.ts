import { Inbox, Send, ShieldAlert, Star, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FolderId } from './inboxFilters';

/**
 * One glyph per folder, in the project's single icon family
 * (lucide-react, per client/CLAUDE.md — never two families).
 *
 * Split out of ./inboxFilters.ts rather than declared beside the labels
 * so that module stays free of runtime imports: ./api.ts depends on its
 * `buildInboxParams`, and there is no reason for the API wrapper's module
 * graph — or the tests that exercise it — to pull in an icon library.
 *
 * Declared once, in one map, so a folder's sidebar item and its empty
 * state can never drift onto two different glyphs.
 */
export const FOLDER_ICONS: Readonly<Record<FolderId, LucideIcon>> = {
  inbox: Inbox,
  starred: Star,
  sent: Send,
  spam: ShieldAlert,
  trash: Trash2,
};
