# Spreadsheet layout

The app works on the existing spreadsheet and must never change how it works in Google Sheets:
formulas, dropdowns, conditional formatting and frozen rows stay untouched.

## Tabs

- **Year tabs** (`2022`, `2023`, …; name is exactly four digits): the budget. One per year.
  A new year's tab is a copy of the previous year's tab with the entries cleared.
- **`List`**: categories in `A2:A50`, used by the Category dropdown.
- Everything else (`Home`, `Template`, `food list`, …) is unrelated and ignored by the app.

## Year tab

Rows 1–3 are frozen: row 1 = headers, rows 2–3 = totals (row 2 Aleks, row 3 Iliyana).

| Col | Header | Meaning |
|---|---|---|
| A | Date | Real date value (picked with the calendar). |
| B | Catgory (or Category) | Dropdown from `List!A2:A50`. |
| C | Aditional information (or Additional information) | Free text. |
| D | Paid by Aleks | Aleks paid; the amount is shared 50/50. |
| E | Personal Aleks | Part of D (same row) that was only for Aleks. Shared amount = D − E. Rarely used. |
| F | Aleks cash in | Aleks gave Iliyana this much. Not shared: counts in full. |
| G–I | … Iliyana | Same three columns for Iliyana. |
| J | | 2026 only: lev → euro converter in J2:J3 (with I2:I3). Not data. |
| K | | Names (`Total Aleks`, `Total Iliyana`) in K2:K3. |
| L | Total price | `SUM(D) − SUM(E)` (row 2), `SUM(G) − SUM(H)` (row 3) |
| M | Half price | `L / 2` |
| N | Cash in total | `SUM(F)` / `SUM(I)` |
| O | Owes the other (was "Owns the other"; the app accepts both) | Row 2: `(M3 − M2) − N2 + N3` = what Aleks owes Iliyana. Row 3 = the negative: what Iliyana owes Aleks. |
| P | Currency | 2026 only: `€` reminder. |

Formula ranges are fixed (e.g. `SUM(D4:D1990)`), so rows must be **inserted inside** the data area,
never added below the end of those ranges.

## Rows

- **Row 4**: carry-over from the previous year, e.g. `From 2025`, in one of the cash-in columns depending
  on who owed whom. Formulas take it from the previous tab, e.g. `F4 = IF('2024'!O3 > 0, '2024'!O3, )`.
  In 2026, F2:I3 convert the 2025 result from leva to euro (at the fixed rate, 1.95583 лв per €) for row 4.
  (2022, the first year, has a normal entry in row 4.) The app never writes to row 4.
- **Row 5 onwards**: entries, sorted by date.
- **One blank row between months.** Each month is one block of rows.

## How the app writes (main page)

- A new entry goes into its month at the sorted position (after entries with the same date). The newest
  entry of the newest month goes into the next empty row; a new month gets one blank row before it.
- A changed date that keeps the entry between its neighbours only changes the date; otherwise the entry is
  added at its new place first and the old row removed afterwards (with its month's blank row if the month
  became empty).
- Before every change the app re-reads the row and refuses if it differs from what the page showed.

## New year tab (created by the app)

When a date falls in a year without a tab (later than the newest one), the app asks, then:
copies the newest year's tab (layout, formulas, formatting, dropdowns, colour rules), clears everything
below row 4 plus A2:J3 and P1:P3 (2026's lev→euro helper and currency note), and sets row 4 to
`1 January` | | `From <previous year>` with the cash-in formulas
`F4 = IF('<prev>'!O3 > 0, '<prev>'!O3, )` and `I4 = IF('<prev>'!O2 > 0, '<prev>'!O2, )`.

## Currency

Year tabs before 2026 are in leva (BGN), from 2026 in euro. For statistics across years,
leva are converted at the fixed rate **1 EUR = 1.95583 BGN** (÷ 1.95583 to euro, × 1.95583 to leva).

## Statistics: what each person spent

Per entry (budget.js `spending()`), with shared = (D − E) + (G − H):

- Aleks: E + shared / 2 + I (his personal part, half of everything shared, and what Iliyana paid only for him)
- Iliyana: H + shared / 2 + F
- Combined: the two together = D + G + F + I (everything paid, including cash in)

The carry-over (row 4) is not spending and is left out.
