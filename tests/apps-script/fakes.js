// In-memory stand-ins for the Apps Script services Code.js uses.
// Only the calls the script makes are implemented, with the same 1-based
// row/column numbers as the real SpreadsheetApp.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const code = require("../../apps-script/Code.js");

// ---- SpreadsheetApp ---------------------------------------------------------

/**
 * Mimics how Sheets stores what setValues/appendRow get: a leading apostrophe
 * marks literal text (and is not part of the value), a leading "=" makes a
 * formula. Formulas are not evaluated; their value reads back as "".
 */
function storeCell(input) {
  if (typeof input === "string" && input.startsWith("'")) return { value: input.slice(1), formula: "" };
  if (typeof input === "string" && input.startsWith("=")) return { value: "", formula: input };
  return { value: input === undefined || input === null ? "" : input, formula: "" };
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.cells = []; // rows of { value, formula }
    this.frozenRows = 0;
    this.conditionalRules = [];
    this.formats = {}; // "row,col" -> { bold, numberFormat }
  }

  getName() {
    return this.name;
  }

  getMaxRows() {
    return Math.max(1000, this.cells.length);
  }

  getLastRow() {
    for (let r = this.cells.length - 1; r >= 0; r--) {
      if ((this.cells[r] || []).some((c) => c && (c.value !== "" || c.formula))) return r + 1;
    }
    return 0;
  }

  getLastColumn() {
    let max = 0;
    this.cells.forEach((row) => {
      (row || []).forEach((c, i) => {
        if (c && (c.value !== "" || c.formula)) max = Math.max(max, i + 1);
      });
    });
    return max;
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    if (typeof row !== "number" || row < 1 || column < 1 || numRows < 1 || numColumns < 1) {
      throw new Error(`Bad range ${row},${column},${numRows},${numColumns}`);
    }
    return new FakeRange(this, row, column, numRows, numColumns);
  }

  getDataRange() {
    return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }

  appendRow(values) {
    const row = this.getLastRow() + 1;
    this.getRange(row, 1, 1, values.length).setValues([values]);
    return this;
  }

  setFrozenRows(n) {
    this.frozenRows = n;
  }

  getConditionalFormatRules() {
    return this.conditionalRules.slice();
  }

  setConditionalFormatRules(rules) {
    this.conditionalRules = rules.slice();
  }

  clearContents() {
    this.cells = [];
    return this;
  }

  cell(row, column) {
    return (this.cells[row - 1] || [])[column - 1] || { value: "", formula: "" };
  }

  setCell(row, column, cell) {
    while (this.cells.length < row) this.cells.push([]);
    this.cells[row - 1][column - 1] = cell;
  }

  /** Test helper: plain values of the whole sheet. */
  dump() {
    return this.getDataRange().getValues();
  }

  /** Test helper: the row as a { header: value } object. */
  rowObject(row) {
    const header = this.getRange(1, 1, 1, this.getLastColumn()).getValues()[0];
    const values = this.getRange(row, 1, 1, header.length).getValues()[0];
    return Object.fromEntries(header.map((h, i) => [h, values[i]]));
  }
}

class FakeRange {
  constructor(sheet, row, column, numRows, numColumns) {
    Object.assign(this, { sheet, row, column, numRows, numColumns });
  }

  getSheet() {
    return this.sheet;
  }

  getRow() {
    return this.row;
  }

  getColumn() {
    return this.column;
  }

  getNumRows() {
    return this.numRows;
  }

  getNumColumns() {
    return this.numColumns;
  }

  map(fn) {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numColumns; c++) row.push(fn(this.sheet.cell(this.row + r, this.column + c)));
      out.push(row);
    }
    return out;
  }

  getValues() {
    return this.map((c) => c.value);
  }

  getFormulas() {
    return this.map((c) => c.formula);
  }

  getValue() {
    return this.getValues()[0][0];
  }

  setValues(values) {
    if (values.length !== this.numRows || values.some((r) => r.length !== this.numColumns)) {
      throw new Error(
        `The number of rows or columns in the data does not match the range (${values.length}x${values[0]?.length} vs ${this.numRows}x${this.numColumns})`,
      );
    }
    this.sheet.writes = (this.sheet.writes || 0) + 1;
    values.forEach((r, i) => r.forEach((v, j) => this.sheet.setCell(this.row + i, this.column + j, storeCell(v))));
    return this;
  }

  setValue(value) {
    return this.setValues([[value]]);
  }

  setFontWeight(weight) {
    return this.format({ bold: weight === "bold" });
  }

  setNumberFormat(numberFormat) {
    return this.format({ numberFormat });
  }

  format(props) {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numColumns; c++) {
        const key = `${this.row + r},${this.column + c}`;
        this.sheet.formats[key] = { ...this.sheet.formats[key], ...props };
      }
    }
    return this;
  }
}

class FakeSpreadsheet {
  constructor(name) {
    this.name = name;
    this.sheets = [];
    this.toasts = [];
  }

  getName() {
    return this.name;
  }

  getSheetByName(name) {
    return this.sheets.find((s) => s.getName() === name) || null;
  }

  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists.`);
    const sheet = new FakeSheet(name);
    this.sheets.push(sheet);
    return sheet;
  }

  toast(message) {
    this.toasts.push(message);
  }
}

export function createFakeSpreadsheet(name = "Lead Tracker CRM") {
  return new FakeSpreadsheet(name);
}

/** A spreadsheet already prepared by "Set up sheet", optionally with human rows (Name, Company, LinkedIn URL). */
export function setUpFakeSpreadsheet(humanRows = []) {
  const ss = createFakeSpreadsheet();
  installGlobals({ spreadsheet: ss });
  code.setUpSpreadsheet(ss);
  addHumanRows(ss, humanRows);
  return ss;
}

/** Types rows into the Leads tab the way a person would: only Name, Company, LinkedIn URL. */
export function addHumanRows(ss, rows) {
  const sheet = ss.getSheetByName(code.LEADS_TAB);
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  rows.forEach((r) => {
    const values = header.map((h) => (h === "Name" ? r.name || "" : h === "Company" ? r.company || "" : h === "LinkedIn URL" ? r.linkedinUrl || "" : ""));
    sheet.appendRow(values);
  });
}

function conditionalRuleBuilder() {
  const rule = {};
  const builder = {
    whenTextEqualTo(text) {
      rule.text = text;
      return builder;
    },
    setBackground(color) {
      rule.background = color;
      return builder;
    },
    setRanges(ranges) {
      rule.ranges = ranges;
      return builder;
    },
    build() {
      return { ...rule };
    },
  };
  return builder;
}

// ---- other services ---------------------------------------------------------

function fakeProperties(initial) {
  const store = { ...initial };
  return {
    store,
    getProperty: (k) => (k in store ? store[k] : null),
    getProperties: () => ({ ...store }),
    setProperty(k, v) {
      store[k] = String(v);
      return this;
    },
    deleteProperty(k) {
      delete store[k];
      return this;
    },
  };
}

function fakeScriptApp() {
  const triggers = [];
  const app = {
    triggers,
    getProjectTriggers: () => triggers.slice(),
    deleteTrigger(t) {
      triggers.splice(triggers.indexOf(t), 1);
    },
    newTrigger(handler) {
      const spec = { handler };
      const chain = {
        timeBased: () => chain,
        everyMinutes(n) {
          spec.everyMinutes = n;
          return chain;
        },
        everyDays(n) {
          spec.everyDays = n;
          return chain;
        },
        atHour(h) {
          spec.atHour = h;
          return chain;
        },
        create() {
          const trigger = { ...spec, getHandlerFunction: () => spec.handler };
          triggers.push(trigger);
          return trigger;
        },
      };
      return chain;
    },
  };
  return app;
}

/** Puts fake Apps Script services on globalThis, where Code.js looks them up at call time. */
export function installGlobals({ spreadsheet = createFakeSpreadsheet(), properties = {}, fetchAll } = {}) {
  const props = fakeProperties(properties);
  const lock = { waits: 0, held: false };
  const scriptApp = fakeScriptApp();
  const urlFetch = {
    calls: [],
    fetchAll(requests) {
      urlFetch.calls.push(requests);
      if (!fetchAll) throw new Error("UrlFetchApp.fetchAll not expected in this test");
      return fetchAll(requests);
    },
  };

  globalThis.SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    newConditionalFormatRule: conditionalRuleBuilder,
    flush() {},
  };
  globalThis.PropertiesService = { getScriptProperties: () => props };
  globalThis.LockService = {
    getScriptLock: () => ({
      waitLock() {
        if (lock.held) throw new Error("Lock already held (nested withLock)");
        lock.held = true;
        lock.waits++;
      },
      tryLock() {
        if (lock.held) return false;
        lock.held = true;
        return true;
      },
      releaseLock() {
        lock.held = false;
      },
    }),
  };
  globalThis.ContentService = {
    MimeType: { JSON: "application/json" },
    createTextOutput(text) {
      const output = {
        text,
        mimeType: "text/plain",
        setMimeType(m) {
          output.mimeType = m;
          return output;
        },
        getContent: () => text,
      };
      return output;
    },
  };
  globalThis.ScriptApp = scriptApp;
  globalThis.UrlFetchApp = urlFetch;
  return { spreadsheet, props, lock, scriptApp, urlFetch };
}

// ---- LLM responses ------------------------------------------------------------

/** A UrlFetchApp-style response. */
export function httpResponse(code, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text };
}

/** A /chat/completions response whose message content is `content`. */
export function completion(content) {
  return httpResponse(200, { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
}

/** A classifier double with the same shape as createClassifier's. */
export function fakeClassifier({ label, draft = "Just checking in, any thoughts?", onClassify } = {}) {
  const calls = { classify: [], draft: [] };
  return {
    calls,
    enabled: true,
    classifyAll(items) {
      calls.classify.push(items);
      if (onClassify) onClassify(items);
      return items.map(() => label || { category: "Interested", confidence: 0.9, summary: "Wants a call", suggestedReply: "Great, Tuesday?" });
    },
    draftAll(items) {
      calls.draft.push(items);
      return items.map(() => draft);
    },
  };
}

// ---- a second CRM ---------------------------------------------------------------

/** The four-call CRM interface over plain objects. Shows the pipeline does not care what CRM it talks to. */
export function createMemoryCrm(leads = []) {
  const rows = leads.map((l) => ({ ...l }));
  const events = [];
  const crm = {
    rows,
    events,
    listLeads: () => rows.map((r) => ({ ...r })),
    upsertLead(fields) {
      const row = rows.find((r) => r.leadId === fields.leadId);
      if (row) Object.assign(row, fields);
      else rows.push({ ...code.emptyLead(fields.leadId), ...fields });
    },
    updateStatus(leadId, status, fields) {
      crm.upsertLead({ ...fields, status, leadId });
    },
    logEvent(event) {
      events.push(event);
    },
  };
  return crm;
}
