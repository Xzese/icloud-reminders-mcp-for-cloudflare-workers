"use client";
import { useState } from "react";
import type { ReadRecord, RelatedRecord } from "./read-types.ts";

// Apple fields are rendered as escaped text. Asset URLs are never followed,
// and encoded documents/attachments are never executed or downloaded here.
export function AppleRecordDetails({ record, label = "All Apple record data" }: { record: Record<string, unknown>; label?: string }) {
  const [open, setOpen] = useState(false);
  return <details className="apple-record-details" onToggle={event => setOpen(event.currentTarget.open)}><summary>{label}</summary>{open && <pre>{JSON.stringify(record, null, 2)}</pre>}</details>;
}
const fields: [keyof ReadRecord, string][] = [
  ["id", "Reminder ID"], ["listId", "List ID"], ["completed", "Completed"], ["completedDate", "Completed at"],
  ["dueDate", "Due"], ["startDate", "Starts"], ["priority", "Priority"], ["flagged", "Flagged"], ["allDay", "All day"],
  ["deleted", "Deleted"], ["timeZone", "Time zone"], ["parentReminderId", "Parent reminder"], ["alarmIds", "Alarms"],
  ["attachmentIds", "Attachments"], ["hashtagIds", "Tags"], ["recurrenceRuleIds", "Recurrence rules"],
  ["created", "Created"], ["modified", "Modified"], ["recordChangeTag", "Change tag"],
];
function valueText(value: unknown) {
  if (value === undefined || value === null) return "Not supplied";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  return String(value);
}
export function ReminderDetails({ reminder }: { reminder: ReadRecord }) {
  return <>
    <strong>{reminder.title ?? reminder.id}</strong>{reminder.deleted && <span> · deleted</span>}{reminder.completed && <span> · completed</span>}
    {reminder.notes && <p>{reminder.notes}</p>}
    {reminder.dueDate && <p>Due: {reminder.dueDate}{reminder.timeZone ? ` (${reminder.timeZone})` : ""}</p>}
    <details className="reminder-details"><summary>Reminder details</summary><dl className="reminder-metadata">{fields.filter(([key]) => Object.hasOwn(reminder, key)).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{valueText(reminder[key])}</dd></div>)}</dl></details>
    {reminder.appleRecord && <AppleRecordDetails record={reminder.appleRecord} />}
  </>;
}
export function RelatedRecords({ records }: { records: RelatedRecord[] }) {
  const [open, setOpen] = useState(false);
  return <details className="related-records" onToggle={event => setOpen(event.currentTarget.open)}><summary>Related Apple records ({records.length})</summary>{open && <ul>{records.map((record, index) => <li key={`${record.id}-${index}`}><strong>{record.recordType}</strong>{record.deleted && <span> · deleted</span>}<p>{record.id}</p><AppleRecordDetails record={record.appleRecord} /></li>)}</ul>}</details>;
}
