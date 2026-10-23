// Tests the Google Sheets adapter against a small in-memory fake of the
// Sheets values API, so ranges and row numbers are checked without network.

import { beforeEach, describe, expect, it } from "vitest";
import type { sheets_v4 } from "googleapis";
import { EVENT_HEADERS, GoogleSheetsCrm, LEAD_COLUMNS, columnLetter } from "../src/crm/googleSheets.js";

const HEADERS = LEAD_COLUMNS.map((c) => c.header);

/** Just enough of spreadsheets.values for the adapter, on plain 2D arrays. */
class FakeSheets {
  tabs: Record<string, string[][]> = { Leads: [HEADERS], Events: [EVENT_HEADERS] };
  valueInputOptions: string[] = [];
  reads = 0;
  /** Called after every read; lets a test change the sheet between reads. */
  afterRead: (reads: number) => void = () => {};

  values = {
    get: async ({ range }: { range: string }) => {
      const result = { data: { values: this.read(range) } };
      this.afterRead(++this.reads);
      return result;
    },
    batchGet: async ({ ranges }: { ranges: string[] }) => {
      const result = { data: { valueRanges: ranges.map((r) => ({ values: this.read(r) })) } };
      this.afterRead(++this.reads);
      return result;
    },
    batchUpdate: async ({ requestBody }: { requestBody: { valueInputOption: string; data: { range: string; values: unknown[][] }[] } }) => {
      this.valueInputOptions.push(requestBody.valueInputOption);
      for (const d of requestBody.data) this.write(d.range, d.values);
      return { data: {} };
    },
    append: async ({ range, valueInputOption, requestBody }: { range: string; valueInputOption: string; requestBody: { values: unknown[][] } }) => {
      this.valueInputOptions.push(valueInputOption);
      const tab = this.tabs[range.split("!")[0]];
      for (const row of requestBody.values) tab.push(row.map(String));
      return { data: {} };
    },
  };

  get api(): sheets_v4.Sheets {
    return { spreadsheets: { values: this.values } } as unknown as sheets_v4.Sheets;
  }

  private read(range: string): string[][] {
    const [tabName, ref] = range.split("!");
    const { c1, r1, c2, r2 } = parseRange(ref);
    const rows = (this.tabs[tabName] ?? []).slice(r1, r2 + 1).map((row) => row.slice(c1, c2 + 1));
    while (rows.length && rows[rows.length - 1].every((v) => v === "")) rows.pop();
    return rows;
  }

  private write(range: string, values: unknown[][]): void {
    const [tabName, ref] = range.split("!");
    const { c1, r1 } = parseRange(ref);
    const tab = this.tabs[tabName];
    values.forEach((row, i) => {
      while (tab.length <= r1 + i) tab.push([]);
      row.forEach((v, j) => {
        const target = tab[r1 + i];
        while (target.length <= c1 + j) target.push("");
        target[c1 + j] = String(v);
      });
    });
  }
}

/** Parses A1 refs like A1:ZZ, 1:1, A:A and G5 into zero-based bounds. */
function parseRange(ref: string) {
  const part = (p: string) => {
    const m = /^([A-Z]*)(\d*)$/.exec(p)!;
    const col = m[1] ? m[1].split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : undefined;
    const row = m[2] ? Number(m[2]) - 1 : undefined;
    return { col, row };
  };
  const [a, b] = ref.split(":");
  const start = part(a);
  const end = b ? part(b) : start;
  return {
    c1: start.col ?? 0,
    r1: start.row ?? 0,
    c2: end.col ?? Number.MAX_SAFE_INTEGER,
    r2: end.row ?? Number.MAX_SAFE_INTEGER,
  };
}

function row(fields: Record<string, string>): string[] {
  return HEADERS.map((h) => fields[h] ?? "");
}

let fake: FakeSheets;
let crm: GoogleSheetsCrm;
let seq: number;

beforeEach(() => {
  fake = new FakeSheets();
  seq = 0;
  crm = new GoogleSheetsCrm("sheet", { next: () => `L-${String(++seq).padStart(4, "0")}`, bumpTo: (n) => (seq = Math.max(seq, n)) }, fake.api);
});

describe("columnLetter", () => {
  it("handles single and double letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(6)).toBe("G");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
  });
});

describe("listLeads", () => {
  it("assigns ids to new rows after the highest existing id and skips blank rows", async () => {
    fake.tabs.Leads.push(
      row({ "Lead ID": "L-0007", Name: "Existing", Status: "Opened" }),
      row({}),
      row({ Name: "Priya Sharma", Company: "Acme Corp", "LinkedIn URL": "https://www.linkedin.com/in/priya" }),
    );
    const leads = await crm.listLeads();
    expect(leads.map((l) => [l.leadId, l.name, l.status])).toEqual([
      ["L-0007", "Existing", "Opened"],
      ["L-0008", "Priya Sharma", ""],
    ]);
    expect(fake.tabs.Leads[3][0]).toBe("L-0008");
    expect(fake.tabs.Leads[3][HEADERS.indexOf("Source")]).toBe("Manual");
    expect(fake.valueInputOptions).toEqual(["RAW"]);
  });

  it("does not write an id into a row that moved between reads", async () => {
    fake.tabs.Leads.push(row({ Name: "Priya Sharma", "LinkedIn URL": "https://www.linkedin.com/in/priya" }));
    fake.afterRead = (reads) => {
      // Someone inserts a row above Priya right after our first read.
      if (reads === 1) fake.tabs.Leads.splice(1, 0, row({ "Lead ID": "L-0003", Name: "Someone Else" }));
    };
    const leads = await crm.listLeads();
    expect(leads).toEqual([]);
    expect(fake.tabs.Leads[1][0]).toBe("L-0003");
    expect(fake.tabs.Leads[2][0]).toBe("");
  });
});

describe("upsertLead / updateStatus", () => {
  it("finds the row by Lead ID even after the sheet was sorted", async () => {
    fake.tabs.Leads.push(row({ "Lead ID": "L-0002", Name: "B" }), row({ "Lead ID": "L-0001", Name: "A" }));
    await crm.updateStatus("L-0001", "Replied", { replyCategory: "Interested" });
    const status = HEADERS.indexOf("Status");
    expect(fake.tabs.Leads[2][status]).toBe("Replied");
    expect(fake.tabs.Leads[2][HEADERS.indexOf("Reply Category")]).toBe("Interested");
    expect(fake.tabs.Leads[1][status] ?? "").toBe("");
  });

  it("appends a full row in header order for an unknown lead", async () => {
    await crm.upsertLead({ leadId: "L-0009", name: "New Person", status: "Message sent", followUpCount: 0, source: "Auto-added" });
    expect(fake.tabs.Leads[1]).toEqual(
      row({ "Lead ID": "L-0009", Name: "New Person", Status: "Message sent", "Follow-up Count": "0", Source: "Auto-added" }),
    );
  });

  it("writes message text as a plain value, never a formula", async () => {
    fake.tabs.Leads.push(row({ "Lead ID": "L-0001" }));
    await crm.upsertLead({ leadId: "L-0001", lastMessageSnippet: '=HYPERLINK("http://evil")' });
    expect(fake.valueInputOptions).toEqual(["RAW"]);
    expect(fake.tabs.Leads[1][HEADERS.indexOf("Last Message Snippet")]).toBe('=HYPERLINK("http://evil")');
  });
});

describe("logEvent", () => {
  it("appends one row to the Events tab", async () => {
    await crm.logEvent({
      timestamp: "2026-10-24T10:00:00Z",
      leadId: "L-0001",
      eventType: "read",
      direction: "outbound",
      messageId: "m1",
      oldStatus: "Delivered",
      newStatus: "Opened",
    });
    expect(fake.tabs.Events[1]).toEqual(["2026-10-24T10:00:00Z", "L-0001", "read", "outbound", "m1", "Delivered", "Opened"]);
  });
});
