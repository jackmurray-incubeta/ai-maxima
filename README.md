AI Maxima (v2.5)
This is NOT an officially supported Google product.

An automated reporting solution that populates a Google Sheet with data from Google Ads and visualizes AI Max performance in a Looker Studio dashboard across Search and Shopping.

Dashboard Overview (14 Tabs)
AI Max for Search
Exec Summary: Progress of key metrics, adoption scorecards, and AI Max readiness trendlines over the lookback window.
Time Series: Daily metric comparisons (Total Search vs. AI Max).
AI Max Uplift: Incremental uplift in Clicks, Cost, and Conversion Value.
Search Term Matching: Breakdown of Your Keywords vs. AI Max Expanded Matches vs. Landing Page Matches.
Feature Adoption: Campaign-level audit of Search Term Matching (STM), Text Customization (TC), and Final URL Expansion (FUE).
AI Max Search Terms: Top AI Max search terms, including metrics for all match types and unique AI Max queries.
AI Generated Assets: Top headlines and descriptions performance view.
Search Terms & Ad Combinations: Combinations of user Search Terms, ad Headlines, and destination Landing Pages.
Landing Page Insights: Performance of landing pages matched and expanded by AI Max (FUE).
Top Opportunities to Scale AI Max: Top campaigns not opted into AI Max with potential incremental uplift projections.
AI Max for Shopping
Performance Summary: Shopping adoption rates, campaign counts, and time-series trends.
Feature Reporting: Campaign feature flags (STM, TC, FUE) and granular search term query report.
Best Practices: Campaign audit for tROAS bidding, FUE opt-in, and budget constraints.
Governance & Support
FAQ: Core setup instructions, data definitions, and troubleshooting.
Getting Started
1. Deploy & Schedule Google Ads Script
In your Google Ads account (MCC or Single Account), on the left toolbar, navigate to: Tools > Bulk Actions > Scripts > + to create a new script. See more details here.
Rename the script to: AI_MAXIMA.
Copy and paste the code in the Code file, overwriting the existing function.
Save and authorize the script to run.
Execute the script:
Single Account Deployment - Run the script in preview mode:
In the first run it will generate the spreadsheet & worksheets and populate these with data.
MCC Deployment - Run the script twice in preview mode:
In the first run it will generate a copy of the spreadsheet template and fetch all CIDs under the MCC, check the spreadsheet tab Customers.
In the second run, for all the checked in customer IDs it will populate the rest of the tabs of the spreadsheet.
(Optional): Schedule the Google Ads Script to run daily:
On the “Scripts” page in the “Frequency” column, hover over the frequency value for a script, which is initially blank.
Click the pencil icon (Edit icon).
You can choose an exact date, a day of the week, or a day of the month. You can also choose the time you'd like your script to run.
Click Save.
You can schedule the script to run daily in the Tools > Bulk Actions > Scripts > Frequency on Google Ads.
2. Generate Looker Studio Dashboard
Upon successful execution, the script outputs a unique Looker Studio URL in the Logs tab. Use this link to initialize your dashboard.

Copy the URL from the Ads Script logs and paste it into your browser address bar.
Verify the template loads with your data source connected.
Click Edit and share (top right corner) to save a permanent copy of the report.
When the “Review Data access” window appears, click Acknowledge and save.
Finalize: You can now rename the dashboard (top left) and share it with stakeholders using the Share button.
Threshold & Configuration Guide (RunConfig)
To ensure the script completes within the 30-minute Google Ads Script execution limit and prevent Looker Studio from crashing due to Google Sheet data limits, default thresholds are applied across almost all views.

You can customize these parameters at the top of the script inside the RunConfig object to match your account size and reporting requirements.

Detailed Threshold Guidance by Category
1. Date Range & Lookback Window (Max Cap: 180 Days)
Lookback Days (LOOKBACK_DAYS): Default is 30.
When to change: Lower to 14 days for faster script runs on large accounts, or increase to 60 or 90 days for quarterly reviews on smaller accounts.
Explicit Dates (USE_EXPLICIT_DATES, START_DATE, END_DATE): Default is false.
When to change: Set USE_EXPLICIT_DATES: true when evaluating a specific promotional event, holiday season, or closed fiscal calendar month (e.g., '2025-01-30' to '2025-06-30').
180-Day Maximum Safety Cap: A strict safety cap applies to both modes—the total duration between startDate and endDate cannot exceed 180 days. If the selected window exceeds 180 days, startDate is automatically clamped to exactly 180 days prior to endDate, and a warning is logged.
2. General & Campaign Scope Settings (CAMPAIGN_FILTER_MODE)
Controlled by CAMPAIGN_FILTER_MODE, which supports three execution modes:

'ALL' (Default): Processes all eligible Search and Shopping campaigns matching existing channel criteria.
'TOP_N': Processes only the top N Search campaigns and top N Shopping campaigns ranked separately by highest spend (cost_micros) within the selected date range.
Set TOP_N_COUNT: 5 (or any integer) to define N. Useful for massive accounts to focus only on major spenders.
'CUSTOM': Processes only campaigns explicitly specified in CUSTOM_CAMPAIGN_MAP.
Map Customer IDs to Campaign ID arrays, e.g.: CUSTOM_CAMPAIGN_MAP: { '1234567890': [11111111, 22222222], '987-654-3210': [33333333] }
3. Search Campaign Thresholds
Search Terms Overview (SEARCH_TERMS_OVERVIEW_IMPRESSIONS_THRESHOLD): Default is 25.
Why it's set: Prunes the long tail of one-off queries in Search.
When to change: Lower to 5–10 for low-volume accounts to capture more niche search queries. On large accounts with 50k+ keywords, increase to 50 or 100 to speed up script execution.
AI Generated Assets (GENERATED_VIEW_IMPRESSIONS_THRESHOLD): Default is 25.
Why it's set: Filters out newly created headlines/descriptions that have barely served, keeping the asset report focused on meaningful data.
When to change: Lower to 10 if you want to inspect newly launched creative text early. Raise to 50 or 100 on enterprise accounts to highlight only high-traffic creatives.
Keywords View (KEYWORDS_VIEW_IMPRESSIONS_THRESHOLD): Default is 25.
Why it's set: Manages row volume in the keyword match type breakdown.
When to change: Lower to 0 or 5 for smaller accounts where every keyword matters.
Search Terms & Ad Combinations (SEARCH_TERMS_AND_COMBINATIONS_IMPRESSIONS_THRESHOLD): Default is 100.
Why it's set: The combination matrix (Search Term × Headline × Landing Page) can multiply row counts rapidly.
When to change: Only lower this (e.g., to 25 or 50) on small accounts with limited ad groups. On high-volume accounts, keep at 100 or higher to prevent query timeouts.
Landing Page Insights (LANDING_PAGE_INSIGHTS_IMPRESSIONS_THRESHOLD): Default is 100.
Why it's set: Focuses the Final URL Expansion report on URLs receiving sustained traffic.
When to change: Lower to 25 or 50 if you want to audit every expanded landing page URL that received any traffic.
4. Shopping Campaign Thresholds
Clicks Threshold (SHOPPING_SEARCH_TERMS_OVERVIEW_CLICKS_THRESHOLD): Default is 3.
Account Sizing Check (10-Second Google Ads UI Check): In Google Ads, go to Campaigns > Insights and reports > Search terms, filter for Shopping with Campaign Status = ALL, and review the total search term count:
Under 15,000 search terms: Lower to clicks > 0 (or clicks > 1) in RunConfig to see 100% of clicked search terms.
Over 15,000 search terms: Keep the default clicks > 3 to prevent spreadsheet bloat and Looker Studio timeouts.
Impressions Floor (SHOPPING_SEARCH_TERMS_OVERVIEW_IMPRESSIONS_THRESHOLD): Default is 25 (or 0).
When to change: Lower to 0 or 1 for smaller accounts where every search impression counts. On high-volume feeds, keep at 25 or 100 to suppress single-impression queries.
Shopping Landing Pages (SHOPPING_LANDING_PAGE_REPORT_IMPRESSIONS_THRESHOLD): Default is 100.
When to change: Lower to 25 or 50 for smaller catalogs to ensure landing pages with lower traffic still appear.
Shopping Search Terms Metrics (SHOPPING_SEARCH_TERMS_METRICS_IMPRESSIONS_THRESHOLD): Default is 100.
When to change: Filters the granular shopping metrics table. Lower to 25–50 for smaller retail accounts.
Configurable RunConfig Code Snippet
To apply any of the above changes, update the values in const RunConfig at the top of the script:

const RunConfig = {
  // --- 1. DATE RANGE CONTROLS ---
  // Mode A: Lookback Days (Default)
  USE_EXPLICIT_DATES: false,
  LOOKBACK_DAYS: 30, // Number of days to pull (Max duration: 180 days)

  // Mode B: Explicit Dates (Set USE_EXPLICIT_DATES to true to activate)
  START_DATE: '2025-01-30', // Format: YYYY-MM-DD
  END_DATE: '2025-06-30',

  // --- 2. CAMPAIGN SELECTION FILTERS ---
  // Mode 1: 'ALL' (Default) | Mode 2: 'TOP_N' | Mode 3: 'CUSTOM'
  CAMPAIGN_FILTER_MODE: 'ALL',
  TOP_N_COUNT: 5,           // Used when CAMPAIGN_FILTER_MODE is 'TOP_N'
  CUSTOM_CAMPAIGN_MAP: {    // Used when CAMPAIGN_FILTER_MODE is 'CUSTOM'
    // '1234567890': [11111111, 22222222],
    // '987-654-3210': [33333333]
  },

  // --- 3. TELEMETRY SETTING ---
  TELEMETRY_OPT_OUT: false,           // Set to true to disable GA4 adoption telemetry

  // --- 4. SEARCH CAMPAIGN THRESHOLDS ---
  GENERATED_VIEW_IMPRESSIONS_THRESHOLD: 25,
  SEARCH_TERMS_OVERVIEW_IMPRESSIONS_THRESHOLD: 25,
  KEYWORDS_VIEW_IMPRESSIONS_THRESHOLD: 25,
  SEARCH_TERMS_AND_COMBINATIONS_IMPRESSIONS_THRESHOLD: 100,
  LANDING_PAGE_INSIGHTS_IMPRESSIONS_THRESHOLD: 100,
  TIME_SERIES_CAMPAIGN_IMPRESSIONS_THRESHOLD: 0,
  AI_MAX_FEATURE_ADOPTION_IMPRESSIONS_THRESHOLD: 0,
  TOP_OPPORTUNITIES_IMPRESSIONS_THRESHOLD: 0,

  // --- 5. SHOPPING CAMPAIGN THRESHOLDS ---
  SHOPPING_SEARCH_TERMS_OVERVIEW_CLICKS_THRESHOLD: 3,       // Min clicks (<15k terms: 0-1, >15k terms: 3)
  SHOPPING_SEARCH_TERMS_OVERVIEW_IMPRESSIONS_THRESHOLD: 25, // Impression cutoff for shopping search terms
  SHOPPING_SEARCH_TERMS_METRICS_IMPRESSIONS_THRESHOLD: 100, // Impression cutoff for metrics table
  SHOPPING_LANDING_PAGE_REPORT_IMPRESSIONS_THRESHOLD: 100,  // Impression cutoff for landing pages
  AI_MAX_SHOPPING_TIME_SERIES_IMPRESSIONS_THRESHOLD: 0,
  AI_MAX_FEATURE_ADOPTION_SHOPPING_IMPRESSIONS_THRESHOLD: 0,
  SHOPPING_BEST_PRACTICES_ADOPTION_IMPRESSIONS_THRESHOLD: 0
};
Telemetry & Privacy
AI Maxima collects anonymous telemetry via Google Analytics 4 (GA4) Measurement Protocol strictly to evaluate aggregate solution adoption.

What is tracked:
Execution Metadata: Script run timestamp, script version (v2.5), execution mode (Single_CID vs. MCC), user type (Internal vs. External), total campaigns processed, and execution status.
Account Pseudonymization: A client-side salted, one-way cryptographic hash (SHA-256) of the Customer ID (c_ref) to calculate unique repeat adoption without revealing the account identity.
What is NEVER tracked:
No Personal Identifiable Information (PII) or user emails.
No raw Customer IDs, MCC numbers, or account names.
No financial figures, spend data, conversion values, or search queries.
How to Opt Out:
To completely disable telemetry, update TELEMETRY_OPT_OUT to true in RunConfig:

const RunConfig = {
  TELEMETRY_OPT_OUT: true,
  ...
};
When set to true, the account identifier is masked as 'TELEMETRY_OPT_OUT' and telemetry transmission is suppressed.

Support and Contact
For any technical issues or deployment support, please reach out to your Google Account Team (Account Manager or Account Specialist) or the Google Help Center Page.
Privacy and Data Protection
AI Maxima operates within the context of the advertiser‘s Google Ads account. Data processing is subject to Google’s standard privacy commitments.
1. Privacy Policy
For information on how Google handles data, please refer to Google's Privacy Policy.
2. Privacy Inquiries
If you have any privacy-related inquiries or complaints (including inquiries related to the Data Privacy Framework), please contact us via the Google Privacy Help Center.
