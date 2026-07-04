/**
 * 課程預約系統 — Google Apps Script
 *
 * 設定步驟：
 * 1. 打開你的 Google Sheet
 * 2. 上方選單：Extensions → Apps Script
 * 3. 把這整段程式碼貼入（取代原本的 myFunction）
 * 4. 儲存 (Ctrl+S)
 * 5. 上方選單：Deploy → New deployment
 *    - Type: Web app
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 6. 點 Deploy，複製產生的 Web app URL
 * 7. 把 URL 貼回 index.html 的 APPS_SCRIPT_URL 變數
 */

const SPREADSHEET_ID = '1t4mJ6476bHlExy6aF9TU_CvCtp3TcrTliv_eX6XZhno';
const SCHEDULE_SHEET_INDEX = 0; // 第一個 sheet tab（課程排程）

function doGet(e) {
  try {
    const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
    const sheet = ss.getSheets()[SCHEDULE_SHEET_INDEX];
    const data  = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return jsonResponse({ status: 'ok', courses: [] });
    }

    const headers = data[0].map(h => String(h).trim());
    const courses = [];

    for (let i = 1; i < data.length; i++) {
      const row    = data[i];
      const course = {};
      headers.forEach((h, j) => {
        course[h] = row[j] !== undefined ? String(row[j]) : '';
      });

      // 跳過空白列
      if (!course.courseName || course.courseName === '') continue;

      courses.push(course);
    }

    return jsonResponse({ status: 'ok', courses });

  } catch (err) {
    return jsonResponse({ status: 'error', message: err.message });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
