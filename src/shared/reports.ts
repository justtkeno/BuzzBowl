/** Players flag a finished question that has a problem; site admins review the reports. */

export const REPORT_REASONS = {
  answer: 'Answer is wrong or missing an accepted answer',
  typo: 'Typo',
  category: 'Wrong category',
  offensive: 'Offensive',
  other: 'Other',
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;
/** Shorter labels for the report form's chips on a phone. */
export const REPORT_REASON_CHIPS: Record<ReportReason, string> = {
  answer: 'Wrong or missing answer', typo: 'Typo', category: 'Wrong category', offensive: 'Offensive', other: 'Other',
};
export type ReportStatus = 'open' | 'resolved' | 'dismissed';
export const REPORT_NOTE_MAX = 200;

/** One report as admins see it. */
export interface ReportView {
  id: string;
  createdAt: number;
  reason: ReportReason;
  note: string;
  /** Display name for guests, username for signed-in players. */
  reporter: string;
  reporterUsername: string | null;
  roomCode: string;
}

/** Open reports of one question, newest report first. */
export interface ReportGroup {
  source: string;
  questionId: string;
  category: string;
  subcategory: string;
  setName: string | null;
  question: string;
  /** Sanitized answer line HTML (only the formatting tags the room shows). */
  answerHtml: string;
  latest: number;
  reports: ReportView[];
}
