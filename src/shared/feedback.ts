// Player feedback sent from the app ("Send feedback"), read by site admins in the 🛡 panel.

export type FeedbackKind = 'idea' | 'bug' | 'other';
export const FEEDBACK_KINDS: { id: FeedbackKind; label: string }[] = [
  { id: 'idea', label: 'Idea' }, { id: 'bug', label: 'Something’s broken' }, { id: 'other', label: 'Other' },
];
export const FEEDBACK_MAX = 1000;

export interface FeedbackItem {
  id: string;
  createdAt: number;
  kind: FeedbackKind;
  message: string;
  /** Display name, and the account username when signed in. */
  from: string;
  username: string | null;
  /** Where it was sent from ("home", "room ABCD", "profile"). */
  where: string;
  /** Short device description, e.g. "iPhone · Safari · app". */
  device: string;
  done: boolean;
}
