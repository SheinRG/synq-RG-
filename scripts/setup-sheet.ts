// Prepares the Google Sheet: creates the Leads, Events and Summary tabs,
// writes the headers and Summary formulas, and colors the Status column.
// Safe to run more than once; it never overwrites data rows.
//
//   npm run setup-sheet

import "dotenv/config";
import { google, type sheets_v4 } from "googleapis";
import { requireEnv } from "../src/config.js";
import {
  EVENTS_TAB,
  EVENT_HEADERS,
  LEADS_TAB,
  LEAD_COLUMNS,
  SUMMARY_TAB,
  columnLetter,
  loadServiceAccount,
} from "../src/crm/googleSheets.js";
import { LEAD_STATUSES, REPLY_CATEGORIES, type Lead } from "../src/types.js";

const spreadsheetId = requireEnv("SHEET_ID");
const auth = new google.auth.GoogleAuth({
  credentials: loadServiceAccount(requireEnv("GOOGLE_SERVICE_ACCOUNT_JSON")),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const STATUS_COLORS: Record<string, [number, number, number]> = {
  "Not contacted": [0.93, 0.93, 0.93],
  "Message sent": [0.85, 0.91, 0.99],
  Delivered: [0.74, 0.84, 0.97],
  Opened: [1.0, 0.95, 0.75],
  Replied: [0.8, 0.93, 0.8],
  "Follow-up due": [1.0, 0.85, 0.7],
  "Not replied": [0.96, 0.8, 0.8],
};

const col = (key: keyof Lead) => columnLetter(LEAD_COLUMNS.findIndex((c) => c.key === key));

async function main() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "properties.title,sheets(properties,conditionalFormats)" });
  const existing = new Map((meta.data.sheets ?? []).map((s) => [s.properties?.title ?? "", s]));

  const missing = [LEADS_TAB, EVENTS_TAB, SUMMARY_TAB].filter((t) => !existing.has(t));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
    });
    console.log(`Created tabs: ${missing.join(", ")}`);
  }

  const refreshed = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets(properties,conditionalFormats)" });
  const byTitle = new Map((refreshed.data.sheets ?? []).map((s) => [s.properties?.title ?? "", s]));
  const sheetId = (title: string) => byTitle.get(title)!.properties!.sheetId!;

  await writeHeaderIfEmpty(LEADS_TAB, LEAD_COLUMNS.map((c) => c.header));
  await writeHeaderIfEmpty(EVENTS_TAB, EVENT_HEADERS);
  await writeSummary();

  const requests: sheets_v4.Schema$Request[] = [];
  for (const title of [LEADS_TAB, EVENTS_TAB]) {
    requests.push(
      {
        updateSheetProperties: {
          properties: { sheetId: sheetId(title), gridProperties: { frozenRowCount: 1 } },
          fields: "gridProperties.frozenRowCount",
        },
      },
      {
        repeatCell: {
          range: { sheetId: sheetId(title), startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: "userEnteredFormat.textFormat.bold",
        },
      },
    );
  }
  // Summary rows 12 and 13 hold the open and reply rates.
  requests.push({
    repeatCell: {
      range: { sheetId: sheetId(SUMMARY_TAB), startRowIndex: 11, endRowIndex: 13, startColumnIndex: 1, endColumnIndex: 2 },
      cell: { userEnteredFormat: { numberFormat: { type: "PERCENT", pattern: "0%" } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });
  if (!byTitle.get(LEADS_TAB)?.conditionalFormats?.length) {
    const statusIndex = LEAD_COLUMNS.findIndex((c) => c.key === "status");
    Object.entries(STATUS_COLORS).forEach(([status, [red, green, blue]], index) => {
      requests.push({
        addConditionalFormatRule: {
          index,
          rule: {
            ranges: [{ sheetId: sheetId(LEADS_TAB), startRowIndex: 1, startColumnIndex: statusIndex, endColumnIndex: statusIndex + 1 }],
            booleanRule: {
              condition: { type: "TEXT_EQ", values: [{ userEnteredValue: status }] },
              format: { backgroundColor: { red, green, blue } },
            },
          },
        },
      });
    });
  }
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  console.log(`Sheet "${meta.data.properties?.title}" is ready: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
  console.log("Add leads in the Leads tab (Name, Company, LinkedIn URL). Leave Lead ID empty; the server fills it.");
}

async function writeHeaderIfEmpty(tab: string, headers: string[]) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!1:1` });
  if (res.data.values?.[0]?.length) {
    console.log(`${tab}: header already present, left as is`);
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [headers] },
  });
  console.log(`${tab}: header written`);
}

/** Formulas only, so the Summary tab stays correct without any code running. */
async function writeSummary() {
  const status = `${LEADS_TAB}!${col("status")}2:${col("status")}`;
  const category = `${LEADS_TAB}!${col("replyCategory")}2:${col("replyCategory")}`;
  const ids = `${LEADS_TAB}!${col("leadId")}2:${col("leadId")}`;
  const count = (range: string, value: string) => `=COUNTIF(${range},"${value}")`;

  // Layout: statuses in rows 2 to 8, Total in row 10, Contacted in row 11.
  // The formulas below refer to those cells, so keep the order if you edit this.
  const rows: (string | number)[][] = [
    ["Status", "Leads"],
    ...LEAD_STATUSES.map((s) => [s, count(status, s)]),
    [],
    ["Total leads", `=COUNTA(${ids})`],
    ["Contacted", `=B10-B2`],
    ["Open rate (Opened or Replied / Contacted)", `=IFERROR((B5+B6)/B11,0)`],
    ["Reply rate (Replied / Contacted)", `=IFERROR(B6/B11,0)`],
    [],
    ["Reply category", "Leads"],
    ...[...REPLY_CATEGORIES, "Unclassified"].map((c) => [c, count(category, c)]),
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SUMMARY_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });
  console.log(`${SUMMARY_TAB}: formulas written`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
