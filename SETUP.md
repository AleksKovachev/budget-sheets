# BudgetSheets – setup

One-time setup. Steps marked **(you)** need your Google account; everything else is in the repo.

## 1. Test copy of the spreadsheet (you)

1. Open the real spreadsheet with the account that owns it.
2. **File → Make a copy**. Name it e.g. `Budget – APP TEST`.
   Tick **"Share it with the same people"** so both of you can edit it.
3. Check that both of your Google accounts have **Editor** access to the copy (Share button).
4. Keep the copy's URL handy – the app asks for it on first run.

## 2. Export for Claude (you)

1. In the **copy**: **File → Download → Microsoft Excel (.xlsx)**.
2. Save it into `BudgetSheets/private/` (this folder is git-ignored, so it never gets uploaded).
3. Tell Claude whether you use anything that may not survive the export: dropdowns
   (data validation), conditional formatting, protected ranges, Apps Script, filter views.

## 3. Google Cloud project (you, ~20 minutes)

Use any Google account you like – it does **not** have to own the spreadsheet.
The Google Cloud console layout changes from time to time; if a menu name differs, look for the closest match.

1. Go to <https://console.cloud.google.com/> and accept the terms if asked.
2. Top bar → project picker → **New project**. Name: `BudgetSheets`. No organization. Create, then select it.
3. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
4. **Google Auth Platform** (older name: *OAuth consent screen*) → **Get started**:
   - App name: `BudgetSheets`, support email: yours.
   - Audience: **External**.
   - Contact email: yours. Agree, **Create**.
5. **Audience** → **Test users** → **Add users** → both your and your wife's Google account
   emails (the accounts that have access to the spreadsheet).
   Leave publishing status as **Testing** – this avoids Google's app review.
6. **Data Access** → **Add or remove scopes** → tick
   `.../auth/spreadsheets` (Google Sheets API), `openid` and `.../auth/userinfo.email` → Update → Save.
7. **Clients** → **Create client**:
   - Application type: **Web application**, name: `BudgetSheets web`.
   - **Authorized JavaScript origins** → add `http://localhost:8000`
     (the hosted address gets added here later).
   - Leave *Authorized redirect URIs* empty. **Create**.
8. Copy the **Client ID** (looks like `1234…-abc….apps.googleusercontent.com`) and give it to Claude.
   It is not a secret – it ends up in the public web page anyway.
   You do **not** need the client secret; don't share it.

On first sign-in you'll both see a "Google hasn't verified this app" warning.
That's expected for an app in Testing mode: **Continue**.

## 4. Running it locally

From the `BudgetSheets` folder:

```bash
python serve.py
```

Open <http://localhost:8000>. Locally the app uses test data (`private/fixture.json`, made from an
exported .xlsx by `tools/xlsx_to_fixture.py`) instead of signing in to Google. To try the real
sign-in locally, add `?real` to the address; that only works at exactly <http://localhost:8000>
(not `127.0.0.1`) and only if that origin is registered in step 3.7.

## 5. Hosting (later)

When the app is usable, we'll publish it (likely GitHub Pages) and add that address to the
**Authorized JavaScript origins** in step 3.7.
