export interface ReadRecord { id: string; title?: string | null; notes?: string | null; deleted?: boolean | null; isGroup?: boolean | null; completed?: boolean | null; listId?: string; completedDate?: string | null; dueDate?: string | null; startDate?: string | null; priority?: number | null; flagged?: boolean | null; allDay?: boolean | null; timeZone?: string | null; parentReminderId?: string | null; alarmIds?: string[] | null; attachmentIds?: string[] | null; hashtagIds?: string[] | null; recurrenceRuleIds?: string[] | null; created?: string | null; modified?: string | null; recordChangeTag?: string | null; appleRecord?: Record<string, unknown>; }
export interface RelatedRecord { id: string; recordType: string; deleted: boolean; appleRecord: Record<string, unknown>; }
export interface ReadPage {
  listDiscovery?: { strategy: "direct"; experimental: boolean; retrievedAt: number | null };
  records: ReadRecord[];
  recordErrors: { id: string | null; code: string; reason?: string | null; appleRecord?: Record<string, unknown> }[];
  complete: boolean;
  paginationComplete: boolean;
  continuation: string | null;
  pendingReason: string | null;
  auxiliaryRecordCounts: Record<string, number>;
  auxiliaryDetailsIncluded: boolean;
  relatedRecords?: RelatedRecord[];
  requestTrace?: unknown[];
  scope?: string;
  listId?: string;
  unrefreshedLists?: number;
}

export const selectableList = (item: ReadRecord) => item.id.startsWith("List/") && !item.deleted && !item.isGroup;

// Keep dropdown choices small; Apple payload details are only retained for the
// reminder preview or explicit diagnostics.
export const listChoice = (item: ReadRecord): ReadRecord => ({
  id: item.id,
  title: item.title?.slice(0, 256) ?? null,
  deleted: !!item.deleted,
  isGroup: !!item.isGroup,
});

// A list snapshot is authoritative. Callers use this for saved/current lists;
// exact ID lookups use mergeListChoices so explicitly found IDs can be added.
export function normalizeLists(records: ReadRecord[]): ReadRecord[] {
  const lists = new Map<string, ReadRecord>();
  for (const record of records) lists.set(record.id, listChoice(record));
  return [...lists.values()];
}

export function mergeListChoices(previous: ReadRecord[], records: ReadRecord[]): ReadRecord[] {
  const lists = new Map(previous.map(item => [item.id, item]));
  for (const record of records) lists.set(record.id, listChoice(record));
  return [...lists.values()];
}
