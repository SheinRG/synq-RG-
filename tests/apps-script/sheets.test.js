import { beforeEach, describe, expect, it } from "vitest";
import { addHumanRows, code, createFakeSpreadsheet, installGlobals, setUpFakeSpreadsheet } from "./fakes.js";

const { createSheetCrm, setUpSpreadsheet, LEAD_COLUMNS, EVENT_HEADERS, LEAD_STATUSES } = code;

const leadsTab = (ss) => ss.getSheetByName("Leads");
const eventsTab = (ss) => ss.getSheetByName("Events");

describe("Set up sheet", () => {
  let ss;
  let globals;
  beforeEach(() => {
    ss = createFakeSpreadsheet();
    globals = installGlobals({ spreadsheet: ss });
  });

  it("creates the three tabs with headers, frozen bold header rows and status colors", () => {
    setUpSpreadsheet(ss);
    expect(ss.sheets.map((s) => s.getName())).toEqual(["Leads", "Events", "Summary"]);
    expect(leadsTab(ss).dump()[0]).toEqual(LEAD_COLUMNS.map((c) => c.header));
    expect(eventsTab(ss).dump()[0]).toEqual(EVENT_HEADERS);
    expect(leadsTab(ss).frozenRows).toBe(1);
    expect(leadsTab(ss).formats["1,1"].bold).toBe(true);
    const rules = leadsTab(ss).getConditionalFormatRules();
    expect(rules.map((r) => r.text)).toEqual(LEAD_STATUSES);
    expect(rules[0].ranges[0].getColumn()).toBe(6); // Status
  });

  it("writes Summary formulas only, against the Leads columns", () => {
    setUpSpreadsheet(ss);
    const summary = ss.getSheetByName("Summary");
    const labels = summary.dump().map((r) => r[0]);
    const formulas = summary.getRange(1, 2, summary.getLastRow(), 1).getFormulas().map((r) => r[0]);
    const formulaFor = (label) => formulas[labels.indexOf(label)];

    expect(formulaFor("Opened")).toBe(`=COUNTIF('Leads'!F2:F,"Opened")`);
    expect(formulaFor("Total leads")).toBe("=COUNTA('Leads'!A2:A)");
    expect(formulaFor("Contacted")).toBe("=B9-B2");
    expect(formulaFor("Open rate ((Opened + Replied) / Contacted)")).toBe("=IFERROR((B4+B5)/B10,0)");
    expect(formulaFor("Reply rate (Replied / Contacted)")).toBe("=IFERROR(B5/B10,0)");
    expect(formulaFor("Unclassified")).toBe(`=COUNTIF('Leads'!G2:G,"Unclassified")`);
    expect(labels).toContain("Interested");
    expect(labels).not.toContain("Delivered");
    expect(summary.formats["11,2"].numberFormat).toBe("0%");
    expect(summary.formats["12,2"].numberFormat).toBe("0%");
  });

  it("is safe to run twice and keeps data, custom header order and colors", () => {
    setUpSpreadsheet(ss);
    addHumanRows(ss, [{ name: "Priya Sharma", company: "Acme" }]);
    setUpSpreadsheet(ss);
    expect(ss.sheets).toHaveLength(3);
    expect(leadsTab(ss).getLastRow()).toBe(2);
    expect(leadsTab(ss).rowObject(2).Name).toBe("Priya Sharma");
    expect(leadsTab(ss).getConditionalFormatRules()).toHaveLength(LEAD_STATUSES.length);
  });

  it("adds missing columns at the end instead of rewriting an existing header", () => {
    const sheet = ss.insertSheet("Leads");
    sheet.getRange(1, 1, 1, 3).setValues([["Name", "Lead ID", "Company"]]);
    setUpSpreadsheet(ss);
    const header = sheet.dump()[0];
    expect(header.slice(0, 3)).toEqual(["Name", "Lead ID", "Company"]);
    expect(header).toHaveLength(LEAD_COLUMNS.length);
    expect(header).toContain("Thread ID");
  });

  it("installs exactly one follow-up trigger, leaving other triggers alone", () => {
    globals.scriptApp.newTrigger("somethingElse").timeBased().everyDays(1).create();
    code.installTrigger(false);
    code.installTrigger(true);
    const ours = globals.scriptApp.triggers.filter((t) => t.handler === "runScheduledCheck");
    expect(ours).toEqual([expect.objectContaining({ everyMinutes: 1 })]);
    expect(globals.scriptApp.triggers.some((t) => t.handler === "somethingElse")).toBe(true);
    code.installTrigger(false);
    expect(globals.scriptApp.triggers.filter((t) => t.handler === "runScheduledCheck")).toEqual([
      expect.objectContaining({ everyDays: 1, atHour: 9 }),
    ]);
  });
});

describe("Google Sheets CRM adapter", () => {
  it("gives new human rows L-000N ids after the highest existing id, and Source Manual", () => {
    const ss = setUpFakeSpreadsheet([{ name: "Priya" }]);
    leadsTab(ss).getRange(2, 1).setValue("L-0007");
    addHumanRows(ss, [{ name: "Arjun", company: "Beta" }]);
    // Row 4 left blank; row 5 has only a LinkedIn URL.
    leadsTab(ss).getRange(5, 4).setValue("https://www.linkedin.com/in/sam/");

    const leads = createSheetCrm(ss).listLeads();
    expect(leads.map((l) => l.leadId)).toEqual(["L-0007", "L-0008", "L-0009"]);
    expect(leadsTab(ss).rowObject(3)).toMatchObject({ "Lead ID": "L-0008", Source: "Manual", Name: "Arjun" });
    expect(leadsTab(ss).rowObject(5)["Lead ID"]).toBe("L-0009");
    // Running again does not hand out new ids.
    expect(createSheetCrm(ss).listLeads().map((l) => l.leadId)).toEqual(["L-0007", "L-0008", "L-0009"]);
  });

  it("finds columns by header text after they are reordered", () => {
    const ss = createFakeSpreadsheet();
    installGlobals({ spreadsheet: ss });
    const sheet = ss.insertSheet("Leads");
    ss.insertSheet("Events");
    const header = LEAD_COLUMNS.map((c) => c.header).reverse();
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    const row = header.map((h) => ({ "Lead ID": "L-0001", Name: "Priya", Status: "Opened", "Follow-up Count": 1 })[h] ?? "");
    sheet.appendRow(row);

    const crm = createSheetCrm(ss);
    expect(crm.listLeads()[0]).toMatchObject({ leadId: "L-0001", name: "Priya", status: "Opened", followUpCount: 1 });
    crm.updateStatus("L-0001", "Replied", { lastInboundAt: "2026-10-26T10:00:00.000Z" });
    expect(sheet.rowObject(2)).toMatchObject({ Status: "Replied", "Last Inbound At": "2026-10-26T10:00:00.000Z", Name: "Priya" });
  });

  it("updates the right row by Lead ID after people sort the sheet", () => {
    const ss = setUpFakeSpreadsheet([{ name: "Ann" }, { name: "Bob" }, { name: "Cat" }]);
    const crm = createSheetCrm(ss);
    crm.listLeads(); // L-0001 Ann, L-0002 Bob, L-0003 Cat
    // Someone sorts by name descending.
    const sheet = leadsTab(ss);
    const rows = sheet.getRange(2, 1, 3, sheet.getLastColumn()).getValues().reverse();
    sheet.getRange(2, 1, 3, sheet.getLastColumn()).setValues(rows);

    crm.upsertLead({ leadId: "L-0002", status: "Message sent" });
    crm.upsertLead({ leadId: "L-0001", status: "Replied" });
    expect(sheet.rowObject(2)).toMatchObject({ Name: "Cat", Status: "" });
    expect(sheet.rowObject(3)).toMatchObject({ Name: "Bob", Status: "Message sent" });
    expect(sheet.rowObject(4)).toMatchObject({ Name: "Ann", Status: "Replied" });
  });

  it("never overwrites Name, Company or LinkedIn URL, and only fills them while blank", () => {
    const ss = setUpFakeSpreadsheet([
      { name: "Priya", company: "Acme", linkedinUrl: "https://www.linkedin.com/in/priya/" },
      { name: "Arjun" },
    ]);
    const crm = createSheetCrm(ss);
    crm.listLeads();
    crm.upsertLead({ leadId: "L-0001", name: "P. Sharma", company: "Other", linkedinUrl: "https://www.linkedin.com/in/x/", status: "Opened" });
    crm.upsertLead({ leadId: "L-0002", name: "Arjun M.", linkedinUrl: "https://www.linkedin.com/in/arjun/" });
    expect(leadsTab(ss).rowObject(3).Name).toBe("Arjun");
    expect(leadsTab(ss).rowObject(2)).toMatchObject({
      Name: "Priya",
      Company: "Acme",
      "LinkedIn URL": "https://www.linkedin.com/in/priya/",
      Status: "Opened",
    });
    expect(leadsTab(ss).rowObject(3)["LinkedIn URL"]).toBe("https://www.linkedin.com/in/arjun/");
  });

  it("appends a new row for an unknown Lead ID (auto-added lead)", () => {
    const ss = setUpFakeSpreadsheet([{ name: "Priya" }]);
    const crm = createSheetCrm(ss);
    crm.listLeads();
    crm.upsertLead({ leadId: "L-0002", name: "New Person", threadId: "2-A", status: "Not contacted", source: "Auto-added", followUpCount: 0 });
    expect(leadsTab(ss).rowObject(3)).toMatchObject({ "Lead ID": "L-0002", Name: "New Person", Source: "Auto-added", "Follow-up Count": 0 });
  });

  it("stores text starting with = as text, never as a formula", () => {
    const ss = setUpFakeSpreadsheet([{ name: "Priya" }]);
    const crm = createSheetCrm(ss);
    crm.listLeads();
    const evil = '=IMPORTXML("https://evil.example","//a")';
    crm.upsertLead({ leadId: "L-0001", lastMessageSnippet: evil, replySummary: "+1 sounds good" });
    crm.logEvent({ timestamp: "t", leadId: "L-0001", eventType: "=x", direction: "", messageId: "", oldStatus: "", newStatus: "" });

    const sheet = leadsTab(ss);
    const col = sheet.dump()[0].indexOf("Last Message Snippet") + 1;
    expect(sheet.getRange(2, col).getValue()).toBe(evil);
    expect(sheet.getRange(2, col).getFormulas()[0][0]).toBe("");
    expect(sheet.rowObject(2)["Reply Summary"]).toBe("+1 sounds good");
    expect(eventsTab(ss).getRange(2, 3).getFormulas()[0][0]).toBe("");
    expect(crm.listLeads()[0].lastMessageSnippet).toBe(evil);
  });

  it("writes one setValues per run of adjacent changed columns", () => {
    const ss = setUpFakeSpreadsheet([{ name: "Priya" }]);
    const crm = createSheetCrm(ss);
    crm.listLeads();
    const sheet = leadsTab(ss);
    sheet.writes = 0;
    // Status..Reply Summary are adjacent; Updated At is on its own.
    crm.upsertLead({ leadId: "L-0001", status: "Replied", replyCategory: "Interested", replySummary: "Call", updatedAt: "now" });
    expect(sheet.writes).toBe(2);
  });

  it("appends events in order", () => {
    const ss = setUpFakeSpreadsheet();
    const crm = createSheetCrm(ss);
    const event = (n) => ({ timestamp: "2026-10-26T10:00:0" + n + ".000Z", leadId: "L-0001", eventType: "read", direction: "outbound", messageId: "abc", oldStatus: "Message sent", newStatus: "Opened" });
    crm.logEvent(event(1));
    crm.logEvent(event(2));
    expect(eventsTab(ss).dump().slice(1)).toEqual([
      ["2026-10-26T10:00:01.000Z", "L-0001", "read", "outbound", "abc", "Message sent", "Opened"],
      ["2026-10-26T10:00:02.000Z", "L-0001", "read", "outbound", "abc", "Message sent", "Opened"],
    ]);
  });

  it("reads dates and unknown statuses safely", () => {
    const ss = setUpFakeSpreadsheet([{ name: "Priya" }]);
    const sheet = leadsTab(ss);
    const header = sheet.dump()[0];
    sheet.getRange(2, header.indexOf("Status") + 1).setValue("opened");
    sheet.getRange(2, header.indexOf("Last Outbound At") + 1).setValues([[new Date("2026-10-26T10:00:00Z")]]);
    const lead = createSheetCrm(ss).listLeads()[0];
    expect(lead.status).toBe("Opened");
    expect(lead.lastOutboundAt).toBe("2026-10-26T10:00:00.000Z");
  });

  it("explains what to do when the sheet is not set up", () => {
    const ss = createFakeSpreadsheet();
    expect(() => createSheetCrm(ss).listLeads()).toThrow(/Set up sheet/);
    ss.insertSheet("Leads").getRange(1, 1).setValue("Name");
    expect(() => createSheetCrm(ss).listLeads()).toThrow(/Lead ID/);
  });
});
