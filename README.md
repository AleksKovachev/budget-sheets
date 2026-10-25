# Budget Sheets

A small web app for a shared household budget kept in Google Sheets: who paid what, who owes whom,
month by month. It reads and writes the spreadsheet directly with the Google Sheets API, so the sheet
keeps working on its own exactly as before.

- Plain HTML, CSS and JavaScript, no build step.
- Sign-in with Google in the browser; the spreadsheet is only reachable for accounts it is shared with.
- No data is stored in this repository.

Setup: [SETUP.md](SETUP.md) · Spreadsheet layout and the rules the app follows: [SHEET_LAYOUT.md](SHEET_LAYOUT.md)

Run locally: `python serve.py`, then open http://localhost:8000 (test data, no sign-in; see SETUP.md).
