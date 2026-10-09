import test from "node:test";
import assert from "node:assert/strict";
import { mergeListChoices, normalizeLists } from "../src/app/read-types.ts";

test("list snapshots normalize to compact authoritative choices and exact lookups merge by ID", () => {
  const snapshot = normalizeLists([
    { id: "List/WORK", title: "Old name", notes: "large payload", attachmentIds: ["Attachment/1"] },
    { id: "List/PERSONAL", title: "Personal" },
    { id: "List/WORK", title: "Current name", notes: "discarded duplicate payload" },
  ]);
  assert.deepEqual(snapshot, [
    { id: "List/WORK", title: "Current name", deleted: false, isGroup: false },
    { id: "List/PERSONAL", title: "Personal", deleted: false, isGroup: false },
  ]);
  assert.deepEqual(mergeListChoices(snapshot, [{ id: "List/SHARED", title: "Shared" }, { id: "List/WORK", title: "Renamed" }]), [
    { id: "List/WORK", title: "Renamed", deleted: false, isGroup: false },
    snapshot[1],
    { id: "List/SHARED", title: "Shared", deleted: false, isGroup: false },
  ]);
});
