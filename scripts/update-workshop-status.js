#!/usr/bin/env node
/**
 * Keeps WORKSHOP_DATA in index.html in sync with live registration counts.
 *
 * Source of truth:
 * - Session list (which dates exist, time, teacher, form link): the 工作坊
 *   tab in the "Offline_Schedule Backstage" spreadsheet.
 * - Registration counts: the per-workshop response tabs in the
 *   "工作坊_活動" spreadsheet (matched by courseName -> COURSE_MAP below).
 *
 * Both are read via the public gviz CSV export (no auth needed; the sheets
 * are shared as "Anyone with the link - Viewer").
 *
 * This script only touches capacity-status fields (total/spotsTaken/
 * spotsLeft or full/waitlist) on existing entries, and only auto-adds a new
 * entry when it can safely reuse an existing description for that same
 * courseName. Anything it can't do safely gets printed as a REVIEW NEEDED
 * line instead of guessed.
 */

const fs = require("fs");
const path = require("path");

const OFFLINE_SCHEDULE_SHEET_ID = "1t4mJ6476bHlExy6aF9TU_CvCtp3TcrTliv_eX6XZhno";
const ACTIVITY_SHEET_ID = "19YnuP0OWF448Ft3XdkgyRbeMDfUNwufdX3kr1i0FZBI";
const WORKSHOP_TAB_NAME = "工作坊";
const INDEX_HTML_PATH = path.join(__dirname, "..", "index.html");

const COURSE_MAP = {
  開髖工作坊: { activitySheet: "開髖工作坊", capacity: 6 },
  肩頸放鬆工作坊: { activitySheet: "肩頸工作坊", capacity: 6 },
};

function gvizCsvUrl(spreadsheetId, sheetName) {
  const encoded = encodeURIComponent(sheetName);
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encoded}`;
}

async function fetchCsv(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}) for ${url}`);
  }
  return res.text();
}

// Minimal RFC4180-ish CSV parser: handles quoted fields, "" escaped quotes,
// commas/newlines inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell !== ""));
}

async function fetchSheetRows(spreadsheetId, sheetName) {
  const csv = await fetchCsv(gvizCsvUrl(spreadsheetId, sheetName));
  const rows = parseCsv(csv);
  if (rows.length === 0) return { header: [], rows: [] };
  const [header, ...dataRows] = rows;
  return { header: header.map((h) => h.trim()), rows: dataRows };
}

function toSessionKey(dateStr) {
  // "2026/9/18" -> "9/18" (strip zero-padding so it matches the
  // response-sheet 場次 values, which are typically written like "9/18" or
  // "9/18（五）15:00 - 18:00").
  const parts = dateStr.split("/").map((p) => p.trim());
  if (parts.length < 3) return dateStr;
  const month = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  return `${month}/${day}`;
}

async function countRegistrationsBySession(activitySheetName) {
  const { header, rows } = await fetchSheetRows(ACTIVITY_SHEET_ID, activitySheetName);
  const sessionCols = header
    .map((h, i) => ({ h, i }))
    .filter(({ h }) => h === "場次" || h === "選擇場次")
    .map(({ i }) => i);
  const emailCol = header.findIndex((h) => /^email address$/i.test(h) || /電子郵件|信箱/.test(h));

  const counts = {};
  for (const row of rows) {
    const email = emailCol >= 0 ? (row[emailCol] || "").trim() : "";
    if (!email) continue;
    let sessionValue = "";
    for (const col of sessionCols) {
      if (row[col] && row[col].trim()) {
        sessionValue = row[col].trim();
        break;
      }
    }
    if (!sessionValue) continue;
    // sessionValue may be "9/18" or "9/18（五）15:00 - 18:00"; take the
    // leading "M/D" token as the key.
    const match = sessionValue.match(/^(\d{1,2}\/\d{1,2})/);
    const key = match ? match[1] : sessionValue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function fetchWorkshopTab() {
  const { header, rows } = await fetchSheetRows(OFFLINE_SCHEDULE_SHEET_ID, WORKSHOP_TAB_NAME);
  const idx = {
    name: header.indexOf("課程名稱"),
    date: header.indexOf("日期"),
    start: header.indexOf("開始時間"),
    end: header.findIndex((h) => h.trim() === "結束時間"),
    teacher: header.indexOf("授課老師"),
    form: header.indexOf("報名表單"),
  };
  return rows
    .map((r) => ({
      name: (r[idx.name] || "").trim(),
      date: (r[idx.date] || "").trim(),
      start: (r[idx.start] || "").trim(),
      end: (r[idx.end] || "").trim(),
      teacher: (r[idx.teacher] || "").trim(),
      formUrl: (r[idx.form] || "").trim(),
    }))
    .filter((r) => r.name && r.date);
}

function todayInTaipei() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00+08:00`);
}

function parseEntryDate(dateStr) {
  const [y, m, d] = dateStr.split("/").map((s) => parseInt(s, 10));
  return new Date(y, m - 1, d);
}

function extractArraySource(html, constName) {
  const startMarker = `const ${constName} = [`;
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`Could not find ${constName} in index.html`);
  const arrayStart = startIdx + startMarker.length - 1; // position of the "["
  let depth = 0;
  let i = arrayStart;
  for (; i < html.length; i++) {
    if (html[i] === "[") depth++;
    else if (html[i] === "]") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const arrayText = html.slice(arrayStart, i);
  return { arrayText, rangeStart: arrayStart, rangeEnd: i };
}

function formatEntry(w) {
  const fields = [`name:${JSON.stringify(w.name)}`, `teacher:${JSON.stringify(w.teacher)}`, `date:${JSON.stringify(w.date)}`, `time:${JSON.stringify(w.time)}`];
  if (w.full) {
    fields.push(`full:true`);
    if (w.waitlist) fields.push(`waitlist:true`);
  } else if (w.total !== undefined) {
    fields.push(`total:${w.total}`, `spotsTaken:${w.spotsTaken}`, `spotsLeft:${w.spotsLeft}`);
  }
  fields.push(`formUrl:${JSON.stringify(w.formUrl)}`);
  const head = `    { ${fields.join(", ")},`;
  const desc = `      desc:${JSON.stringify(w.desc)} },`;
  return `${head}\n${desc}`;
}

async function main() {
  const html = fs.readFileSync(INDEX_HTML_PATH, "utf8");
  const { arrayText, rangeStart, rangeEnd } = extractArraySource(html, "WORKSHOP_DATA");
  const currentData = new Function(`return ${arrayText};`)();

  const workshopTabRows = await fetchWorkshopTab();

  const registrationCounts = {};
  for (const [courseName, cfg] of Object.entries(COURSE_MAP)) {
    registrationCounts[courseName] = await countRegistrationsBySession(cfg.activitySheet);
  }

  const today = todayInTaipei();
  const byNameAndDate = new Map();
  for (const w of currentData) {
    byNameAndDate.set(`${w.name}|${w.date}`, w);
  }

  const changes = [];
  const reviewNeeded = [];
  const nextData = currentData.map((w) => ({ ...w }));

  // 1) Refresh status on existing future entries.
  for (const entry of nextData) {
    if (parseEntryDate(entry.date) < today) continue;
    const cfg = COURSE_MAP[entry.name];
    if (!cfg) {
      reviewNeeded.push(`Unmapped workshop name "${entry.name}" (${entry.date}) — add it to COURSE_MAP to get live counts.`);
      continue;
    }
    const key = toSessionKey(entry.date);
    const count = registrationCounts[entry.name][key] || 0;
    const wasFull = !!entry.full;
    const before = JSON.stringify({ full: entry.full, waitlist: entry.waitlist, total: entry.total, spotsTaken: entry.spotsTaken, spotsLeft: entry.spotsLeft });

    delete entry.full;
    delete entry.waitlist;
    delete entry.total;
    delete entry.spotsTaken;
    delete entry.spotsLeft;

    if (count >= cfg.capacity) {
      entry.full = true;
      entry.waitlist = true;
    } else {
      entry.total = cfg.capacity;
      entry.spotsTaken = count;
      entry.spotsLeft = cfg.capacity - count;
    }

    const after = JSON.stringify({ full: entry.full, waitlist: entry.waitlist, total: entry.total, spotsTaken: entry.spotsTaken, spotsLeft: entry.spotsLeft });
    if (before !== after) {
      changes.push(`${entry.name} ${entry.date}: ${wasFull ? "full" : `${count}/${cfg.capacity}`} -> ${entry.full ? "full" : `${count}/${cfg.capacity}`}`);
    }
  }

  // 2) Remove future entries for mapped workshop types that are no longer
  // listed in the 工作坊 tab (i.e. the session was cancelled/removed at the
  // source). Only applies to COURSE_MAP-tracked names, so unmapped/manual
  // entries are never silently deleted.
  const workshopTabKeys = new Set(workshopTabRows.map((r) => `${r.name}|${r.date}`));
  let removedCount = 0;
  for (let i = nextData.length - 1; i >= 0; i--) {
    const entry = nextData[i];
    if (parseEntryDate(entry.date) < today) continue;
    if (!COURSE_MAP[entry.name]) continue;
    if (workshopTabKeys.has(`${entry.name}|${entry.date}`)) continue;
    changes.push(`Removed cancelled session ${entry.name} ${entry.date} (no longer in 工作坊 tab)`);
    nextData.splice(i, 1);
    removedCount++;
  }

  // 3) Add sessions that exist in the 工作坊 tab (future) but aren't in
  // WORKSHOP_DATA yet, reusing an existing desc for that courseName.
  for (const row of workshopTabRows) {
    if (parseEntryDate(row.date) < today) continue;
    const existing = byNameAndDate.get(`${row.name}|${row.date}`);
    if (existing) continue;

    const cfg = COURSE_MAP[row.name];
    const descSource = currentData.find((w) => w.name === row.name && w.desc);
    if (!cfg || !descSource) {
      reviewNeeded.push(`New session "${row.name}" ${row.date} found in 工作坊 tab but no existing description/capacity mapping to safely auto-add — add it manually.`);
      continue;
    }

    const count = registrationCounts[row.name][toSessionKey(row.date)] || 0;
    const newEntry = {
      name: row.name,
      teacher: row.teacher || descSource.teacher,
      date: row.date,
      time: row.start && row.end ? `${row.start}–${row.end}` : descSource.time,
      formUrl: row.formUrl || descSource.formUrl,
      desc: descSource.desc,
    };
    if (count >= cfg.capacity) {
      newEntry.full = true;
      newEntry.waitlist = true;
    } else {
      newEntry.total = cfg.capacity;
      newEntry.spotsTaken = count;
      newEntry.spotsLeft = cfg.capacity - count;
    }
    nextData.push(newEntry);
    changes.push(`Added new session ${row.name} ${row.date} (${count}/${cfg.capacity})`);
  }

  nextData.sort((a, b) => parseEntryDate(a.date) - parseEntryDate(b.date));

  if (reviewNeeded.length > 0) {
    console.log("REVIEW NEEDED:");
    reviewNeeded.forEach((line) => console.log(`  - ${line}`));
  }

  if (changes.length === 0) {
    console.log("No changes to WORKSHOP_DATA.");
    process.exit(0);
  }

  console.log("Changes:");
  changes.forEach((line) => console.log(`  - ${line}`));

  const newArrayText = `[\n${nextData.map(formatEntry).join("\n")}\n  ]`;
  const newHtml = html.slice(0, rangeStart) + newArrayText + html.slice(rangeEnd);
  fs.writeFileSync(INDEX_HTML_PATH, newHtml, "utf8");
  console.log("index.html updated.");
}

main().catch((err) => {
  console.error("update-workshop-status failed:", err);
  process.exit(1);
});
