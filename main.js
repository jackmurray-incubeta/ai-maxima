/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * @fileoverview This script processes customer accounts in Google Ads, fetches
 * data using GAQL queries, and populates a Google Sheet with the results. It
 * also tracks execution time to manage script limitations.
 */
const Config = {
  CUSTOMERS_SHEET_RANGE: 'Customers!A2:G',
  TIME_ZONE: 'Europe/Amsterdam',
  API_VERSION: 'v25',
  EXECUTION_TIME_BUFFER: 0.95,
  SEARCH_TERMS_CLICKS_THRESHOLD: 25,
  LOOKER_STUDIO_REPORT_TEMPLATE: '0e07417c-f40c-453b-856b-4a01549447bc',
  LOOKER_STUDIO_SEARCH_ONLY_REPORT_TEMPLATE: 'e33c1e54-e5d8-4bf7-b868-16a96b1b3a17', // Template ID for Search-only tabs
  INCREMENTAL_UPLIFT_RATE: 0.14,
  TELEMETRY_SALT: 'ai_maxima_telemetry_salt_2026' // Salt used for SHA-256 hashing of Customer IDs
};
/**
 * ============================================================================
 * RUN CONFIGURATION (USER-FACING HYBRID EXECUTION CONTROLS)
 * ============================================================================
 * Configures global Date Range controls, Campaign Selection filters, and
 * Channel Scope controls to enable flexible hybrid execution modes.
 *
 * --- 1. CHANNEL SCOPE CONTROLS ---
 * Controlled by `CSS_CONSENT`:
 * - true (Default): Execute all queries (both Search and Shopping tabs) and
 *   bind all data sources to the main Looker Studio template.
 * - false: Execute ONLY Search queries/tabs (skips Shopping queries) and
 *   uses the Search-only Looker Studio dashboard template ID.
 *
 * --- 2. DATE RANGE CONTROLS (Mutually Exclusive Modes) ---
 * Select either Mode A (Lookback Duration) or Mode B (Explicit Dates):
 *
 * Mode A: Lookback Duration (Set USE_EXPLICIT_DATES to false)
 * - Dynamically computes the range ending today: `startDate = endDate - X days`.
 * - LOOKBACK_DAYS: Duration X in days (default: 30 days).
 *
 * Mode B: Explicit Dates (Set USE_EXPLICIT_DATES to true)
 * - Uses fixed start and end dates. When enabled, lookback duration calculations
 *   are skipped, and endDate is NOT defaulted to today.
 * - START_DATE: Explicit start date in 'YYYY-MM-DD' format (e.g., '2025-01-01').
 * - END_DATE: Explicit end date in 'YYYY-MM-DD' format (e.g., '2025-06-30').
 *
 * Safety Cap & Validation:
 * A strict safety cap applies to both modes! The final duration between
 * startDate and endDate must not exceed 180 days. If the duration exceeds
 * 180 days, startDate is automatically forced to exactly 180 days prior to
 * endDate, and a warning is logged to alert the user.
 *
 * --- 3. CAMPAIGN SELECTION FILTERS ---
 * Controlled by `CAMPAIGN_FILTER_MODE`, which supports three execution modes:
 *
 * Mode 1: 'ALL' (Default)
 * - Process all campaigns matching the existing channel criteria (SEARCH / SHOPPING).
 *
 * Mode 2: 'TOP_N'
 * - Process only the top N Search campaigns and top N Shopping campaigns
 *   separately ranked by highest spend (cost_micros) within the selected date range.
 *   Search tabs will use the Search top N campaigns, and Shopping tabs will use
 *   the Shopping top N campaigns.
 * - TOP_N_COUNT: Integer specifying N (e.g., 5 for Search and 5 for Shopping).
 *
 * Mode 3: 'CUSTOM'
 * - Process only campaigns explicitly mapped in `CUSTOM_CAMPAIGN_MAP`.
 * - CUSTOM_CAMPAIGN_MAP: Object mapping Customer IDs (with or without hyphens)
 *   to an array of Campaign IDs (numbers or strings).
 *   Example: { "1234567890": [11111111, 22222222], "987-654-3210": [33333333] }
 *
 * --- 4. TELEMETRY OPT-OUT ---
 * Controlled by TELEMETRY_OPT_OUT, which determines whether to pass the non-identifying
 * telemetry data to Google Analytics 4 (GA4) or not.
 * - false (Default): Pass the non-identifying telemetry data  to GA4.
 * - true: Do NOT pass any data to GA4.
 */
const RunConfig = {
  // Set to false to omit Shopping data for EEA/UK/CH without CSS consent
  CSS_CONSENT: true,
  get SEARCH_TABS_ONLY() {
    return !this.CSS_CONSENT;
  },
  // Date Range Mode Toggle: false for Mode A (Lookback), true for Mode B (Explicit)
  USE_EXPLICIT_DATES: false,
  LOOKBACK_DAYS: 30,
  START_DATE: '2025-01-30',
  END_DATE: '2025-06-30',
  // Campaign Filter Mode: 'ALL' | 'TOP_N' | 'CUSTOM'
  CAMPAIGN_FILTER_MODE: 'ALL',
  TOP_N_COUNT: 5,
  CUSTOM_CAMPAIGN_MAP: {
    // Example: '1234567890': [11111111, 22222222],
    // '987-654-3210': [33333333]
  },
  // Telemetry Opt-Out: false (Default) to pass data to GA4, true to Not pass
  TELEMETRY_OPT_OUT: false,
  // --- SEARCH CAMPAIGN TAB IMPRESSION THRESHOLDS ---
  GENERATED_VIEW_IMPRESSIONS_THRESHOLD: 25,
  SEARCH_TERMS_OVERVIEW_IMPRESSIONS_THRESHOLD: 25,
  KEYWORDS_VIEW_IMPRESSIONS_THRESHOLD: 25,
  SEARCH_TERMS_AND_COMBINATIONS_IMPRESSIONS_THRESHOLD: 100,
  LANDING_PAGE_INSIGHTS_IMPRESSIONS_THRESHOLD: 100,
  TIME_SERIES_CAMPAIGN_IMPRESSIONS_THRESHOLD: 25,
  AI_MAX_FEATURE_ADOPTION_IMPRESSIONS_THRESHOLD: 0,
  TOP_OPPORTUNITIES_IMPRESSIONS_THRESHOLD: 0,
  // --- SHOPPING CAMPAIGN TAB IMPRESSION THRESHOLDS ---
  SHOPPING_SEARCH_TERMS_OVERVIEW_IMPRESSIONS_THRESHOLD: 25,
  SHOPPING_SEARCH_TERMS_METRICS_IMPRESSIONS_THRESHOLD: 0,
  SHOPPING_SEARCH_TERMS_METRICS_CLICKS_THRESHOLD: 3,
  SHOPPING_LANDING_PAGE_REPORT_IMPRESSIONS_THRESHOLD: 100,
  AI_MAX_SHOPPING_TIME_SERIES_IMPRESSIONS_THRESHOLD: 0,
  AI_MAX_FEATURE_ADOPTION_SHOPPING_IMPRESSIONS_THRESHOLD: 0,
  SHOPPING_BEST_PRACTICES_ADOPTION_IMPRESSIONS_THRESHOLD: 0
};
/**
 * Enum to indicate column indices in the mapping sheet.
 * @enum {string}
 */
const SHEETNAMES = {
  CUSTOMERS: 'Customers',
  SEARCH_TERMS_OVERVIEW: 'SearchTermsOverview',
  KEYWORDS_VIEW: 'KeywordsView',
  TIME_SERIES_CAMPAIGN: 'TimeSeriesCampaign',
  GENERATED_VIEW: 'GeneratedView',
  AI_MAX_FEATURE_ADOPTION: 'AIMaxFeatureAdoption',
  TOP_OPPORTUNITIES: 'TopOpportunities',
  AI_MAX_FEATURE_ADOPTION_SHOPPING: 'AIMaxFeatureAdoptionShopping',
  AI_MAX_FEATURE_ADOPTION_SHOPPING_GRAPH: 'AIMaxFeatureAdoptionShoppingGraph',
  AI_MAX_SHOPPING_TIME_SERIES: 'AIMaxShoppingTimeSeries',
  SHOPPING_SEARCH_TERMS_OVERVIEW: 'ShoppingSearchTermsOverview',
  SHOPPING_SEARCH_TERMS_METRICS: 'ShoppingSearchTermsMetrics',
  SHOPPING_BEST_PRACTICES_ADOPTION: 'ShoppingBestPracticesAdoption',
  SEARCH_TERMS_AND_COMBINATIONS: 'SearchTermxAdCombinationView',
  LANDING_PAGE_INSIGHTS: 'LandingPageInsights',
  DATE_RANGE: 'DateRange'
};
/**
 * Enum to indicate column indices in the mapping sheet.
 * @enum {number}
 */
const CustomerColumnMap = {
  INCLUDE: 0,
  CUSTOMER_ID: 1,
  CUSTOMER_NAME: 2,
  LAST_PROCESSED: 3,
  EXECUTION_STATS: 5,
  EXECUTION_STATS_DATA: 6,
};
/**
 * Enum to indicate column indices in the mapping sheet.
 * @enum {number}
 */
const CustomerRowMap = {
  MAX_ACCOUNTS: 0,
  AVERAGE_DURATION: 1,
  START_DATE: 5,
  END_DATE: 6,
};
const ALL_MATCH_TYPES = [
  'AI_MAX',
  'BROAD',
  'EXACT',
  'NEAR_EXACT',
  'NEAR_PHRASE',
  'PHRASE',
];
const DATE_FORMAT = 'yyyy-MM-dd';
const TEMPLATE_SPREADSHEET_ID = '1qN2Lyeiv2wpH111d1V-aqdRI6p52vowewxuVhz1PB9M';
/**
 * ============================================================================
 * DYNAMIC START AND END DATE CALCULATION FOR GAQL QUERIES
 * ============================================================================
 * Derives the date window (`startDate` and `endDate`) in 'YYYY-MM-DD' format
 * based on RunConfig (Mode A: Lookback vs Mode B: Explicit), enforcing the
 * 180-day strict safety cap. Both variables are injected into GaqlQueries.
 */
const nowObj = new Date();
let derivedEndDateStr;
let derivedStartDateStr;
if (RunConfig.USE_EXPLICIT_DATES) {
  // Mode B: Explicit Dates. Duration calculations are skipped, endDate is NOT defaulted to today.
  derivedEndDateStr = RunConfig.END_DATE;
  derivedStartDateStr = RunConfig.START_DATE;
} else {
  // Mode A: Lookback Duration (default to 30 days). Start date becomes endDate - X days.
  const lookbackDays = (typeof RunConfig.LOOKBACK_DAYS === 'number') ? RunConfig.LOOKBACK_DAYS : 30;
  derivedEndDateStr = Utilities.formatDate(nowObj, Config.TIME_ZONE, DATE_FORMAT);
  const endParts = derivedEndDateStr.split('-').map(Number);
  const startObj = new Date(Date.UTC(endParts[0], endParts[1] - 1, endParts[2], 12, 0, 0));
  startObj.setUTCDate(startObj.getUTCDate() - lookbackDays);
  derivedStartDateStr = startObj.toISOString().slice(0, 10);
}
// Validation & Strict Safety Cap (180 days max duration)
const startParts = derivedStartDateStr.split('-').map(Number);
const endParts = derivedEndDateStr.split('-').map(Number);
const startUtc = Date.UTC(startParts[0], startParts[1] - 1, startParts[2], 12, 0, 0);
const endUtc = Date.UTC(endParts[0], endParts[1] - 1, endParts[2], 12, 0, 0);
const durationDays = Math.round((endUtc - startUtc) / (1000 * 60 * 60 * 24));
if (durationDays > 180) {
  const warningMsg = `[WARNING] Configured date range duration (${durationDays} days) exceeds the strict safety cap of 180 days. Automatically forcing startDate to exactly 180 days prior to endDate.`;
  console.warn(warningMsg);
  if (typeof Logger !== 'undefined' && Logger.log) {
    Logger.log(warningMsg);
  }
  const correctedStartObj = new Date(endUtc);
  correctedStartObj.setUTCDate(correctedStartObj.getUTCDate() - 180);
  derivedStartDateStr = correctedStartObj.toISOString().slice(0, 10);
}
const endDate = derivedEndDateStr;
const startDate = derivedStartDateStr;
/**
 * Map contain the GAQL queries and the output sheetnames.
 */
const GaqlQueries = {
  'TimeSeriesCampaign': {
    'headers': [
        'Account',
        'Segments Date',
        'Campaign',
        'STM enabled',
        'Metrics Clicks',
        'Metrics Impressions',
        'Metrics Conversions',
        'Metrics Cost',
        'Metrics Conversions Value',
        'AI Max Clicks',
        'AI Max Impressions',
        'AI Max Conversions',
        'AI Max Cost',
        'AI Max Conversions Value',
        'AI Max Keyword Clicks',
        'AI Max Keyword Impressions',
        'AI Max Keyword Conversions',
        'AI Max Keyword Cost',
        'AI Max Keyword Conversions Value',
        'AI Max Landing Page Clicks',
        'AI Max Landing Page Impressions',
        'AI Max Landing Page Conversions',
        'AI Max Landing Page Cost',
        'AI Max Landing Page Conversions Value',
    ],
    'queries': [
      `SELECT
          customer.descriptive_name,
          customer.id,
          segments.date,
          campaign.name,
          campaign.id,
          metrics.clicks,
          metrics.impressions,
          metrics.conversions,
          metrics.cost_micros,
          metrics.conversions_value,
          campaign.ai_max_setting.enable_ai_max,
          campaign.asset_automation_settings
        FROM campaign
        WHERE campaign.advertising_channel_type = 'SEARCH'
          AND segments.date >= '${startDate}'
          AND segments.date <= '${endDate}'
          AND metrics.impressions >= ${RunConfig.TIME_SERIES_CAMPAIGN_IMPRESSIONS_THRESHOLD}`,
      `SELECT
          customer.descriptive_name,
          customer.id,
          campaign.name,
          campaign.id,
          segments.match_type,
          segments.date,
          metrics.impressions,
          metrics.clicks,
          metrics.conversions,
          metrics.cost_micros,
          metrics.conversions_value
        FROM keyword_view
        WHERE campaign.advertising_channel_type = 'SEARCH'
          AND metrics.impressions >= ${RunConfig.TIME_SERIES_CAMPAIGN_IMPRESSIONS_THRESHOLD}
          AND segments.date >= '${startDate}'
          AND segments.date <= '${endDate}'
          AND segments.match_type = 'AI_MAX'`,
      `SELECT
        customer.descriptive_name,
        customer.id,
        campaign.name,
        campaign.id,
        segments.date,
        targeting_expansion_view.resource_name,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions,
        metrics.cost_micros,
        metrics.conversions_value
      FROM targeting_expansion_view
      WHERE
        campaign.advertising_channel_type = 'SEARCH'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        AND metrics.impressions >= ${RunConfig.TIME_SERIES_CAMPAIGN_IMPRESSIONS_THRESHOLD}`
      ],
  },
  'GeneratedView': {
    'headers': [
      'Account',
      'Segments Date',
      'Campaign',
      'Ad Group Name',
      'Impressions',
      'Cost ($)',
      'Clicks',
      'Conversions',
      'Conversions Value ($)',
      'CTR (%)',
      'Average CPC ($)',
      'Cost Per Conversion ($)',
      'ROAS',
      'Asset Text',
      'Field Type',
      'Classification'
    ],
    'queries': [
      `SELECT
        customer.descriptive_name,
        customer.id,
        segments.date,
        campaign.name,
        campaign.id,
        ad_group.name,
        metrics.impressions,
        metrics.cost_micros,
        metrics.clicks,
        metrics.conversions,
        metrics.conversions_value,
        metrics.ctr,
        metrics.average_cpc,
        metrics.cost_per_conversion,
        metrics.conversions_value_per_cost,
        asset.text_asset.text,
        ad_group_ad_asset_view.field_type
      FROM ad_group_ad_asset_view
      WHERE ad_group_ad_asset_view.source = 'AUTOMATICALLY_CREATED'
        AND campaign.ai_max_setting.enable_ai_max = TRUE
        AND ad_group_ad_asset_view.enabled = TRUE
        AND asset.text_asset.text IS NOT NULL
        AND metrics.impressions >= ${RunConfig.GENERATED_VIEW_IMPRESSIONS_THRESHOLD}
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        ORDER BY metrics.cost_micros DESC
                LIMIT 500`,
      `SELECT
        customer.id,
        asset.text_asset.text,
        ad_group_ad_asset_view.field_type
      FROM ad_group_ad_asset_view
      WHERE ad_group_ad_asset_view.source = 'ADVERTISER'
        AND ad_group_ad_asset_view.field_type IN ('HEADLINE', 'DESCRIPTION')
        AND asset.text_asset.text IS NOT NULL`
    ],
  },
  'SearchTermsOverview': {
    'headers': [
      'MCC ID',
      'Account',
      'Segments Date',
      'Campaign',
      'STM enabled',
      'Search Term',
      'Impressions',
      'AI_MAX Clicks',
      'AI_MAX Cost',
      'AI_MAX Conversions',
      'AI_MAX Conversions Value',
      'AI_MAX Impressions',
      'BROAD Clicks',
      'BROAD Cost',
      'BROAD Conversions',
      'BROAD Conversions Value',
      'BROAD Impressions',
      'EXACT Clicks',
      'EXACT Cost',
      'EXACT Conversions',
      'EXACT Conversions Value',
      'EXACT Impressions',
      'NEAR_EXACT Clicks',
      'NEAR_EXACT Cost',
      'NEAR_EXACT Conversions',
      'NEAR_EXACT Conversions Value',
      'NEAR_EXACT Impressions',
      'NEAR_PHRASE Clicks',
      'NEAR_PHRASE Cost',
      'NEAR_PHRASE Conversions',
      'NEAR_PHRASE Conversions Value',
      'NEAR_PHRASE Impressions',
      'PHRASE Clicks',
      'PHRASE Cost',
      'PHRASE Conversions',
      'PHRASE Conversions Value',
      'PHRASE Impressions'
    ],
    'queries': [`SELECT
        segments.date,
        customer.descriptive_name,
        customer.id,
        campaign.name,
        campaign.id,
        campaign.ai_max_setting.enable_ai_max,
        campaign_search_term_view.search_term,
        segments.search_term_match_type,
        metrics.clicks,
        metrics.impressions,
        metrics.cost_micros,
        metrics.conversions_value,
        metrics.conversions
      FROM campaign_search_term_view
      WHERE campaign.advertising_channel_type = 'SEARCH'
        AND campaign.status = 'ENABLED'
        AND metrics.clicks > 0
        AND metrics.impressions >= ${RunConfig.SEARCH_TERMS_OVERVIEW_IMPRESSIONS_THRESHOLD}
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'`],
  },
  'ShoppingSearchTermsOverview': {
    'headers': [
      'MCC ID',
      'Account',
      'Campaign',
      'Ad group',
      'STM enabled',
      'Search Term',
      'Match Type',
      'Clicks',
      'Cost',
      'Conversions',
      'Conversions Value',
      'Impressions'
    ],
    'queries': [`SELECT
        customer.descriptive_name,
        customer.id,
        campaign.name,
        campaign.id,
        campaign.ai_max_setting.enable_ai_max,
        campaign_search_term_view.search_term,
        segments.search_term_match_type,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions_value,
        metrics.conversions,
        metrics.impressions,
        ad_group.id,
        ad_group.name
      FROM campaign_search_term_view
      WHERE campaign.advertising_channel_type = 'SHOPPING'
        AND campaign.status = 'ENABLED'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        AND metrics.impressions > ${RunConfig.SHOPPING_SEARCH_TERMS_OVERVIEW_IMPRESSIONS_THRESHOLD}
        AND metrics.cost_micros > 0
      ORDER BY metrics.cost_micros DESC
      LIMIT 10000`],
  },
  'SearchTermxAdCombinationView': {
    'headers': [
      'Account',
      'Campaign',
      'Search Term',
      'Headline',
      'Landing Page',
      'Impressions',
      'Clicks',
      'Cost',
      'Conversions',
      'Conversions Value'
    ],
    'queries' :[
      `SELECT
        customer.id,
        customer.descriptive_name,
        campaign.id,
        campaign.name,
        ai_max_search_term_ad_combination_view.search_term,
        ai_max_search_term_ad_combination_view.headline,
        ai_max_search_term_ad_combination_view.landing_page,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value
      FROM ai_max_search_term_ad_combination_view
      WHERE campaign.advertising_channel_type = 'SEARCH'
        AND campaign.ai_max_setting.enable_ai_max = TRUE
        AND metrics.impressions >= ${RunConfig.SEARCH_TERMS_AND_COMBINATIONS_IMPRESSIONS_THRESHOLD}
        AND metrics.conversions > 0
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
      ORDER BY campaign.id ASC, metrics.impressions DESC`
    ]
  },
  'LandingPageInsights': {
    'headers': [
      'Account',
      'Expanded URL',
      'Unexpanded URL',
      'Campaign',
      'Source',
      'Impressions',
      'Clicks',
      'Cost',
      'Conversions',
      'Conversion Value',
      'Cost Per Conversion',
      'Conversion Value Per Cost'
    ],
    'queries': [
      `SELECT
        customer.descriptive_name,
        customer.id,
        expanded_landing_page_view.expanded_final_url,
        landing_page_view.unexpanded_final_url,
        campaign.id,
        campaign.name,
        campaign.advertising_channel_type,
        campaign.status,
        segments.landing_page_source,
        metrics.impressions,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value,
        metrics.cost_per_conversion,
        metrics.conversions_value_per_cost
      FROM expanded_landing_page_view
      WHERE campaign.advertising_channel_type = 'SEARCH'
        AND campaign.status = 'ENABLED'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        AND metrics.impressions >= ${RunConfig.LANDING_PAGE_INSIGHTS_IMPRESSIONS_THRESHOLD}
        AND metrics.conversions > 0
      ORDER BY campaign.id ASC, metrics.impressions DESC`
    ]
  },
  'ShoppingSearchTermsMetrics': {
    'headers': [
      'Account',
      'Match Type',
      'Clicks',
      'Cost',
      'Conversions',
      'Conversions Value',
      'Impressions',
      'STM enabled',
      'Campaign',
      'Ad group'
    ],
    'queries': [`SELECT
        customer.descriptive_name,
        customer.id,
        segments.search_term_match_type,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions,
        metrics.conversions_value,
        metrics.impressions,
        campaign.ai_max_setting.enable_ai_max,
        campaign.name,
        campaign.id,
        ad_group.name,
        ad_group.id,
        campaign.advertising_channel_type,
        campaign.status
      FROM campaign_search_term_view
      WHERE campaign.advertising_channel_type = 'SHOPPING'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        AND metrics.impressions > ${RunConfig.SHOPPING_SEARCH_TERMS_METRICS_IMPRESSIONS_THRESHOLD}
        AND metrics.clicks > ${RunConfig.SHOPPING_SEARCH_TERMS_METRICS_CLICKS_THRESHOLD}`],
  },
  'KeywordsView': {
    'headers': [
      'Account',
      'Campaign',
      'Keyword Clicks',
      'AI Max Keyword Clicks',
      'Targeting Expansion Clicks',
      'Keyword Cost',
      'AI Max Keyword Cost',
      'Targeting Expansion Cost',
      'Keyword Conversions',
      'AI Max Keyword Conversions',
      'Targeting Expansion Conversions',
      'Keyword Conversions Value',
      'AI Max Keyword Conversions Value',
      'Targeting Expansion Conversions Value',
    ],
    'queries': [
      `SELECT
        customer.descriptive_name,
        customer.id,
        campaign.id,
        campaign.name,
        metrics.clicks,
        metrics.cost_micros,
        metrics.conversions_value,
        metrics.conversions,
        segments.match_type
      FROM keyword_view
      WHERE campaign.advertising_channel_type = 'SEARCH'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        AND campaign.ai_max_setting.enable_ai_max = TRUE
        AND metrics.impressions >= ${RunConfig.KEYWORDS_VIEW_IMPRESSIONS_THRESHOLD}`,
      `SELECT
        campaign.id,
        campaign.name,
        customer.descriptive_name,
        customer.id,
        segments.date,
        metrics.clicks,
        metrics.conversions,
        metrics.cost_micros,
        metrics.conversions_value
      FROM targeting_expansion_view
      WHERE campaign.ai_max_setting.enable_ai_max = TRUE
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        AND campaign.advertising_channel_type = 'SEARCH'
        AND metrics.impressions >= ${RunConfig.KEYWORDS_VIEW_IMPRESSIONS_THRESHOLD}`
    ],
  },
  'AIMaxFeatureAdoption': {
    'headers': [
      'Account',
      'Currency Code',
      'Campaign',
      'Search Spend (Local)',
      'Search Spend ($)',
      'STM enabled',
      'AI Max TC enabled', //AI Max Text Customization Enabled
      'AI Max FUE enabled', //AI Max Final URL Expansion Enabled
      'Segments Date',
      'Currency Count',
      'Run Date'
    ],
    'queries': [`SELECT
        customer.descriptive_name,
        customer.id,
        customer.currency_code,
        campaign.name,
        campaign.id,
        metrics.cost_micros,
        campaign.ai_max_setting.enable_ai_max,
        campaign.asset_automation_settings,
        segments.date
      FROM campaign
      WHERE campaign.advertising_channel_type = 'SEARCH'
        AND campaign.status = 'ENABLED'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'`],
  },
  'TopOpportunities': {
    'headers': [
      'Account',
      'Campaign',
      'Past 7d Conversions',
      'Estimated Incremental Conversion Uplift',
      'Past 7d Conversion Value',
      'Estimated Incremental Conversion Value Uplift',
      'Segment Date'
    ],
    'queries': [`SELECT
        customer.descriptive_name,
        customer.id,
        campaign.name,
        campaign.id,
        metrics.conversions,
        metrics.conversions_value,
        segments.date
      FROM campaign
      WHERE campaign.advertising_channel_type = 'SEARCH'
        AND campaign.status = 'ENABLED'
        AND campaign.ai_max_setting.enable_ai_max != TRUE
        AND metrics.conversions > 0
        AND segments.date DURING LAST_7_DAYS`],
  },
  'AIMaxFeatureAdoptionShopping': {
    'headers': [
      'Account',
      'Currency Code',
      'Campaign',
      'Shopping spend (Local)',
      'Shopping spend ($)',
      'Is AI Max Enabled',
      'Is TC Enabled',
      'Is FUE Enabled',
      'Has Brand Exclusions',
      'Has URL Exclusions',
      'Has Text Term Exclusions',
      'Has Messaging Guidelines',
      'Currency Count',
      'Run Date'
    ],
    'queries': [
      `SELECT
        customer.descriptive_name,
        customer.id,
        customer.currency_code,
        campaign.id,
        campaign.name,
        metrics.cost_micros,
        campaign.ai_max_setting.enable_ai_max,
        campaign.asset_automation_settings,
        campaign.text_guidelines.term_exclusions,
        campaign.text_guidelines.messaging_restrictions,
        campaign.shopping_setting.ignore_brand_exclusion_in_shopping_ads
      FROM campaign
      WHERE campaign.advertising_channel_type = 'SHOPPING'
        AND campaign.status = 'ENABLED'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'`,
      `SELECT
        campaign.id,
        campaign_criterion.type,
        campaign_criterion.negative
      FROM campaign_criterion
      WHERE campaign.advertising_channel_type = 'SHOPPING'
        AND campaign.status = 'ENABLED'
        AND campaign_criterion.status != 'REMOVED'
        AND campaign_criterion.type IN ('BRAND_LIST', 'WEBPAGE', 'WEBPAGE_LIST')`
    ],
  },
  'AIMaxFeatureAdoptionShoppingGraph': {
    'headers': [
      'Account',
      'Currency Code',
      'Campaign',
      'Shopping spend (Local)',
      'Shopping spend ($)',
      'Is AI Max Enabled',
      'Is TC Enabled',
      'Is FUE Enabled',
      'Has Brand Exclusions',
      'Has URL Exclusions',
      'Has Text Term Exclusions',
      'Has Messaging Guidelines',
      'Segments Date',
      'Run Date'
    ],
    'queries': [
      `SELECT
        customer.descriptive_name,
        customer.id,
        customer.currency_code,
        campaign.id,
        campaign.name,
        metrics.cost_micros,
        campaign.ai_max_setting.enable_ai_max,
        campaign.asset_automation_settings,
        campaign.text_guidelines.term_exclusions,
        campaign.text_guidelines.messaging_restrictions,
        campaign.shopping_setting.ignore_brand_exclusion_in_shopping_ads,
        segments.date
      FROM campaign
      WHERE campaign.advertising_channel_type = 'SHOPPING'
        AND campaign.status = 'ENABLED'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'`,
      `SELECT
        campaign.id,
        campaign_criterion.type,
        campaign_criterion.negative
      FROM campaign_criterion
      WHERE campaign.advertising_channel_type = 'SHOPPING'
        AND campaign.status = 'ENABLED'
        AND campaign_criterion.status != 'REMOVED'
        AND campaign_criterion.type IN ('BRAND_LIST', 'WEBPAGE', 'WEBPAGE_LIST')`
    ],
  },
  'AIMaxShoppingTimeSeries' : {
    'headers': [
        'Account',
        'Segments Date',
        'Campaign',
        'STM enabled',
        'Metrics Clicks',
        'Metrics Impressions',
        'Metrics Conversions',
        'Metrics Cost',
        'Metrics Conversions Value',
        'Metrics ROAS',
        'AI Max Clicks',
        'AI Max Impressions',
        'AI Max Conversions',
        'AI Max Cost',
        'AI Max Conversions Value',
        'AI Max ROAS',
        'AI Max Keyword Clicks',
        'AI Max Keyword Impressions',
        'AI Max Keyword Conversions',
        'AI Max Keyword Cost',
        'AI Max Keyword Conversions Value',
        'AI Max Keyword ROAS',
        'AI Max Landing Page Clicks',
        'AI Max Landing Page Impressions',
        'AI Max Landing Page Conversions',
        'AI Max Landing Page Cost',
        'AI Max Landing Page Conversions Value',
        'AI Max Landing Page ROAS'
    ],
    'queries' : [
      `SELECT
        customer.descriptive_name,
        customer.id,
        segments.date,
        campaign.name,
        campaign.id,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions,
        metrics.cost_micros,
        metrics.conversions_value,
        campaign.ai_max_setting.enable_ai_max,
        campaign.asset_automation_settings
      FROM campaign
      WHERE campaign.advertising_channel_type = 'SHOPPING'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        AND metrics.impressions >= ${RunConfig.AI_MAX_SHOPPING_TIME_SERIES_IMPRESSIONS_THRESHOLD}`,
      `SELECT
          customer.descriptive_name,
          customer.id,
          campaign.name,
          campaign.id,
          segments.match_type,
          segments.date,
          metrics.impressions,
          metrics.clicks,
          metrics.conversions,
          metrics.cost_micros,
          metrics.conversions_value,
          metrics.conversions_value_per_cost
        FROM keyword_view
        WHERE campaign.advertising_channel_type = 'SHOPPING'
          AND metrics.impressions >= ${RunConfig.AI_MAX_SHOPPING_TIME_SERIES_IMPRESSIONS_THRESHOLD}
          AND segments.date >= '${startDate}'
          AND segments.date <= '${endDate}'
          AND segments.match_type = 'AI_MAX'`,
      `SELECT
        customer.descriptive_name,
        customer.id,
        campaign.name,
        campaign.id,
        segments.date,
        targeting_expansion_view.resource_name,
        metrics.clicks,
        metrics.impressions,
        metrics.conversions,
        metrics.cost_micros,
        metrics.conversions_value,
        metrics.conversions_value_per_cost
      FROM targeting_expansion_view
      WHERE
        campaign.advertising_channel_type = 'SHOPPING'
        AND segments.date >= '${startDate}'
        AND segments.date <= '${endDate}'
        AND metrics.impressions >= ${RunConfig.AI_MAX_SHOPPING_TIME_SERIES_IMPRESSIONS_THRESHOLD}`
    ],
  },
  'ShoppingBestPracticesAdoption': {
    'headers': [
      'MCC ID',
      'Account',
      'Campaign',
      'AI Max Enabled',
      'Bidding Strategy',
      'Asset Automation Settings',
      'Bidding Strategy System Status',
      'Primary Status Reasons',
      'tROAS Value',
      'Maximize Conversion Value Target ROAS',
      'Standard Target ROAS',
      'Bidding Strategy Flag',
      'FUE Opt In Flag',
      'Limited by budget Flag',
      'Has Shopping Campaigns'
    ],
    'queries': [`SELECT
        customer.descriptive_name,
        customer.id,
        campaign.id,
        campaign.name,
        campaign.ai_max_setting.enable_ai_max,
        campaign.bidding_strategy_type,
        campaign.maximize_conversion_value.target_roas,
        campaign.target_roas.target_roas,
        campaign.asset_automation_settings,
        campaign.bidding_strategy_system_status,
        campaign.primary_status_reasons
      FROM campaign
      WHERE campaign.advertising_channel_type = 'SHOPPING'
        AND campaign.status = 'ENABLED'`]
  },
};
/**
 * Main function to process customer accounts, query Google Ads data,
 * and update the Google Sheet.
 * @return {void}
 */
function main() {
  console.log('STARTING AI MAXIMA EXECUTION.');
  const scriptProperties = PropertiesService.getScriptProperties();
  let spreadsheetUrl = scriptProperties.getProperty('aiMaximaSpreadsheetUrl');
  if(!spreadsheetUrl){
    spreadsheetUrl = copySpreadsheetTemplate(TEMPLATE_SPREADSHEET_ID, scriptProperties);
  } else {
    console.log(`Output written to sheet: ${spreadsheetUrl}`);
  }
  const spreadsheet = SpreadsheetApp.openByUrl(spreadsheetUrl);
  const range = spreadsheet.getRange(Config.CUSTOMERS_SHEET_RANGE);
  const customerSheetValues = range.getValues();
  const dateString =
      Utilities.formatDate(new Date(), Config.TIME_ZONE, DATE_FORMAT);
  console.log(`[RunConfig Diagnostic] Effective Date Range: ${startDate} to ${endDate}`);
  console.log(`[RunConfig Diagnostic] Campaign Filter Mode: ${RunConfig.CAMPAIGN_FILTER_MODE}`);
  const filterModeUppercase = RunConfig.CAMPAIGN_FILTER_MODE ? String(RunConfig.CAMPAIGN_FILTER_MODE).toUpperCase() : 'ALL';
  if (typeof AdsManagerApp !== 'undefined') {
    const mcc = AdsApp.currentAccount().getCustomerId();
    console.log(`This script is running in an MCC (Manager Account). MCC Customer ID: '${mcc}'`);
    // Track adoption immediately before processing, even if no accounts need processing today
    const mccCampaignsCount = getTelemetryCampaignsCount();
    trackAdoption('MCC', mcc, spreadsheet, RunConfig.TELEMETRY_OPT_OUT, mccCampaignsCount);
    let accountSelection;
    if (filterModeUppercase === 'CUSTOM') {
      console.log('[CUSTOM Mode] Bypassing manual Trix INCLUDE checkboxes. Performing security validation against CUSTOM_CAMPAIGN_MAP...');
      accountSelection = getCustomAccountsToProcess(customerSheetValues, dateString, spreadsheet);
      if (!accountSelection) {
        console.error('[Terminating Error] CUSTOM mode security validation failed or no valid child accounts found in CUSTOM_CAMPAIGN_MAP. Exiting execution early.');
        return;
      }
    } else {
      accountSelection = getAccountsToProcess(customerSheetValues, dateString, spreadsheet);
    }
    const {accountsToProcess, indexes, allAccountsInSheet, includedAccounts} = accountSelection;
    if (includedAccounts === accountsToProcess.length) {
      Logger.log(`All accounts will be processed, do clearAllSheetsContent.`);
      clearAllSheetsContent(spreadsheet);
    } else {
      Logger.log(
          `allAccountsInSheet ${allAccountsInSheet.length} vs` +
          ` accountsToProcess: ${accountsToProcess.length}`);
    }
    if (allAccountsInSheet.length === 0) {
      console.log(
          'Written Customer IDs to sheet, please select the customers ' +
          'to include and execute again.');
      console.log('FINISHED AI MAXIMA EXECUTION.');
      return;
    }
    if (accountsToProcess.length > 0) {
      const mcc = AdsApp.currentAccount().getCustomerId();
      console.log(
          `This script is running in an MCC (Manager Account).` +
          ` MCC Customer ID: '${mcc}'`);
      processManagerAccounts(accountsToProcess, indexes, customerSheetValues,
                             range, dateString, startDate, endDate, mcc,
                             spreadsheet);
    } else {
      console.log('No accounts need processing at this time.');
    }
  } else {
    const account = AdsApp.currentAccount();
    console.log('This script is running in a single Client Account (CID).');
    console.log('Account Customer ID: ' + account.getCustomerId());
    if (filterModeUppercase === 'CUSTOM') {
      const validSingle = validateSingleAccountCustomMap(account);
      if (!validSingle) {
        console.error('[Terminating Error] In CUSTOM filter mode, none of the mapped Customer IDs in CUSTOM_CAMPAIGN_MAP match this Single Client Account. Terminating execution early.');
        return;
      }
    }
    // Track adoption immediately before processing
    const singleCampaignsCount = getTelemetryCampaignsCount(account);
    trackAdoption('Single_CID', account.getCustomerId(), spreadsheet, RunConfig.TELEMETRY_OPT_OUT, singleCampaignsCount);
    processSingleAccount(account, customerSheetValues, range, dateString,
      startDate, endDate, spreadsheet);
  }
  const propertyKey = RunConfig.SEARCH_TABS_ONLY ? 'lookerStudioUrlSearchOnly' : 'lookerStudioUrl';
  const storedUrl = scriptProperties.getProperty(propertyKey);
  let url = '';
  if (storedUrl) {
    console.log(`\n⬇️ --- Looker Studio Dashboard URL (${RunConfig.SEARCH_TABS_ONLY ? 'Search-Only' : 'All Tabs'}) has already been generated, use this URL to generate a NEW dashboard --- ⬇️`);
    console.log(storedUrl);
    console.log("--------------------------------------------\n");
  } else {
    url = generateLookerStudioUrl(spreadsheet);
    scriptProperties.setProperty(propertyKey, url);
    console.log(`\n⬇️ --- AUTO-GENERATE LOOKER STUDIO DASHBOARD URL (${RunConfig.SEARCH_TABS_ONLY ? 'Search-Only' : 'All Tabs'}) --- ⬇️`);
    console.log(url);
    console.log("--------------------------------------------\n");
  }
  console.log('FINISHED AI MAXIMA EXECUTION.');
  updateDateRangeSheet(spreadsheet, startDate, endDate, customerSheetValues);
}
/**
 * Retrieves and filters accounts from the Customer sheet to determine which
 * ones to process. If the sheet is empty, it populates it with all child
 * accounts under the MCC.
 * @param {!Array<!Array<string>>} customerSheetValues The values from the
 * Customers sheet.
 * @param {string} dateString The current date in 'yyyy-MM-dd' format.
 * @param {!SpreadsheetApp.Spreadsheet} spreadsheet The Google Spreadsheet
 * object.
 * @return {{
 *  accountsToProcess: !Array<string>,
 *  indexes: !Object<string, number>,
 *  allAccountsInSheet: !Array<string>,
 *  includedAccounts: number}} An object containing arrays of
 * accounts to process and their indexes.
 */
/**
 * Automatically validates CUSTOM_CAMPAIGN_MAP Customer IDs against the running
 * MCC, bypassing the requirement for manual checkboxes in the Customers sheet.
 * Logs security violations for non-child CIDs and syncs validated accounts
 * to the Customers sheet as active/included for Looker reporting.
 *
 * @param {!Array<!Array<string>>} customerSheetValues The values from the Customers sheet.
 * @param {string} dateString Current date in 'yyyy-MM-dd' format.
 * @param {!SpreadsheetApp.Spreadsheet} spreadsheet The Spreadsheet object.
 * @return {?{
 *  accountsToProcess: !Array<string>,
 *  indexes: !Object<string, number>,
 *  allAccountsInSheet: !Array<string>,
 *  includedAccounts: number}} Validation result or null if terminating error.
 */
function getCustomAccountsToProcess(customerSheetValues, dateString, spreadsheet) {
  const customMap = RunConfig.CUSTOM_CAMPAIGN_MAP || {};
  const rawKeys = Object.keys(customMap);
  if (rawKeys.length === 0) {
    console.error("[Terminating Error] RunConfig.CAMPAIGN_FILTER_MODE is 'CUSTOM', but CUSTOM_CAMPAIGN_MAP is empty. Terminating early.");
    return null;
  }
  // Normalize requested keys to clean 10-digit CIDs without hyphens
  const cleanToRawMap = {};
  const requestedCleanIds = [];
  for (const rawKey of rawKeys) {
    const cleanId = String(rawKey).replace(/-/g, '').trim();
    if (cleanId && !isNaN(Number(cleanId))) {
      cleanToRawMap[cleanId] = rawKey;
      requestedCleanIds.push(cleanId);
    }
  }
  if (requestedCleanIds.length === 0) {
    console.error("[Terminating Error] No valid numeric Customer IDs found in CUSTOM_CAMPAIGN_MAP. Terminating early.");
    return null;
  }
  // Security Checker Integration: Validate that requested CIDs are managed child accounts of this MCC
  const validatedAccountsMap = {};
  const accountIterator = AdsManagerApp.accounts().withIds(requestedCleanIds).get();
  while (accountIterator.hasNext()) {
    const childAcc = accountIterator.next();
    const childCleanId = childAcc.getCustomerId().replace(/-/g, '');
    validatedAccountsMap[childCleanId] = childAcc;
  }
  const validatedCleanIds = [];
  for (const cleanId of requestedCleanIds) {
    if (!validatedAccountsMap[cleanId]) {
      console.error(`[Security Violation / Invalid] Requested Customer ID '${cleanToRawMap[cleanId]}' (${cleanId}) is not managed by this MCC. Excluding from processing.`);
    } else {
      validatedCleanIds.push(cleanId);
    }
  }
  // Proper Cleanup and Errors: If none of the accounts in the custom map are valid, terminate early
  if (validatedCleanIds.length === 0) {
    console.error("[Terminating Error] None of the Customer IDs in CUSTOM_CAMPAIGN_MAP are valid managed child accounts for this running MCC. Terminating execution early to save runtime/quota.");
    return null;
  }
  console.log(`[CUSTOM Validation] Successfully validated ${validatedCleanIds.length} managed child account(s): [${validatedCleanIds.join(', ')}]`);
  // Bypass Trix 'Include' & Custom Synchronization:
  // Synchronize validated accounts with customerSheetValues so Looker reporting stays consistent.
  const existingSheetIndexMap = {};
  for (let i = 0; i < customerSheetValues.length; i++) {
    const rowCid = String(customerSheetValues[i][CustomerColumnMap.CUSTOMER_ID] || '').replace(/-/g, '').trim();
    if (rowCid) {
      existingSheetIndexMap[rowCid] = i;
    }
  }
  const accountsToProcess = [];
  const indexes = {};
  for (const cleanId of validatedCleanIds) {
    const accObj = validatedAccountsMap[cleanId];
    let rowIndex = existingSheetIndexMap[cleanId];
    if (rowIndex !== undefined) {
      // Account exists in Customers sheet: automatically set INCLUDE = true
      customerSheetValues[rowIndex][CustomerColumnMap.INCLUDE] = true;
      let accName = '';
      if (accObj) {
        if (typeof accObj.getName === 'function') {
          accName = accObj.getName();
        } else if (typeof accObj.getDescriptiveName === 'function') {
          accName = accObj.getDescriptiveName();
        }
      }
      const existingValue = customerSheetValues[rowIndex][CustomerColumnMap.CUSTOMER_NAME];
      let namePart = '';
      if (existingValue) {
        const parts = existingValue.split(' - ');
        if (parts.length >= 2 && parts[parts.length - 1] === cleanId) {
          namePart = parts.slice(0, -1).join(' - ');
        } else if (existingValue !== cleanId && !existingValue.includes(cleanId + ' - ' + cleanId)) {
          namePart = existingValue;
        }
      }
      if (namePart === cleanId) {
        namePart = '';
      }
      const finalName = accName || namePart;
      customerSheetValues[rowIndex][CustomerColumnMap.CUSTOMER_NAME] = finalName || cleanId;
      indexes[cleanId] = rowIndex;
      const lastProcessedDate = Utilities.formatDate(
          new Date(customerSheetValues[rowIndex][CustomerColumnMap.LAST_PROCESSED] || 0),
          Config.TIME_ZONE,
          DATE_FORMAT);
      if (lastProcessedDate !== dateString) {
        accountsToProcess.push(cleanId);
      } else {
        console.log(`Account '${cleanId}' was already processed today.`);
      }
    } else {
      // Account not present in Customers sheet: append new synchronized row
      const newRow = new Array(Math.max(customerSheetValues[0] ? customerSheetValues[0].length : 7, 7)).fill('');
      newRow[CustomerColumnMap.INCLUDE] = true;
      newRow[CustomerColumnMap.CUSTOMER_ID] = cleanId;
      let accName = '';
      if (accObj) {
        if (typeof accObj.getName === 'function') {
          accName = accObj.getName();
        } else if (typeof accObj.getDescriptiveName === 'function') {
          accName = accObj.getDescriptiveName();
        }
      }
      newRow[CustomerColumnMap.CUSTOMER_NAME] = accName || cleanId;
      newRow[CustomerColumnMap.LAST_PROCESSED] = '';
      customerSheetValues.push(newRow);
      const newIndex = customerSheetValues.length - 1;
      indexes[cleanId] = newIndex;
      accountsToProcess.push(cleanId);
    }
  }
  // Persist synchronized customerSheetValues back to Customers sheet
  const customersSheet = spreadsheet.getSheetByName(SHEETNAMES.CUSTOMERS);
  if (customersSheet && customerSheetValues.length > 0) {
    const numCols = customerSheetValues[0].length;
    customersSheet.getRange(2, 1, customerSheetValues.length, numCols).setValues(customerSheetValues);
    console.log(`[CUSTOM Mode] Synchronized ${validatedCleanIds.length} validated account(s) as active/included in '${SHEETNAMES.CUSTOMERS}' sheet.`);
  }
  return {
    accountsToProcess: accountsToProcess,
    indexes: indexes,
    allAccountsInSheet: validatedCleanIds,
    includedAccounts: validatedCleanIds.length
  };
}
/**
 * Security Checker for Single Client Account mode: validates that CUSTOM_CAMPAIGN_MAP
 * contains the current account CID and logs warnings for any cross-account CIDs.
 * @param {!AdsApp.Account} account Running Single Client Account.
 * @return {boolean} True if current account CID is mapped, false otherwise.
 */
function validateSingleAccountCustomMap(account) {
  const currentCleanId = account.getCustomerId().replace(/-/g, '');
  const customMap = RunConfig.CUSTOM_CAMPAIGN_MAP || {};
  const rawKeys = Object.keys(customMap);
  if (rawKeys.length === 0) {
    console.error("[Terminating Error] RunConfig.CAMPAIGN_FILTER_MODE is 'CUSTOM', but CUSTOM_CAMPAIGN_MAP is empty. Terminating early.");
    return false;
  }
  let hasMatch = false;
  for (const rawKey of rawKeys) {
    const cleanKey = String(rawKey).replace(/-/g, '').trim();
    if (cleanKey === currentCleanId) {
      hasMatch = true;
    } else {
      console.warn(`[Security Warning] Running in Single Client Account mode (CID: ${currentCleanId}), but CUSTOM_CAMPAIGN_MAP contains cross-account CID '${rawKey}'. Excluding from processing.`);
    }
  }
  return hasMatch;
}
/**
 * Retrieves the list of accounts to process based on the current date and
 * the inclusion status in the Customers sheet.
 * @param {!Array<!Array<string>>} customerSheetValues The values from the
 * Customers sheet.
 * @param {string} dateString The current date in 'yyyy-MM-dd' format.
 * @param {!SpreadsheetApp.Spreadsheet} spreadsheet The Spreadsheet object.
 * @return {{
 *  accountsToProcess: !Array<string>,
 *  indexes: !Object<string, number>,
 *  allAccountsInSheet: !Array<string>,
 *  includedAccounts: number}} An object containing arrays of
 * accounts to process and their indexes.
 */
function getAccountsToProcess(customerSheetValues, dateString, spreadsheet) {
  const allAccountsInSheet = [];
  const accountsToProcess = [];
  const indexes = {};
  let includedAccounts = 0;
  // Track included account IDs to fetch their real names
  const includedAccountIds = [];
  const includedIndexes = {};
  for (const [i, value] of customerSheetValues.entries()) {
    const rawAccountId = value[CustomerColumnMap.CUSTOMER_ID];
    if (rawAccountId) {
      const accountId = String(rawAccountId).replace(/-/g, '').trim();
      allAccountsInSheet.push(accountId);
      const lastProcessedDate = Utilities.formatDate(
          new Date(value[CustomerColumnMap.LAST_PROCESSED]), Config.TIME_ZONE,
          DATE_FORMAT);
      if (value[CustomerColumnMap.INCLUDE]) {
        includedAccounts += 1;
        includedAccountIds.push(accountId);
        includedIndexes[accountId] = i;
        if (lastProcessedDate !== dateString) {
          accountsToProcess.push(accountId);
          indexes[accountId] = i; // Store with clean ID for lookup
        }
      }
    }
  }
  // Update CUSTOMER_NAME for all included accounts to ensure consistency
  if (includedAccountIds.length > 0) {
    const childAccounts = AdsManagerApp.accounts().withIds(includedAccountIds).get();
    while (childAccounts.hasNext()) {
      const account = childAccounts.next();
      const accountId = account.getCustomerId().replace(/-/g, '');
      let accountName = null;
      if (account) {
        if (typeof account.getName === 'function') {
          accountName = account.getName();
        } else if (typeof account.getDescriptiveName === 'function') {
          accountName = account.getDescriptiveName();
        }
      }
      const i = includedIndexes[accountId];
      if (i !== undefined) {
        const existingValue = customerSheetValues[i][CustomerColumnMap.CUSTOMER_NAME];
        let namePart = '';
        // Try to recover name part from existing sheet value
        if (existingValue) {
          const parts = existingValue.split(' - ');
          if (parts.length >= 2 && parts[parts.length - 1] === accountId) {
            namePart = parts.slice(0, -1).join(' - ');
          } else if (existingValue !== accountId && !existingValue.includes(accountId + ' - ' + accountId)) {
            namePart = existingValue;
          }
        }
        // If namePart is just the ID (corrupted), clear it
        if (namePart === accountId) {
          namePart = '';
        }
        // Determine final name: prefer API, fallback to recovered sheet name
        const finalName = accountName || namePart;
        customerSheetValues[i][CustomerColumnMap.CUSTOMER_NAME] = finalName || accountId;
      }
    }
  }
  if (allAccountsInSheet.length === 0) {
    const childAccounts = getAllChildAccounts();
    if (childAccounts && childAccounts.length > 0) {
      spreadsheet.getSheetByName(SHEETNAMES.CUSTOMERS)
          .getRange(2, 1, childAccounts.length, 3)
          .setValues(childAccounts);
    }
  }
  return {accountsToProcess, indexes, allAccountsInSheet, includedAccounts};
}
/**
 * Processes a list of child accounts under an MCC, running GAQL queries for
 * each. Tracks execution time and stops if nearing limits.
 * @param {!Array<string>} accountsToProcess An array of customer IDs to
 * process.
 * @param {!Object<string, number>} indexes A map of customer ID to row index
 * in the sheet.
 * @param {!Array<!Array<string>>} customerSheetValues The values from the
 * Customers sheet.
 * @param {!SpreadsheetApp.Spreadsheet.sheet.range} range Spreadsheet range
 * object.
 * @param {string} dateString The current date in 'yyyy-MM-dd' format.
 * @param {string} startDate The start date for queries in 'yyyy-MM-dd'
 *format.
 * @param {string} endDate The end date for queries in 'yyyy-MM-dd'
 * format.
 * @param {string} mcc The Customer ID of the Manager Account.
 * @param {!SpreadsheetApp.spreadsheet} spreadsheet The Spreadsheet object.
 * @return {void}
 */
function processManagerAccounts(
    accountsToProcess, indexes, customerSheetValues, range, dateString,
    startDate, endDate, mcc, spreadsheet) {
  let precomputedCampaigns = null;
  if ((RunConfig.CAMPAIGN_FILTER_MODE ? String(RunConfig.CAMPAIGN_FILTER_MODE).toUpperCase() : 'ALL') === 'TOP_N') {
    precomputedCampaigns = getGlobalTopNCampaigns(accountsToProcess, startDate, endDate);
  }
  const individualTimes = [];
  let lastRemainingExecutionTime = AdsApp.getExecutionInfo().getRemainingTime();
  const totalExecutionTime =
      lastRemainingExecutionTime * Config.EXECUTION_TIME_BUFFER;
  let averageExecutionTime = 0;
  const childAccounts =
      AdsManagerApp.accounts().withIds(accountsToProcess).get();
  while (childAccounts.hasNext()) {
    if (averageExecutionTime > 0 &&
        AdsApp.getExecutionInfo().getRemainingTime() <
            averageExecutionTime * 2) {
      console.log('Stopping execution to stay within time limits.');
      break;
    }
    const account = childAccounts.next();
    const accountId = account.getCustomerId().replace(/-/g, '');
    const index = indexes[accountId];
    customerSheetValues[index][CustomerColumnMap.LAST_PROCESSED] = dateString;
    processAccountQueries(account, startDate, endDate, mcc, spreadsheet, precomputedCampaigns);
    const currentExecutionTime = AdsApp.getExecutionInfo().getRemainingTime();
    individualTimes.push(lastRemainingExecutionTime - currentExecutionTime);
    lastRemainingExecutionTime = currentExecutionTime;
    const sumOfExecutionTime = individualTimes.reduce(
        (accumulator, currentValue) => accumulator + currentValue, 0);
    averageExecutionTime = sumOfExecutionTime / individualTimes.length;
  }
  updateExecutionStats(range, customerSheetValues, averageExecutionTime,
                       totalExecutionTime);
}
/**
 * Processes a single Google Ads Account running GAQL queries.
 * @param {!AdsApp.Account} account An array of customer IDs to
 * process.
 * @param {!Array<!Array<string>>} customerSheetValues The values from the
 * Customers sheet.
 * @param {!SpreadsheetApp.Spreadsheet.sheet.range} range Spreadsheet range
 * object.
 * @param {string} dateString The current date in 'yyyy-MM-dd' format.
 * @param {string} startDate The start date for queries in 'yyyy-MM-dd'
 *format.
 * @param {string} endDate The end date for queries in 'yyyy-MM-dd'
 * format.
 * @param {!SpreadsheetApp.spreadsheet} spreadsheet The Spreadsheet object.
 * @return {void}
 */
function processSingleAccount(account, customerSheetValues, range, dateString,
    startDate, endDate, spreadsheet) {
  const index = 0;
  const lastProcessedDate = Utilities.formatDate(
        new Date(customerSheetValues[index][CustomerColumnMap.LAST_PROCESSED]),
        Config.TIME_ZONE, DATE_FORMAT);
  if (lastProcessedDate === dateString) {
    console.log(`Customer '${account.getCustomerId()}' has already ` +
      `been processed today.`);
    return;
  }
  clearAllSheetsContent(spreadsheet);
  customerSheetValues[index][CustomerColumnMap.LAST_PROCESSED] =
    dateString;
  let accountName = '';
  if (account) {
    if (typeof account.getName === 'function') {
      accountName = account.getName();
    } else if (typeof account.getDescriptiveName === 'function') {
      accountName = account.getDescriptiveName();
    }
  }
  const accountId = account.getCustomerId().replace(/-/g, '');
  const existingValue = customerSheetValues[index][CustomerColumnMap.CUSTOMER_NAME];
  let namePart = '';
  if (existingValue) {
    const parts = existingValue.split(' - ');
    if (parts.length >= 2 && parts[parts.length - 1] === accountId) {
      namePart = parts.slice(0, -1).join(' - ');
    } else if (existingValue !== accountId && !existingValue.includes(accountId + ' - ' + accountId)) {
      namePart = existingValue;
    }
  }
  if (namePart === accountId) {
    namePart = '';
  }
  const finalName = accountName || namePart;
  customerSheetValues[index][CustomerColumnMap.CUSTOMER_NAME] = finalName || accountId;
  customerSheetValues[index][CustomerColumnMap.CUSTOMER_ID] =
    account.getCustomerId().replace(/-/g, '');
  customerSheetValues[index][CustomerColumnMap.INCLUDE] = true;
  processAccountQueries(account, startDate, endDate, null, spreadsheet);
  updateExecutionStats(range, customerSheetValues);
}
/**
 * Retrieves the custom campaign IDs mapped to the current account from RunConfig.
 * Supports matching customer IDs with or without hyphens.
 * @param {!AdsApp.Account} account The Google Ads account.
 * @return {!Array<string|number>} An array of unique, valid campaign IDs.
 */
function getCustomCampaignIds(account) {
  const cidWithHyphens = account.getCustomerId();
  const cidWithoutHyphens = cidWithHyphens.replace(/-/g, '');
  const map = RunConfig.CUSTOM_CAMPAIGN_MAP || {};
  let ids = [];
  if (map[cidWithHyphens]) {
    ids = ids.concat(map[cidWithHyphens]);
  }
  if (map[cidWithoutHyphens] && cidWithoutHyphens !== cidWithHyphens) {
    ids = ids.concat(map[cidWithoutHyphens]);
  }
  return Array.from(new Set(ids.map(id => String(id).trim()))).filter(id => id && !isNaN(Number(id)));
}
/**
 * Determines whether a given sheet name corresponds to a Shopping channel report.
 * @param {string} sheetName The name of the sheet.
 * @return {boolean} True if the sheet is for Shopping campaigns, false otherwise.
 */
function isShoppingSheet(sheetName) {
  return sheetName === SHEETNAMES.SHOPPING_SEARCH_TERMS_OVERVIEW ||
         sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING ||
         sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING_GRAPH ||
         sheetName === SHEETNAMES.AI_MAX_SHOPPING_TIME_SERIES ||
         sheetName === SHEETNAMES.SHOPPING_BEST_PRACTICES_ADOPTION ||
         String(sheetName).toLowerCase().includes('shopping');
}
/**
 * Fetches campaigns from all accounts to determine the global Top N campaigns by spend.
 * @param {!Array<string>} accountsToProcess List of clean Customer IDs to process.
 * @param {string} startDate Start date in 'YYYY-MM-DD' format.
 * @param {string} endDate End date in 'YYYY-MM-DD' format.
 * @return {!Object} Mapping of clean CID to its top campaigns { CID: { SEARCH: [], SHOPPING: [] } }.
 */
function getGlobalTopNCampaigns(accountsToProcess, startDate, endDate) {
  const topN = (typeof RunConfig.TOP_N_COUNT === 'number' && RunConfig.TOP_N_COUNT > 0) ? Math.floor(RunConfig.TOP_N_COUNT) : 5;
  console.log(`[Global TOP_N] Pre-scanning campaigns to find top ${topN} by spend globally...`);
  const accounts = AdsManagerApp.accounts().withIds(accountsToProcess).get();
  const allCampaigns = [];
  while (accounts.hasNext()) {
    const account = accounts.next();
    const cid = account.getCustomerId().replace(/-/g, '');
    // Query Search Campaigns Top N for this account
    const searchTopN = getTopNCampaignIds(account, startDate, endDate, 'SEARCH');
    // Query Shopping Campaigns Top N for this account (skipped if SEARCH_TABS_ONLY is true)
    const shoppingTopN = RunConfig.SEARCH_TABS_ONLY ? [] : getTopNCampaignIds(account, startDate, endDate, 'SHOPPING');
    // Process Search
    searchTopN.forEach(c => {
      allCampaigns.push({
        accountId: cid,
        campaignId: c.id,
        channel: 'SEARCH',
        cost: c.cost
      });
    });
    // Process Shopping
    shoppingTopN.forEach(c => {
      allCampaigns.push({
        accountId: cid,
        campaignId: c.id,
        channel: 'SHOPPING',
        cost: c.cost
      });
    });
  }
  // Sort and pick top N for each channel
  const searchCampaigns = allCampaigns.filter(c => c.channel === 'SEARCH');
  const shoppingCampaigns = allCampaigns.filter(c => c.channel === 'SHOPPING');
  searchCampaigns.sort((a, b) => b.cost - a.cost);
  shoppingCampaigns.sort((a, b) => b.cost - a.cost);
  const topSearch = searchCampaigns.slice(0, topN);
  const topShopping = shoppingCampaigns.slice(0, topN);
  console.log(`[Global TOP_N Verification] Top ${topN} SEARCH campaigns globally:`);
  if (topSearch.length === 0) console.log("  None found.");
  topSearch.forEach(c => console.log(`  Account: ${c.accountId}, Campaign: ${c.campaignId}, Cost: ${c.cost}`));
  console.log(`[Global TOP_N Verification] Top ${topN} SHOPPING campaigns globally:`);
  if (topShopping.length === 0) console.log("  None found.");
  topShopping.forEach(c => console.log(`  Account: ${c.accountId}, Campaign: ${c.campaignId}, Cost: ${c.cost}`));
  const accountMapping = {};
  const addToMapping = (item) => {
    const cid = item.accountId;
    if (!accountMapping[cid]) {
      accountMapping[cid] = { SEARCH: [], SHOPPING: [] };
    }
    accountMapping[cid][item.channel].push(item.campaignId);
  };
  topSearch.forEach(addToMapping);
  topShopping.forEach(addToMapping);
  return accountMapping;
}
/**
 * Executes a preliminary GAQL query to identify the top N campaigns by spend
 * within the configured date range for the specified account and channel type.
 * @param {!AdsApp.Account} account The Google Ads account to query.
 * @param {string} startDate The start date in 'YYYY-MM-DD' format.
 * @param {string} endDate The end date in 'YYYY-MM-DD' format.
 * @param {?string=} channelType The advertising channel type ('SEARCH' or 'SHOPPING').
 * @return {!Array<string|number>} An array of campaign IDs for the top spenders.
 */
function getTopNCampaignIds(account, startDate, endDate, channelType = null) {
  const topN = (typeof RunConfig.TOP_N_COUNT === 'number' && RunConfig.TOP_N_COUNT > 0) ? Math.floor(RunConfig.TOP_N_COUNT) : 5; // Default to 5 if not set or invalid.
  const channelCondition = channelType ?
      `AND campaign.advertising_channel_type = '${channelType}'` :
      `AND campaign.advertising_channel_type IN ('SEARCH', 'SHOPPING')`;
  const prelimQuery = `SELECT
      campaign.id,
      metrics.cost_micros
    FROM campaign
    WHERE campaign.status = 'ENABLED'
      ${channelCondition}
      AND segments.date >= '${startDate}'
      AND segments.date <= '${endDate}'
    ORDER BY metrics.cost_micros DESC
    LIMIT ${topN}`;
  const rows = searchAdsApp(account, prelimQuery);
  const topCampaigns = [];
  for (const row of rows) {
    if (row && row.campaign && row.campaign.id) {
      const costStr = row.metrics ? (row.metrics.costMicros || row.metrics.cost_micros || '0') : '0';
      topCampaigns.push({
        id: row.campaign.id,
        cost: parseInt(costStr, 10)
      });
    }
  }
  const channelLabel = channelType ? `${channelType} ` : '';
  console.log(`[TOP_N Filter] Identified top ${topCampaigns.length} ${channelLabel}campaigns by spend for account ${account.getCustomerId()}`);
  return topCampaigns;
}
/**
 * Injects a campaign ID filtering clause into a GAQL query string if active
 * campaign IDs are provided (for TOP_N and CUSTOM modes).
 * @param {string} query The GAQL query string.
 * @param {?Array<string|number>=} campaignIds The list of campaign IDs to include.
 * @return {string} The modified query string with the campaign filter clause injected.
 */
function injectCampaignFilter(query, campaignIds = null) {
  if (!campaignIds || !Array.isArray(campaignIds) || campaignIds.length === 0) {
    return query;
  }
  const formattedIds = campaignIds.map(id => String(id).trim()).join(', ');
  const filterClause = ` AND campaign.id IN (${formattedIds}) `;
  // Inject at the end of the WHERE clause (before ORDER BY, LIMIT, or end of string)
  if (query.match(/ORDER\s+BY/i)) {
    return query.replace(/(ORDER\s+BY)/i, `${filterClause}\n      $1`);
  } else if (query.match(/LIMIT/i)) {
    return query.replace(/(LIMIT)/i, `${filterClause}\n      $1`);
  } else {
    return query + filterClause;
  }
}
/**
 * Cycles through all defined GAQL queries and processes each one for a given
 * Google Ads account.
 * @param {!AdsApp.Account} account The Google Ads account to query.
 * @param {string} startDate The start date for queries in 'yyyy-MM-dd' format.
 * @param {string} endDate The end date for queries in 'yyyy-MM-dd' format.
 * @param {?string} mcc The Customer ID of the Manager Account, or null if not
 *     running under an MCC.
 * @param {!SpreadsheetApp.spreadsheet} spreadsheet The Spreadsheet object.
 * @param {?Object=} precomputedCampaigns Optional precomputed global top campaigns.
 * @return {void}
 */
function processAccountQueries(account, startDate, endDate, mcc, spreadsheet, precomputedCampaigns = null) {
  let activeCampaignIds = null;
  let searchTopCampaignIds = null;
  let shoppingTopCampaignIds = null;
  const mode = RunConfig.CAMPAIGN_FILTER_MODE ? String(RunConfig.CAMPAIGN_FILTER_MODE).toUpperCase() : 'ALL';
  if (mode === 'CUSTOM') {
    activeCampaignIds = getCustomCampaignIds(account);
    if (!activeCampaignIds || activeCampaignIds.length === 0) {
      console.log(`[CUSTOM Filter] Account ${account.getCustomerId()} has no campaigns specified in CUSTOM_CAMPAIGN_MAP. Skipping query processing for this account.`);
      return;
    }
    console.log(`[CUSTOM Filter] Filtering queries for account ${account.getCustomerId()} to campaign IDs: [${activeCampaignIds.join(', ')}]`);
  } else if (mode === 'TOP_N') {
    if (precomputedCampaigns) {
      const cid = account.getCustomerId().replace(/-/g, '');
      const mapping = precomputedCampaigns[cid] || { SEARCH: [], SHOPPING: [] };
      searchTopCampaignIds = mapping.SEARCH;
      shoppingTopCampaignIds = mapping.SHOPPING;
      console.log(`[TOP_N Filter] Using precomputed global top campaigns for account ${account.getCustomerId()}: Search[${searchTopCampaignIds.join(', ')}], Shopping[${shoppingTopCampaignIds.join(', ')}]`);
    } else {
      // getTopNCampaignIds now returns objects with {id, cost}. We need just the IDs here.
      searchTopCampaignIds = getTopNCampaignIds(account, startDate, endDate, 'SEARCH').map(c => c.id);
      shoppingTopCampaignIds = RunConfig.SEARCH_TABS_ONLY ? [] : getTopNCampaignIds(account, startDate, endDate, 'SHOPPING').map(c => c.id);
    }
    const hasSearchCampaigns = searchTopCampaignIds && searchTopCampaignIds.length > 0;
    const hasShoppingCampaigns = shoppingTopCampaignIds && shoppingTopCampaignIds.length > 0;
    if (RunConfig.SEARCH_TABS_ONLY) {
      if (!hasSearchCampaigns) {
        console.log(`[TOP_N Filter (Search-Only)] No active spending SEARCH campaigns found for account ${account.getCustomerId()} in date range. Skipping query processing.`);
        return;
      }
    } else if (!hasSearchCampaigns && !hasShoppingCampaigns) {
      console.log(`[TOP_N Filter] No active spending SEARCH or SHOPPING campaigns found for account ${account.getCustomerId()} in date range. Skipping query processing.`);
      return;
    }
  }
  for (const [key, value] of Object.entries(GaqlQueries)) {
    if (RunConfig.SEARCH_TABS_ONLY && isShoppingSheet(key)) {
      console.log(`[SEARCH_TABS_ONLY] Skipping Shopping query for sheet '${key}'.`);
      continue;
    }
    let targetCampaignIds = activeCampaignIds;
    if (mode === 'TOP_N') {
      const isShopping = isShoppingSheet(key);
      targetCampaignIds = isShopping ? shoppingTopCampaignIds : searchTopCampaignIds;
      if (!targetCampaignIds || targetCampaignIds.length === 0) {
        console.log(`[TOP_N Filter] No active spending ${isShopping ? 'SHOPPING' : 'SEARCH'} campaigns found for account ${account.getCustomerId()}. Skipping query for sheet '${key}'.`);
        continue;
      }
    }
    processQuery(account, key, startDate, endDate, mcc, spreadsheet, targetCampaignIds);
  }
}
/**
 * Updates the execution statistics in the customerSheetValues.
 * @param {!SpreadsheetApp.Spreadsheet.sheet.range} range Spreadsheet range
 * object.
 * @param {!Array<!Array<string>>} customerSheetValues The values from the
 * Customers sheet.
 * @param {number=} averageExecutionTime The average time taken to process
 * one account.
 * @param {number=} totalExecutionTime The total allowed execution time.
 * @return {void}
 */
function updateExecutionStats(range, customerSheetValues,
  averageExecutionTime = null, totalExecutionTime = null) {
  const maxAccounts =
      Math.round(totalExecutionTime / averageExecutionTime) || 'n/a';
  customerSheetValues[CustomerRowMap.MAX_ACCOUNTS][CustomerColumnMap
      .EXECUTION_STATS_DATA] = maxAccounts;
  customerSheetValues[CustomerRowMap
      .AVERAGE_DURATION][CustomerColumnMap.EXECUTION_STATS_DATA] =
          averageExecutionTime || 'n/a';
  customerSheetValues[CustomerRowMap.START_DATE][CustomerColumnMap.EXECUTION_STATS_DATA] = startDate;
  customerSheetValues[CustomerRowMap.END_DATE][CustomerColumnMap.EXECUTION_STATS_DATA] = endDate;
  range.setValues(customerSheetValues);
  console.log(`Written summary stats and processing data to sheet ` +
              `'${range.getSheet().getSheetName()}'`);
}
/**
 * Processes a single Google Ads query for a given account.
 * @param {!AdsApp.Account} account The Google Ads account to query.
 * @param {string} query The GAQL query string.
 * @param {!Date|string} startDate The start date for the range. Can be a Date
 * object or a YYYY-MM-DD string.
 * @param {!Date|string} endDate The end date for the range. Can be a Date
 * object or a YYYY-MM-DD string.
 * @param {?Array<string|number>=} activeCampaignIds Optional list of campaign IDs to filter by.
 * @return {!Array<!Object>} An array of row objects returned by searchAdsApp.
 */
function addTimeWindowAndSearch(account, query, startDate, endDate, activeCampaignIds = null) {
  return searchAdsApp(account, addTimeWindowToQuery(query, startDate, endDate, activeCampaignIds));
}
/**
 * Processes a single Google Ads query for a given account and writes the
 * results to a specified sheet.
 * @param {!AdsApp.Account} account The Google Ads account to query.
 * @param {string} sheetName The name of the Google Sheet to write the results.
 * @param {!Date|string} startDate The start date for the range. Can be a Date
 * object or a YYYY-MM-DD string.
 * @param {!Date|string} endDate The end date for the range. Can be a Date
 * object or a YYYY-MM-DD string.
 * @param {string} mcc The Customer ID of the Manager Account.
 * @param {!SpreadsheetApp.spreadsheet} spreadsheet The Spreadsheet object.
 * @param {?Array<string|number>=} activeCampaignIds Optional list of campaign IDs to filter by.
 * @return {void}
 */
function processQuery(account, sheetName, startDate, endDate, mcc, spreadsheet, activeCampaignIds = null) {
  let sheet = spreadsheet.getSheetByName(sheetName);
  let results = [];
  let headers = [];
  try {
    if (GaqlQueries[sheetName] && GaqlQueries[sheetName]['queries'].length >= 1) {
      let query = GaqlQueries[sheetName]['queries'][0];
      let rows;
      if (sheetName === SHEETNAMES.SHOPPING_SEARCH_TERMS_METRICS ||
          sheetName === SHEETNAMES.SEARCH_TERMS_OVERVIEW ||
          sheetName === SHEETNAMES.SHOPPING_SEARCH_TERMS_OVERVIEW) {
          rows = []; // Streamed and aggregated downstream
      } else if (sheetName !== SHEETNAMES.AI_MAX_FEATURE_ADOPTION &&
                 sheetName !== SHEETNAMES.TOP_OPPORTUNITIES &&
                 sheetName !== SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING &&
                 sheetName !== SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING_GRAPH &&
                 sheetName !== SHEETNAMES.SHOPPING_BEST_PRACTICES_ADOPTION &&
                 sheetName !== SHEETNAMES.AI_MAX_ASSET_CLASSIFICATIONS) {
          rows = addTimeWindowAndSearch(account, query, startDate, endDate, activeCampaignIds);
      } else if (sheetName === SHEETNAMES.AI_MAX_ASSET_CLASSIFICATIONS) {
          rows = searchAdsApp(account, query);
      } else {
          rows = searchAdsApp(account, injectCampaignFilter(query, activeCampaignIds));
      }
      const startRow = (sheet && sheet.getLastRow() > 0) ? (sheet.getLastRow() + 1) : 2;
      switch (sheetName) {
        case SHEETNAMES.TIME_SERIES_CAMPAIGN:
          headers = GaqlQueries['TimeSeriesCampaign']['headers'];
          const kwRows = addTimeWindowAndSearch(
            account, GaqlQueries[sheetName]['queries'][1], startDate, endDate, activeCampaignIds);
          const lpRows = addTimeWindowAndSearch(
            account, GaqlQueries[sheetName]['queries'][2], startDate, endDate, activeCampaignIds);
          results = processTimeSeriesCampaign(rows, kwRows, lpRows, mcc);
          // Add headers so slicing below works correctly.
          results.unshift(headers);
          break;
        case SHEETNAMES.SEARCH_TERMS_OVERVIEW:
        case SHEETNAMES.SHOPPING_SEARCH_TERMS_OVERVIEW:
          const modifiedSearchTermQuery = addTimeWindowToQuery(query, startDate, endDate, activeCampaignIds);
          results = getSearchTermViewStreamed(account, modifiedSearchTermQuery, mcc, sheetName);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        case SHEETNAMES.SHOPPING_SEARCH_TERMS_METRICS:
          const modifiedQuery = addTimeWindowToQuery(query, startDate, endDate, activeCampaignIds);
          results = getShoppingSearchTermsMetricsStreamed(account, modifiedQuery);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        case SHEETNAMES.KEYWORDS_VIEW:
          query = addTimeWindowToQuery(
              GaqlQueries[sheetName]['queries'][1], startDate, endDate, activeCampaignIds);
          const targetingExpansionRows = searchAdsApp(account, query);
          results = getKeywordsView(rows, targetingExpansionRows, mcc);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        case SHEETNAMES.AI_MAX_FEATURE_ADOPTION:
          results = getAiMaxFeatureAdoption(rows, mcc, account.getCustomerId(), startRow);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        case SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING: {
          const criteriaRows = searchAdsApp(
              account, injectCampaignFilter(GaqlQueries[sheetName]['queries'][1], activeCampaignIds));
          results = getAiMaxFeatureAdoptionShopping(
              rows, criteriaRows, mcc, account.getCustomerId(), startRow);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        }
        case SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING_GRAPH: {
          const criteriaRows = searchAdsApp(
              account, injectCampaignFilter(GaqlQueries[sheetName]['queries'][1], activeCampaignIds));
          results = getAiMaxFeatureAdoptionShoppingGraph(
              rows, criteriaRows, mcc, account.getCustomerId(), startRow);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        }
        case SHEETNAMES.TOP_OPPORTUNITIES:
          results = getTopOpportunities(rows, mcc, account.getCustomerId());
          headers = GaqlQueries[sheetName]['headers'];
          break;
        case SHEETNAMES.GENERATED_VIEW:
          const advertiserRows = searchAdsApp(account, GaqlQueries[sheetName]['queries'][1]);
          results = getGeneratedView(rows, advertiserRows);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        case SHEETNAMES.AI_MAX_SHOPPING_TIME_SERIES:
          headers = GaqlQueries[sheetName]['headers'];
          const kwShoppingRows = addTimeWindowAndSearch(
            account, GaqlQueries[sheetName]['queries'][1], startDate, endDate, activeCampaignIds);
          const lpShoppingRows = addTimeWindowAndSearch(
            account, GaqlQueries[sheetName]['queries'][2], startDate, endDate, activeCampaignIds);
          results = processTimeSeriesShoppingCampaign(rows, kwShoppingRows, lpShoppingRows, mcc);
          // Add headers so slicing below works correctly.
          results.unshift(headers);
          break;
        case SHEETNAMES.SHOPPING_BEST_PRACTICES_ADOPTION:
          results = getShoppingBestPracticesAdoption(rows, mcc, account.getCustomerId());
          headers = GaqlQueries[sheetName]['headers'];
          break;
        case SHEETNAMES.SEARCH_TERMS_AND_COMBINATIONS:
          results = getSearchTermsAndCombinations(rows);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        case SHEETNAMES.LANDING_PAGE_INSIGHTS:
          results = getLandingPageInsights(rows);
          headers = GaqlQueries[sheetName]['headers'];
          break;
        default:
          headers = extractGaqlFields(GaqlQueries[sheetName]['queries'][0]);
          results = convertObjectsToRows(rows, headers);
      }
    }
    if (!sheet) {
      sheet = insertSheetWithColumns(spreadsheet, sheetName, headers.length);
    }
    // Always set/update the header row
    setHeaderRow(sheet, formatFieldNames(headers));
    if (sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION && sheet.getMaxColumns() >= 9 && sheet.getMaxRows() > 1) {
      sheet.getRange(2, 9, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
    }
    if (sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION && sheet.getMaxColumns() >= 10 && sheet.getMaxRows() > 1) {
      sheet.getRange(2, 10, sheet.getMaxRows() - 1, 1).setNumberFormat('0');
    }
    if (sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING && sheet.getMaxColumns() >= 13 && sheet.getMaxRows() > 1) {
      sheet.getRange(2, 13, sheet.getMaxRows() - 1, 1).setNumberFormat('0');
    }
    if (sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING_GRAPH && sheet.getMaxColumns() >= 13 && sheet.getMaxRows() > 1) {
      sheet.getRange(2, 13, sheet.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
    }
    if (results.length === 0 && sheetName !== SHEETNAMES.AI_MAX_FEATURE_ADOPTION && sheetName !== SHEETNAMES.TOP_OPPORTUNITIES && sheetName !== SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING && sheetName !== SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING_GRAPH) {
      console.log(
          `No results found for customer ${account.getCustomerId()} ` +
          `on sheet ${sheetName}.`);
      return;
    }
    // If results include headers, slice them off before writing
    const sheetResults = Array.isArray(results[0]) && results[0].length === headers.length && headers.every((h, i) => formatFieldNames([h])[0] === formatFieldNames([results[0][i]])[0]) ? results.slice(1) : results;
    if (sheetResults.length > 0) {
      const numRows = sheetResults.length;
      const numCols = sheetResults[0].length;
      const totalCells = numRows * numCols;
      console.log(`[Trix Diagnostic] Starting range.setValues() for sheet "${sheetName}": writing ${numRows} rows x ${numCols} cols (${totalCells.toLocaleString()} cells)...`);
      const trixStart = Date.now();
      let range = sheet.getRange(
          sheet.getLastRow() + 1, 1, numRows, numCols);
      range.setValues(sheetResults);
      if (sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION && numCols >= 9 && sheet.getLastRow() > 1) {
        sheet.getRange(2, 9, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd');
      }
      if (sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION && numCols >= 10 && sheet.getLastRow() > 1) {
        sheet.getRange(2, 10, sheet.getLastRow() - 1, 1).setNumberFormat('0');
      }
      if (sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING && numCols >= 13 && sheet.getLastRow() > 1) {
        sheet.getRange(2, 13, sheet.getLastRow() - 1, 1).setNumberFormat('0');
      }
      if (sheetName === SHEETNAMES.AI_MAX_FEATURE_ADOPTION_SHOPPING_GRAPH && numCols >= 13 && sheet.getLastRow() > 1) {
        sheet.getRange(2, 13, sheet.getLastRow() - 1, 1).setNumberFormat('yyyy-mm-dd');
      }
      const trixDuration = ((Date.now() - trixStart) / 1000).toFixed(1);
      console.log(
          `[Trix Diagnostic] Successfully wrote ${numRows} rows (${totalCells.toLocaleString()} cells) for customer ${account.getCustomerId()} to "${sheetName}" in ${trixDuration}s (${spreadsheet.getUrl()})`);
    } else {
       console.log(
          `No data to write for customer ${account.getCustomerId()} ` +
          `on sheet ${sheetName}.`);
    }
  } catch (e) {
    console.log(`An error occurred so no data was written to ` +
       `"${sheetName}" due to error: "${e.stack}"`);
  } finally {
    // Explicit Memory & Spreadsheet Flush
    if (results && Array.isArray(results)) {
      results.length = 0; // Instantly empties array buffer
    }
    results = null;       // Drop reference
    rows = null;          // Drop raw rows reference
    SpreadsheetApp.flush(); // Commits all pending setValues edits out of Apps Script memory
  }
}
/**
 * Processes the raw data for AI Max Feature Adoption.
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search.
 * @param {string} mcc The MCC ID.
 * @param {string} customerId The Internal Customer ID from the sheet.
 * @param {number=} startRow The starting row index in the sheet.
 * @return {!Array<!Array<string|number|boolean>>} Array of rows for the sheet.
 */
function getAiMaxFeatureAdoption(rows, mcc, customerId, startRow = 2) {
  const headers = GaqlQueries.AIMaxFeatureAdoption.headers;
  if (!rows || rows.length === 0) return [headers];
  const runDate = Utilities.formatDate(new Date(), Config.TIME_ZONE, DATE_FORMAT);
  const resultRows = rows.map((row, index) => {
    const rowNumber = startRow + index;
    const campaign = row.campaign;
    const customer = row.customer;
    const metrics = row.metrics;
    const segmentDate = (row.segments && row.segments.date) || '';
    const currencyCode = customer.currencyCode || customer.currency_code || 'USD';
    const costInLocalCurrency = (metrics.costMicros || 0) / 1000000;
    const searchSpendUsd = currencyCode === 'USD' ?
        costInLocalCurrency :
        `=D${rowNumber} * IFERROR(GOOGLEFINANCE("CURRENCY:${currencyCode}USD"); IFERROR(INDEX(GOOGLEFINANCE("CURRENCY:${currencyCode}USD"; "close"; TODAY()-7; TODAY()); 2; 2); 1))`;
    // 1. TC Enabled & FUE Enabled
    let tcEnabled = 'No';
    let fueEnabled = 'No';
    const rawSettings = campaign.assetAutomationSettings; // Accessing asset automation settings.
    let assetAutomationSettings = [];
    if (Array.isArray(rawSettings)) {
      assetAutomationSettings = rawSettings;
    } else if (typeof rawSettings === 'object' && rawSettings !== null) {
      assetAutomationSettings = Object.values(rawSettings);
    }
    for (const setting of assetAutomationSettings) {
      if (setting && setting.assetAutomationType === 'TEXT_ASSET_AUTOMATION' && setting.assetAutomationStatus === 'OPTED_IN') {
        tcEnabled = 'Yes';
      }
      if (setting && setting.assetAutomationType === 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION' && setting.assetAutomationStatus === 'OPTED_IN') {
        fueEnabled = 'Yes';
      }
    }
    // 2. STM Enabled (Equivalent to AI Max toggle for Search)
    let stmEnabled = 'No';
    const aiMaxSetting = campaign.aiMaxSetting || campaign.ai_max_setting;
    const isGlobalToggleOn = aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    );
    if (isGlobalToggleOn) {
        stmEnabled = 'Yes';
    }
    return [
      `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`,
      currencyCode,
      (campaign.name && campaign.id) ? `${campaign.name} - ${campaign.id}` : (campaign.name || ''),
      costInLocalCurrency, // Search Spend (Local)
      searchSpendUsd, // Search Spend ($)
      stmEnabled,
      tcEnabled,
      fueEnabled,
      segmentDate,
      '=COUNTUNIQUE($B$2:$B)', // Currency Count
      runDate
    ];
  });
  return [headers, ...resultRows];
}
/**
 * Processes the raw data for Search Terms and Combinations.
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search.
 * @return {!Array<!Array<string|number>>} Array of rows for the sheet.
 */
function getSearchTermsAndCombinations(rows) {
  const headers = GaqlQueries[SHEETNAMES.SEARCH_TERMS_AND_COMBINATIONS].headers;
  if (!rows || rows.length === 0) return [headers];
  const resultRows = rows.map(row => {
    const campaign = row.campaign || {};
    const customer = row.customer || {};
    const view = row.aiMaxSearchTermAdCombinationView || {};
    const metrics = row.metrics || {};
    const searchTerm = view.searchTerm || row.searchTerm || '';
    const headline = view.headline || row.headline || '';
    const landingPage = view.landingPage || row.landingPage || '';
    const impressions = parseInt(metrics.impressions || '0', 10);
    const clicks = parseInt(metrics.clicks || '0', 10);
    const cost = parseFloat(((metrics.costMicros || 0) / 1000000).toFixed(2));
    const conversions = parseFloat(metrics.conversions || 0);
    const conversionsValue = parseFloat(metrics.conversionsValue || 0);
    return [
      `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`,
      (campaign.name && campaign.id) ? `${campaign.name} - ${campaign.id}` : (campaign.name || ''),
      searchTerm,
      headline,
      landingPage,
      impressions,
      clicks,
      cost,
      conversions,
      conversionsValue
    ];
  });
  return [headers, ...resultRows];
}
/**
 * Processes the raw data for Landing Page Insights.
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search.
 * @return {!Array<!Array<string|number>>} Array of rows for the sheet.
 */
function getLandingPageInsights(rows) {
  const headers = GaqlQueries[SHEETNAMES.LANDING_PAGE_INSIGHTS].headers;
  if (!rows || rows.length === 0) return [headers];
  const resultRows = rows.map(row => {
    const campaign = row.campaign || {};
    const customer = row.customer || {};
    const segments = row.segments || {};
    const metrics = row.metrics || {};
    const expandedLandingPageView = row.expandedLandingPageView || {};
    const landingPageView = row.landingPageView || {};
    const customerName = `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`;
    const expandedUrl = expandedLandingPageView.expandedFinalUrl || '';
    const unexpandedUrl = landingPageView.unexpandedFinalUrl || '';
    const campaignId = campaign.id || '';
    const campaignName = campaign.name || '';
    const source = segments.landingPageSource || '';
    const impressions = parseInt(metrics.impressions || '0', 10);
    const clicks = parseInt(metrics.clicks || '0', 10);
    const cost = parseFloat(((metrics.costMicros || 0) / 1000000).toFixed(2));
    const conversions = parseFloat((metrics.conversions || 0));
    const conversionsValue = parseFloat((metrics.conversionsValue || 0));
    const costPerConversion = parseFloat(((metrics.costPerConversion || 0) / 1000000).toFixed(2));
    const conversionsValuePerCost = parseFloat((metrics.conversionsValuePerCost || 0).toFixed(2));
    return [
      customerName,
      expandedUrl,
      unexpandedUrl,
      campaignId,
      campaignName,
      source,
      impressions,
      clicks,
      cost,
      conversions,
      conversionsValue,
      costPerConversion,
      conversionsValuePerCost
    ];
  });
  return [headers, ...resultRows];
}
/**
 * Processes the raw data for AI Max Feature Adoption for Shopping campaigns.
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search for Shopping campaigns.
 * @param {!Array<!Object>} criteriaRows Raw rows from AdsApp.search for campaign criteria.
 * @param {?string=} mcc The Customer ID of the Manager Account.
 * @param {?string=} customerId The Internal Customer ID from the sheet.
 * @param {number=} startRow The starting row index in the sheet.
 * @return {!Array<!Array<string|number>>} Array of rows for the sheet.
 */
function getAiMaxFeatureAdoptionShopping(rows, criteriaRows, mcc, customerId, startRow = 2) {
  const headers = GaqlQueries.AIMaxFeatureAdoptionShopping.headers;
  if (!rows || rows.length === 0) return [headers];
  const runDate = Utilities.formatDate(new Date(), Config.TIME_ZONE, DATE_FORMAT);
  const brandExcludedCampaignIds = new Set();
  const urlExcludedCampaignIds = new Set();
  if (criteriaRows && Array.isArray(criteriaRows)) {
    for (const critRow of criteriaRows) {
      const campaignId = critRow.campaign && critRow.campaign.id;
      const crit = critRow.campaignCriterion || critRow.campaign_criterion;
      if (campaignId && crit) {
        const type = crit.type;
        const isNegative = crit.negative === true || crit.negative === 'true' || crit.negative === 'TRUE';
        if ((type === 'BRAND_LIST' || type === 'BRAND') && isNegative) {
          brandExcludedCampaignIds.add(String(campaignId));
        }
        if ((type === 'WEBPAGE' || type === 'WEBPAGE_LIST') && isNegative) {
          urlExcludedCampaignIds.add(String(campaignId));
        }
      }
    }
  }
  const resultRows = rows.map((row, index) => {
    const rowNumber = startRow + index;
    const campaign = row.campaign || {};
    const customer = row.customer || {};
    const metrics = row.metrics || {};
    const custId = customer.id || customerId || '';
    const campaignId = campaign.id || '';
    const campaignName = campaign.name || '';
    const costMicros = metrics.costMicros || metrics.cost_micros || 0;
    const shoppingSpendLocal = costMicros / 1000000;
    const currencyCode = customer.currencyCode || customer.currency_code || 'USD';
    const shoppingSpendUsd = currencyCode === 'USD' ?
        shoppingSpendLocal :
        `=D${rowNumber} * IFERROR(GOOGLEFINANCE("CURRENCY:${currencyCode}USD"); IFERROR(INDEX(GOOGLEFINANCE("CURRENCY:${currencyCode}USD"; "close"; TODAY()-7; TODAY()); 2; 2); 1))`;
    // 1. TC Enabled & FUE Enabled (Checks individual sub-features first)
    let tcEnabled = 'No';
    let fueEnabled = 'No';
    const rawSettings = campaign.assetAutomationSettings || campaign.asset_automation_settings;
    let assetAutomationSettings = [];
    if (Array.isArray(rawSettings)) {
      assetAutomationSettings = rawSettings;
    } else if (typeof rawSettings === 'object' && rawSettings !== null) {
      assetAutomationSettings = Object.values(rawSettings);
    }
    for (const setting of assetAutomationSettings) {
      const type = setting.assetAutomationType || setting.asset_automation_type;
      const status = setting.assetAutomationStatus || setting.asset_automation_status;
      if (setting && type === 'TEXT_ASSET_AUTOMATION' && status === 'OPTED_IN') {
        tcEnabled = 'Yes';
      }
      if (setting && type === 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION' && status === 'OPTED_IN') {
        fueEnabled = 'Yes';
      }
    }
    // 2. AI Max Enabled (Evaluates Global Toggle OR both sub-features)
    let isAiMaxEnabled = 'No';
    const aiMaxSetting = campaign.aiMaxSetting || campaign.ai_max_setting;
    // Check if the global toggle is physically flipped
    const isGlobalToggleOn = aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    );
    if (isGlobalToggleOn) {
        isAiMaxEnabled = 'Yes';
    }
    // Has Brand Exclusions: HasBrandListCriterion = TRUE AND ignore_brand_exclusion_in_shopping_ads = FALSE
    const shoppingSetting = campaign.shoppingSetting || campaign.shopping_setting || {};
    const ignoreBrandExclusionInShoppingAds = Boolean(
      shoppingSetting.ignoreBrandExclusionInShoppingAds ||
      shoppingSetting.ignore_brand_exclusion_in_shopping_ads
    );
    const hasBrandListCriterion = brandExcludedCampaignIds.has(String(campaignId));
    const hasBrandExclusions = (hasBrandListCriterion && !ignoreBrandExclusionInShoppingAds) ? 'Yes' : 'No';
    // Has URL Exclusions
    const hasUrlExclusions = urlExcludedCampaignIds.has(String(campaignId)) ? 'Yes' : 'No';
    // Has Text Term Exclusions
    let hasTextTermExclusions = 'No';
    const textGuidelines = campaign.textGuidelines || campaign.text_guidelines;
    if (textGuidelines && ((Array.isArray(textGuidelines.termExclusions) && textGuidelines.termExclusions.length > 0) ||
                           (Array.isArray(textGuidelines.term_exclusions) && textGuidelines.term_exclusions.length > 0))) {
      hasTextTermExclusions = 'Yes';
    }
    // Has Messaging Guidelines
    let hasMessagingGuidelines = 'No';
    if (textGuidelines && ((Array.isArray(textGuidelines.messagingRestrictions) && textGuidelines.messagingRestrictions.length > 0) ||
                           (Array.isArray(textGuidelines.messaging_restrictions) && textGuidelines.messaging_restrictions.length > 0))) {
      hasMessagingGuidelines = 'Yes';
    }
    return [
      `${customer.descriptiveName || 'Unknown'} - ${custId}`,
      currencyCode,
      (campaignName && campaignId) ? `${campaignName} - ${campaignId}` : campaignName,
      shoppingSpendLocal,
      shoppingSpendUsd,
      isAiMaxEnabled,
      tcEnabled,
      fueEnabled,
      hasBrandExclusions,
      hasUrlExclusions,
      hasTextTermExclusions,
      hasMessagingGuidelines,
      '=COUNTUNIQUE($B$2:$B)', // Currency Count
      runDate
    ];
  });
  return [headers, ...resultRows];
}
/**
 * Processes the raw data for AI Max Feature Adoption Shopping Graph.
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search for Shopping campaigns.
 * @param {!Array<!Object>} criteriaRows Raw rows from AdsApp.search for campaign criteria.
 * @param {?string=} mcc The Customer ID of the Manager Account.
 * @param {?string=} customerId The Internal Customer ID from the sheet.
 * @param {number=} startRow The starting row index in the sheet.
 * @return {!Array<!Array<string|number>>} Array of rows for the sheet.
 */
function getAiMaxFeatureAdoptionShoppingGraph(rows, criteriaRows, mcc, customerId, startRow = 2) {
  const headers = GaqlQueries.AIMaxFeatureAdoptionShoppingGraph.headers;
  if (!rows || rows.length === 0) return [headers];
  const runDate = Utilities.formatDate(new Date(), Config.TIME_ZONE, DATE_FORMAT);
  const brandExcludedCampaignIds = new Set();
  const urlExcludedCampaignIds = new Set();
  if (criteriaRows && Array.isArray(criteriaRows)) {
    for (const critRow of criteriaRows) {
      const campaignId = critRow.campaign && critRow.campaign.id;
      const crit = critRow.campaignCriterion || critRow.campaign_criterion;
      if (campaignId && crit) {
        const type = crit.type;
        const isNegative = crit.negative === true || crit.negative === 'true' || crit.negative === 'TRUE';
        if ((type === 'BRAND_LIST' || type === 'BRAND') && isNegative) {
          brandExcludedCampaignIds.add(String(campaignId));
        }
        if ((type === 'WEBPAGE' || type === 'WEBPAGE_LIST') && isNegative) {
          urlExcludedCampaignIds.add(String(campaignId));
        }
      }
    }
  }
  const resultRows = rows.map((row, index) => {
    const rowNumber = startRow + index;
    const campaign = row.campaign || {};
    const customer = row.customer || {};
    const metrics = row.metrics || {};
    const segmentDate = (row.segments && row.segments.date) || '';
    const custId = customer.id || customerId || '';
    const campaignId = campaign.id || '';
    const campaignName = campaign.name || '';
    const costMicros = metrics.costMicros || metrics.cost_micros || 0;
    const shoppingSpendLocal = costMicros / 1000000;
    const currencyCode = customer.currencyCode || customer.currency_code || 'USD';
    const shoppingSpendUsd = currencyCode === 'USD' ?
        shoppingSpendLocal :
        `=D${rowNumber} * IFERROR(GOOGLEFINANCE("CURRENCY:${currencyCode}USD"); IFERROR(INDEX(GOOGLEFINANCE("CURRENCY:${currencyCode}USD"; "close"; TODAY()-7; TODAY()); 2; 2); 1))`;
    // 1. TC Enabled & FUE Enabled (Checks individual sub-features first)
    let tcEnabled = 'No';
    let fueEnabled = 'No';
    const rawSettings = campaign.assetAutomationSettings || campaign.asset_automation_settings;
    let assetAutomationSettings = [];
    if (Array.isArray(rawSettings)) {
      assetAutomationSettings = rawSettings;
    } else if (typeof rawSettings === 'object' && rawSettings !== null) {
      assetAutomationSettings = Object.values(rawSettings);
    }
    for (const setting of assetAutomationSettings) {
      const type = setting.assetAutomationType || setting.asset_automation_type;
      const status = setting.assetAutomationStatus || setting.asset_automation_status;
      if (setting && type === 'TEXT_ASSET_AUTOMATION' && status === 'OPTED_IN') {
        tcEnabled = 'Yes';
      }
      if (setting && type === 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION' && status === 'OPTED_IN') {
        fueEnabled = 'Yes';
      }
    }
    // 2. AI Max Enabled
    let isAiMaxEnabled = 'No';
    const aiMaxSetting = campaign.aiMaxSetting || campaign.ai_max_setting;
    if (aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    )) {
      isAiMaxEnabled = 'Yes';
    }
    // Has Brand Exclusions: HasBrandListCriterion = TRUE AND ignore_brand_exclusion_in_shopping_ads = FALSE
    const shoppingSetting = campaign.shoppingSetting || campaign.shopping_setting || {};
    const ignoreBrandExclusionInShoppingAds = Boolean(
      shoppingSetting.ignoreBrandExclusionInShoppingAds ||
      shoppingSetting.ignore_brand_exclusion_in_shopping_ads
    );
    const hasBrandListCriterion = brandExcludedCampaignIds.has(String(campaignId));
    const hasBrandExclusions = (hasBrandListCriterion && !ignoreBrandExclusionInShoppingAds) ? 'Yes' : 'No';
    // Has URL Exclusions
    const hasUrlExclusions = urlExcludedCampaignIds.has(String(campaignId)) ? 'Yes' : 'No';
    // Has Text Term Exclusions
    let hasTextTermExclusions = 'No';
    const textGuidelines = campaign.textGuidelines || campaign.text_guidelines;
    if (textGuidelines && ((Array.isArray(textGuidelines.termExclusions) && textGuidelines.termExclusions.length > 0) ||
                           (Array.isArray(textGuidelines.term_exclusions) && textGuidelines.term_exclusions.length > 0))) {
      hasTextTermExclusions = 'Yes';
    }
    // Has Messaging Guidelines
    let hasMessagingGuidelines = 'No';
    if (textGuidelines && ((Array.isArray(textGuidelines.messagingRestrictions) && textGuidelines.messagingRestrictions.length > 0) ||
                           (Array.isArray(textGuidelines.messaging_restrictions) && textGuidelines.messaging_restrictions.length > 0))) {
      hasMessagingGuidelines = 'Yes';
    }
    return [
      `${customer.descriptiveName || 'Unknown'} - ${custId}`,
      currencyCode,
      (campaignName && campaignId) ? `${campaignName} - ${campaignId}` : campaignName,
      shoppingSpendLocal,
      shoppingSpendUsd,
      isAiMaxEnabled,
      tcEnabled,
      fueEnabled,
      hasBrandExclusions,
      hasUrlExclusions,
      hasTextTermExclusions,
      hasMessagingGuidelines,
      segmentDate,
      runDate
    ];
  });
  return [headers, ...resultRows];
}
/**
 * Processes the raw data for Shopping Best Practices Adoption.
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search.
 * @param {string} mcc The MCC ID.
 * @param {string} customerId The Customer ID.
 * @return {!Array<!Array<string|number>>} Array of rows for the sheet.
 */
function getShoppingBestPracticesAdoption(rows, mcc, customerId) {
  const headers = GaqlQueries['ShoppingBestPracticesAdoption'].headers;
  if (!rows || rows.length === 0) {
    const dummyRow = Array(headers.length).fill('');
    dummyRow[headers.indexOf('Has Shopping Campaigns')] = 'No';
    return [headers, dummyRow];
  }
  const resultRows = rows.map(row => {
    const campaign = row.campaign || {};
    const biddingStrategyType = campaign.biddingStrategyType || campaign.bidding_strategy_type || '';
    const maximizeConversionValue = campaign.maximizeConversionValue || campaign.maximize_conversion_value || {};
    const maxConvTargetRoas = maximizeConversionValue.targetRoas || maximizeConversionValue.target_roas || 0;
    const standardTargetRoasSetting = campaign.targetRoas || campaign.target_roas || {};
    const standardTargetRoas = standardTargetRoasSetting.targetRoas || standardTargetRoasSetting.target_roas || 0;
    const effectiveTargetRoas = standardTargetRoas || maxConvTargetRoas || 0;
    let isAiMaxEnabled = 'No';
    const aiMaxSetting = campaign.aiMaxSetting || campaign.ai_max_setting;
    if (aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    )) {
      isAiMaxEnabled = 'Yes';
    }
    // Flag 1: Campaigns that are not using tROAS
    const isUsingTroas = (biddingStrategyType === 'TARGET_ROAS') ||
                         (biddingStrategyType === 'MAXIMIZE_CONVERSION_VALUE' && maxConvTargetRoas > 0);
    const notUsingTroas = !isUsingTroas;
    const bidStrategyFlag = notUsingTroas ? 'No' : 'Yes';
    // Flag 2: Campaigns that have only enabled TC but not FUE
    let tcEnabled = false;
    let fueEnabled = false;
    const rawSettings = campaign.assetAutomationSettings || campaign.asset_automation_settings;
    let assetAutomationSettings = [];
    if (Array.isArray(rawSettings)) {
      assetAutomationSettings = rawSettings;
    } else if (typeof rawSettings === 'object' && rawSettings !== null) {
      assetAutomationSettings = Object.values(rawSettings);
    }
    for (const setting of assetAutomationSettings) {
      const type = setting.assetAutomationType || setting.asset_automation_type;
      const status = setting.assetAutomationStatus || setting.asset_automation_status;
      if (type === 'TEXT_ASSET_AUTOMATION' && status === 'OPTED_IN') {
        tcEnabled = true;
      }
      if (type === 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION' && status === 'OPTED_IN') {
        fueEnabled = true;
      }
    }
    const tcOnlyNoFue = tcEnabled && !fueEnabled;
    const fueledFlag = tcOnlyNoFue ? 'Yes' : 'No';
    // Flag 3: Campaigns that are limited by budget
    const biddingStrategySystemStatus = campaign.biddingStrategySystemStatus || campaign.bidding_strategy_system_status || '';
    let primaryStatusReasons = campaign.primaryStatusReasons || campaign.primary_status_reasons;
    if (!Array.isArray(primaryStatusReasons)) {
        primaryStatusReasons = primaryStatusReasons ? [primaryStatusReasons] : [];
    }
    // Check for both BUDGET_CONSTRAINED and CAMPAIGN_BUDGET_CONSTRAINED to be safe
    const isBudgetConstrained = primaryStatusReasons.includes('BUDGET_CONSTRAINED') ||
                                primaryStatusReasons.includes('CAMPAIGN_BUDGET_CONSTRAINED');
    const isLimitedByBudget = (biddingStrategySystemStatus === 'LIMITED_BY_BUDGET' || isBudgetConstrained);
    const budgetFlag = isLimitedByBudget ? 'Yes' : 'No';
    const customer = row.customer || {};
    return [
      mcc || '',
      `${customer.descriptiveName || 'Unknown'} - ${customerId || customer.id || ''}`,
      (campaign.name && campaign.id) ? `${campaign.name} - ${campaign.id}` : (campaign.name || ''),
      isAiMaxEnabled,
      biddingStrategyType,
      JSON.stringify(rawSettings || []),
      biddingStrategySystemStatus,
      JSON.stringify(primaryStatusReasons || []),
      effectiveTargetRoas,
      maxConvTargetRoas,
      standardTargetRoas,
      bidStrategyFlag,
      fueledFlag,
      budgetFlag,
      'Yes'
    ];
  });
  return [headers, ...resultRows];
}
/**
 * Processes raw data for Shopping Search Terms Metrics.
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search.
 * @return {!Array<!Array<string|number>>} Array of rows for the sheet.
 */
function getShoppingSearchTermsMetrics(rows) {
  const results = [];
  if (!Array.isArray(rows)) {
    return [];
  }
  for (const item of rows) {
    let stmEnabled = 'No';
    const aiMaxSetting = item.campaign && (item.campaign.aiMaxSetting || item.campaign.ai_max_setting);
    if (aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    )) {
      stmEnabled = 'Yes';
    }
    const adGroupId = (item.adGroup && item.adGroup.id) || '';
    const adGroupName = (item.adGroup && item.adGroup.name) || '';
    const adGroupString = adGroupId ? `${adGroupId} - ${adGroupName}` : '';
    const customer = item.customer || {};
    results.push([
      `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`,
      item.segments ? item.segments.searchTermMatchType : '',
      item.metrics ? item.metrics.clicks : 0,
      item.metrics ? (parseInt(item.metrics.costMicros || '0', 10) / 1000000) : 0,
      item.metrics ? item.metrics.conversions : 0,
      item.metrics ? item.metrics.conversionsValue : 0,
      item.metrics ? item.metrics.impressions : 0,
      stmEnabled,
      (item.campaign && item.campaign.name && item.campaign.id) ? `${item.campaign.name} - ${item.campaign.id}` : (item.campaign ? item.campaign.name : ''),
      adGroupString
    ]);
  }
  return results;
}
/**
 * Processes raw data for Shopping Search Terms Metrics using streaming and aggregation.
 * @param {!AdsApp.Account} account The Google Ads account to query.
 * @param {string} query The GAQL query string.
 * @return {!Array<!Array<string|number>>} Array of aggregated rows for the sheet.
 */
function getShoppingSearchTermsMetricsStreamed(account, query) {
  const aggregatedData = {};
  searchAdsApp(account, query, (item) => {
    let stmEnabled = 'No';
    const aiMaxSetting = item.campaign && (item.campaign.aiMaxSetting || item.campaign.ai_max_setting);
    if (aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    )) {
      stmEnabled = 'Yes';
    }
    const adGroupId = (item.adGroup && item.adGroup.id) || '';
    const adGroupName = (item.adGroup && item.adGroup.name) || '';
    const adGroupString = adGroupId ? `${adGroupId} - ${adGroupName}` : '';
    const matchType = item.segments ? item.segments.searchTermMatchType : '';
    const campaignId = (item.campaign && item.campaign.id) || '';
    const campaignName = (item.campaign && item.campaign.name && item.campaign.id) ? `${item.campaign.name} - ${campaignId}` : (item.campaign ? item.campaign.name : '');
    const customer = item.customer || {};
    const customerName = `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`;
    const key = `${customerName}|${matchType}|${stmEnabled}|${campaignName}|${adGroupString}`;
    if (!aggregatedData[key]) {
      aggregatedData[key] = {
        customerName,
        matchType,
        stmEnabled,
        campaignName,
        adGroupString,
        clicks: 0,
        cost: 0,
        conversions: 0,
        conversionsValue: 0,
        impressions: 0
      };
    }
    const metrics = item.metrics || {};
    aggregatedData[key].clicks += parseInt(metrics.clicks || '0', 10);
    aggregatedData[key].cost += (parseInt(metrics.costMicros || '0', 10) / 1000000);
    aggregatedData[key].conversions += parseFloat(metrics.conversions || '0');
    aggregatedData[key].conversionsValue += parseFloat(metrics.conversionsValue || '0');
    aggregatedData[key].impressions += parseInt(metrics.impressions || '0', 10);
  });
  return Object.values(aggregatedData).map(item => [
    item.customerName,
    item.matchType,
    item.clicks,
    item.cost,
    item.conversions,
    item.conversionsValue,
    item.impressions,
    item.stmEnabled,
    item.campaignName,
    item.adGroupString
  ]);
}
/**
 * Processes the raw data for Top Opportunities to Scale AI Max.
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search.
 * @param {string} mcc The MCC ID.
 * @param {string} customerId The Internal Customer ID from the sheet.
 * @return {!Array<!Array<string|number>>} Array of rows for the sheet.
 */
function getTopOpportunities(rows, mcc, customerId) {
  const headers = GaqlQueries.TopOpportunities.headers;
  if (!rows || rows.length === 0) return [headers];
  const resultRows = rows.map(row => {
    const campaign = row.campaign;
    const customer = row.customer;
    const metrics = row.metrics;
    const past7dConversions = parseFloat(metrics.conversions || 0);
    const past7dConversionValue = parseFloat(metrics.conversionsValue || 0);
    const segmentDate = (row.segments && row.segments.date) || '';
    return [
      `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`,
      (campaign.name && campaign.id) ? `${campaign.name} - ${campaign.id}` : campaign.name,
      past7dConversions,
      parseFloat((past7dConversions * Config.INCREMENTAL_UPLIFT_RATE).toFixed(2)), // Estimated Incremental Conversion Uplift, based on 14% CTR
      past7dConversionValue,
      parseFloat((past7dConversionValue * Config.INCREMENTAL_UPLIFT_RATE).toFixed(2)), // Estimated Incremental Conversion Value Uplift, based on 14% CTR,
      segmentDate
    ];
  });
  return [headers, ...resultRows];
}
/**
 * Processes the raw data for Generated View, standardizing metrics from micros
 * and ratios to currency ($) and percentages (%).
 * @param {!Array<!Object>} rows Raw rows from AdsApp.search.
 * @param {!Array<!Object>} advertiserRows Advertiser asset rows.
 * @return {!Array<!Array<string|number>>} Array of rows for the sheet.
 */
function getGeneratedView(rows, advertiserRows) {
  const headers = GaqlQueries.GeneratedView.headers;
  if (!rows || rows.length === 0) return [headers];
  const advertiserAssetBank = {};
  if (Array.isArray(advertiserRows)) {
    for (const row of advertiserRows) {
      const textAsset = (row.asset && (row.asset.textAsset || row.asset.text_asset)) || {};
      const text = textAsset.text;
      if (text) {
        const normalizedText = String(text).trim().toLowerCase();
        advertiserAssetBank[normalizedText] = true;
      }
    }
  }
  const resultRows = rows.map(row => {
    const customer = row.customer || {};
    const segments = row.segments || {};
    const campaign = row.campaign || {};
    const adGroup = row.adGroup || {};
    const metrics = row.metrics || {};
    const asset = row.asset || {};
    const textAsset = asset.textAsset || asset.text_asset || {};
    const adGroupAdAssetView = row.adGroupAdAssetView || row.ad_group_ad_asset_view || {};
    const impressions = parseInt(metrics.impressions || '0', 10);
    const cost = parseFloat(((metrics.costMicros || 0) / 1000000).toFixed(2));
    const clicks = parseInt(metrics.clicks || '0', 10);
    const conversions = parseFloat(metrics.conversions || 0).toFixed(2);
    const conversionsValue = parseFloat((metrics.conversionsValue || 0)).toFixed(2);
    const ctr = parseFloat(((metrics.ctr || 0) * 100).toFixed(2));
    const averageCpc = parseFloat(((metrics.averageCpc || 0) / 1000000).toFixed(2));
    const costPerConversion = parseFloat(((metrics.costPerConversion || 0) / 1000000).toFixed(2));
    const conversionsValuePerCost = parseFloat((metrics.conversionsValuePerCost || 0).toFixed(2));
    const assetText = textAsset.text || asset.text || '';
    const normalizedAiText = String(assetText).trim().toLowerCase();
    let classification = '';
    if (assetText) {
      if (advertiserAssetBank[normalizedAiText]) {
        classification = 'Picked up from Advertiser provided asset';
      } else {
        classification = 'Net new asset post Text Customization activation';
      }
    }
    return [
      `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`,
      segments.date || '',
      (campaign.name && campaign.id) ? `${campaign.name} - ${campaign.id}` : (campaign.name || ''),
      adGroup.name || '',
      impressions,
      cost,
      clicks,
      conversions,
      parseFloat(conversionsValue),
      ctr,
      averageCpc,
      costPerConversion,
      conversionsValuePerCost,
      assetText,
      adGroupAdAssetView.fieldType || adGroupAdAssetView.field_type || '',
      classification
    ];
  });
  return [headers, ...resultRows];
}
/**
 * Inserts a new sheet into a spreadsheet, ensuring it has an exact number of
 * columns. If a sheet with the same name already exists, it will be deleted and
 * replaced.
 *
 * @param {!SpreadsheetApp.spreadsheet} spreadsheet The Spreadsheet object.
 * @param {string} sheetName The name for the new sheet.
 * @param {number} numColumns The exact number of columns the new sheet should
 *     have.
 * @return {!SpreadsheetApp.spreadsheet.sheet | null} The newly created sheet
 *     object.
 */
function insertSheetWithColumns(spreadsheet, sheetName, numColumns) {
  if (numColumns < 1) {
    console.log('Error: Number of columns must be 1 or greater.');
    return null;
  }
  try {
    let sheet = spreadsheet.getSheetByName(sheetName);
    if (sheet) {
        spreadsheet.deleteSheet(sheet);
        console.log(`Deleted existing sheet: "${sheetName}"`);
    }
    const newSheet = spreadsheet.insertSheet(sheetName);
    console.log(`Created new sheet: "${sheetName}"`);
    const currentCols = newSheet.getMaxColumns();
    if (currentCols < numColumns) {
      const colsToAdd = numColumns - currentCols;
      newSheet.insertColumnsAfter(currentCols, colsToAdd);
    } else if (currentCols > numColumns) {
      const colsToDelete = currentCols - numColumns;
      newSheet.deleteColumns(numColumns + 1, colsToDelete);
    }
    console.log(`Sheet "${sheetName}" is ready with ${newSheet.getMaxColumns()} columns.`);
    return newSheet;
  } catch (e) {
    console.log(`Error: Failed to insert sheet. ${e}`);
    return null;
  }
}
/**
 * Sets or updates the header row in a given Google Sheet.
 * @param {!Sheet} sheet The Google Sheet object.
 * @param {!Array<string>} headers An array of formatted header strings.
 */
function setHeaderRow(sheet, headers) {
  if (headers && headers.length > 0) {
    // Clear existing headers in the first row
    sheet.getRange(1, 1, 1, sheet.getMaxColumns()).clearContent();
    // Write the new headers
    sheet.getRange(1, 1, 1, headers.length)
        .setValues([headers])
        .setFontWeight('bold');
  }
}
/**
 * Retrieves all sheets in the active spreadsheet and clears the contents
 * of each sheet while preserving formatting.
 * @param {!SpreadsheetApp.spreadsheet} spreadsheet The Spreadsheet object.
 */
function clearAllSheetsContent(spreadsheet) {
  const sheets = spreadsheet.getSheets();
  if (sheets.length === 0) {
    console.log('The spreadsheet has no sheets to clear.');
    return;
  }
  sheets.forEach(sheet => {
    const sheetName = sheet.getName();
    if (sheetName === 'Customers') {
      return;
    }
    if (sheet.getLastRow() > 1) { // Keep header row
      const range =
          sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getMaxColumns());
      range.clearContent();
      console.log('Cleared contents in sheet: ' + sheetName);
    } else if (sheet.getLastRow() === 1) {
       console.log('No data to clear in sheet: ' + sheetName);
    }
  });
  SpreadsheetApp.flush();
}
/**
 * Retrieves and logs the Customer ID and Name for all child accounts
 * under the current Manager Account (MCC).
 * @return {!Array<!Array<string|boolean>>|undefined} A 2d array formatted
 * for output to the Customers sheet in the spreadsheet.
 */
function getAllChildAccounts() {
  // Get an iterator for all accounts managed by this MCC
  const accountIterator = AdsManagerApp.accounts().get();
  console.log('Starting to retrieve child accounts...');
  if (!accountIterator.hasNext()) {
    console.log('No child accounts found.');
    return;
  }
  const accountDetails = [];
  while (accountIterator.hasNext()) {
    const account = accountIterator.next();
    const customerId = account.getCustomerId().replace(/-/g, '');
    let accountName = '';
    if (account) {
      if (typeof account.getName === 'function') {
        accountName = account.getName();
      } else if (typeof account.getDescriptiveName === 'function') {
        accountName = account.getDescriptiveName();
      }
    }
    if (accountName) {
      accountDetails.push([true, customerId, accountName]);
    } else {
      accountDetails.push([true, customerId, customerId]);
    }
  }
  console.log(`Total accounts found: ${accountDetails.length}`);
  console.log('Full Account List (ID & Name):');
  console.log(accountDetails);
  return accountDetails;
}
/**
 * Executes a Google Ads search query for a specific account.
 * @param {!AdsApp.Account} account The Google Ads account to search within.
 * @param {string} query The GAQL query string.
 * @param {?Function=} processRowCallback Optional callback function called for each row.
 * @return {!Array<!Object>} An array of row objects returned by AdsApp.search,
 *   with resource names filtered out.
 */
function searchAdsApp(account, query, processRowCallback = null) {
  if (typeof AdsManagerApp !== 'undefined') {
    AdsManagerApp.select(account);
  }
  console.log(`[GAQL Diagnostic] Executing query for account ${account.getCustomerId()}: ${query}`);
  const startTime = Date.now();
  const rows = AdsApp.search(query, {apiVersion: Config.API_VERSION});
  const results = [];
  let count = 0;
  while (rows.hasNext()) {
    const row = rows.next();
    const filteredRow = filterResourceNames(row);
    if (processRowCallback) {
      processRowCallback(filteredRow);
    } else {
      results.push(filteredRow);
    }
    count++;
    if (count % 5000 === 0) {
      console.log(`[GAQL Diagnostic] Fetched ${count} rows so far into JS memory for account ${account.getCustomerId()}...`);
    }
  }
  const durationMs = Date.now() - startTime;
  console.log(`[GAQL Diagnostic] Finished query for account ${account.getCustomerId()}: Processed ${count} total rows in ${(durationMs / 1000).toFixed(1)}s.`);
  return results;
}
/**
 * Recursively filters an object, removing key-value pairs where the key
 * contains the substring "resourceName".
 *
 * @param {!Object} item The object or array to filter.
 * @return {!Object} A new object or array with the specified keys removed,
 *   or the original item if it's not an object or array.
 */
function filterResourceNames(item) {
  if (typeof item !== 'object' || item === null) {
    return item;
  }
  const filteredObject = {};
  for (const key of Object.keys(item)) {
    if (key.includes("resourceName")) {
      continue;
    }
    const value = item[key];
    filteredObject[key] = filterResourceNames(value);
  }
  return filteredObject;
}
/**
 * Modifies a GAQL query to replace a predefined date range
 * (e.g., LAST_30_DAYS) with a custom date range specified by a start and end
 * date.
 * @param {string} query The original GAQL query string.
 * @param {!Date|string} startDate The start date for the range. Can be a Date
 * object or a YYYY-MM-DD string.
 * @param {!Date|string} endDate The end date for the range. Can be a Date
 * object or a YYYY-MM-DD string.
 * @param {?Array<string>=} activeCampaignIds An array of active campaign IDs.
 * @return {string} The modified GAQL query with the custom date range, or the
 * original query if dates are invalid.
 */
function addTimeWindowToQuery(query, startDate, endDate, activeCampaignIds = null) {
  let modifiedQuery = query;
  if (startDate !== '1970-01-01' && endDate !== '1970-01-01' &&
    endDate > startDate) {
    const oldDateClause = 'AND segments.date DURING LAST_30_DAYS';
    const newDateClause =
        `AND segments.date >= '${startDate}' AND segments.date <= '${endDate}'`;
    // Replace the old date clause if it exists
    if (modifiedQuery.includes(oldDateClause)) {
      modifiedQuery = modifiedQuery.replace(oldDateClause, newDateClause);
    } else if (modifiedQuery.includes('segments.date >') && modifiedQuery.includes('segments.date <')) {
      modifiedQuery = modifiedQuery.replace(/AND\s+segments\.date\s*>=\?\s*'[^']+'\s*AND\s+segments\.date\s*<=\?\s*'[^']+'/gi, newDateClause);
    } else {
      console.log(
          'The query does not contain the clause: "' + oldDateClause +
          '". No date window was replaced.');
    }
  } else {
    console.warn(
        'No valid input dates provided. Keeping original date clause.');
  }
  if (activeCampaignIds && Array.isArray(activeCampaignIds) && activeCampaignIds.length > 0) {
    modifiedQuery = injectCampaignFilter(modifiedQuery, activeCampaignIds);
  }
  return modifiedQuery;
}
/**
 * Extracts all field names from the SELECT clause of a GAQL query.
 * @param {string} gaqlQuery The GAQL query string.
 * @return {!Array<string>} An array of the extracted field names
 * (e.g., 'customer.id').
 */
function extractGaqlFields(gaqlQuery) {
  const selectClauseRegex = /SELECT(.*?)FROM/is;
  const match = gaqlQuery.match(selectClauseRegex);
  if (!match || !match[1]) {
    return [];
  }
  const fieldsString = match[1];
  const fields = fieldsString.split(',')
                     .map(field => field.trim())
                     .filter(field => field.length > 0);
  return fields;
}
/**
 * Helper function to retrieve a nested value from an object using a
 * dot-notation string path. This function safely walks the object path.
 * If any intermediate key doesn't exist, it returns 'undefined' instead
 * of throwing an error.
 *
 * @param {!Object} obj The object to search (e.g., {customer: {id: '123'}}).
 * @param {string} path The dot-notation path (e.g., 'customer.id').
 * @return {*} The found value, or undefined if the path doesn't exist.
 */
function getNestedValue(obj, path) {
  const keys = snakeToCamel(path.split('.'));
  return keys.reduce((acc, key) => {
    return (acc && acc[key] !== undefined) ? acc[key] : undefined;
  }, obj);
}
/**
 * Converts an array of nested objects into an array of arrays, with the
 * inner array's order determined by a header array.
 *
 * @param {!Array<!Object>} data Array of nested objects.
 * @param {!Array<string>} headers Array of dot-notation header strings
 * (e.g., ['campaign.id', 'customer.id']).
 * @return {!Array<!Array<*>>} An array of arrays, where each inner array
 * contains the values from one object, ordered according to the headers.
 */
function convertObjectsToRows(data, headers) {
  return data.map(obj => {
    const row = headers.map(header => {
      if (header === 'customer.descriptive_name') {
        const name = getNestedValue(obj, 'customer.descriptive_name');
        const id = getNestedValue(obj, 'customer.id');
        return (name && id) ? `${name} - ${id}` : name;
      }
      if (header === 'campaign.name') {
        const name = getNestedValue(obj, 'campaign.name');
        const id = getNestedValue(obj, 'campaign.id');
        return (name && id) ? `${name} - ${id}` : name;
      }
      return getNestedValue(obj, header);
    });
    return row;
  });
}
/**
 * Transforms an array of string 'field names' into a more readable format.
 * - Replaces '.' and '_' with a space.
 * - Capitalizes the first letter of each word.
 * - Converts the specific word 'id' to 'ID'.
 *
 * @param {!Array<string>} fieldArray An array of strings to format.
 * @return {!Array<string>} A new array with the formatted strings.
 */
function formatFieldNames(fieldArray) {
  if (!Array.isArray(fieldArray)) {
    return [];
  }
  return fieldArray.map(fieldStr => {
    if (typeof fieldStr !== 'string') {
      return fieldStr;
    }
    // Handle specific field name overrides
    if (fieldStr === 'customer.descriptive_name') {
      return 'Account';
    }
    if (fieldStr === 'campaign.name' || fieldStr === 'Campaign Name') {
      return 'Campaign';
    }
    const words = fieldStr.split(/[\._\s]/);
    const formattedWords = words.map(word => {
      if (word.length === 0) {
        return '';
      }
      if (word.toLowerCase() === 'id' || word.toLowerCase() === 'ai' || word.toLowerCase() === 'mcc') {
        return word.toUpperCase();
      }
      if (word.startsWith('(') && word.length > 1) {
        return '(' + word.charAt(1).toUpperCase() + word.slice(2).toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
    return formattedWords.join(' ');
  });
}
/**
 * Aggregates TimeSeriesKeyword data rows by Campaign Name and Date.
 * @param {!Array<!Array>} rows
 * @return {!Array<!Array>} Aggregated rows
 */
function aggregateCampaignRows(rows) {
    const groups = new Map();
    for (const item of rows) {
        const customerName = `${item.customer.descriptiveName || 'Unknown'} - ${item.customer.id || ''}`;
        const campaignName = (item.campaign.name && item.campaign.id) ? `${item.campaign.name} - ${item.campaign.id}` : (item.campaign.name || '');
        const date = item.segments.date;
        const impressions = item.metrics.impressions;
        const clicks = item.metrics.clicks;
        const conversions = item.metrics.conversions;
        const cost = item.metrics.costMicros;
        const conversionsValue = item.metrics.conversionsValue;
        const key = `${customerName}|${campaignName}|${date}`;
        if (!groups.has(key)) {
            groups.set(key, {
                customerName,
                campaignName,
                date,
                impressions: 0,
                clicks: 0,
                conversions: 0,
                cost: 0,
                conversionsValue: 0
            });
        }
        const currentGroup = groups.get(key);
        currentGroup.impressions += Number(impressions) || 0;
        currentGroup.clicks += Number(clicks) || 0;
        currentGroup.conversions += Number(conversions) || 0;
        currentGroup.cost += Number(cost) || 0;
        currentGroup.conversionsValue += Number(conversionsValue) || 0;
    }
    return groups;
}
/**
 * Custom Processor for TimeSeriesCampaign to flatten Asset Automation Settings.
 * Extracts: AI Max Enabled, Text Customization Status, Final URL Expansion Status.
 *
 * @param {!Array<!Object>} rows - An array of
 * 'Campaign' report rows from the Google Ads API.
 * @param {!Array<!Object>} kwRows - An array of keyword rows.
 * @param {!Array<!Object>} lpRows - An array of landing page rows.
 * @param {string|number} mcc - The Manager Account (MCC) ID to be prepended to
 * the output rows.
 * @return {!Array<!Array<string|number>>} A 2D array formatted for a
 * spreadsheet.
 */
function processTimeSeriesShoppingCampaign(rows, kwRows, lpRows, mcc) {
  const processedRows = [];
  const kwGroups = aggregateCampaignRows(kwRows);
  const lpGroups = aggregateCampaignRows(lpRows);
  for (const row of rows) {
    const customerName = `${row.customer.descriptiveName || 'Unknown'} - ${row.customer.id || ''}`;
    const date = row.segments.date;
    const campaignName = (row.campaign.name && row.campaign.id) ? `${row.campaign.name} - ${row.campaign.id}` : (row.campaign.name || '');
    let stmEnabled = 'No';
    const aiMaxSetting = row.campaign && (row.campaign.aiMaxSetting || row.campaign.ai_max_setting);
    if (aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    )) {
      stmEnabled = 'Yes';
    }
    const clicks = row.metrics.clicks;
    const impressions = row.metrics.impressions;
    const conversions = row.metrics.conversions;
    const cost = row.metrics.costMicros;
    const val = row.metrics.conversionsValue;
    const roas = row.metrics.costMicros > 0
     ? (row.metrics.conversionsValue / (row.metrics.costMicros / 1000000)) : 0;
    const groupKey = `${customerName}|${campaignName}|${date}`;
    const kwGroup = getGroupMetrics(kwGroups, groupKey);
    const lpGroup = getGroupMetrics(lpGroups, groupKey);
    const aimaxClicks = stmEnabled === 'Yes' ? clicks : 0;
    const aimaxImpressions = stmEnabled === 'Yes' ? impressions : 0;
    const aimaxConversions = stmEnabled === 'Yes' ? conversions : 0;
    const aimaxCost = stmEnabled === 'Yes' ? cost / 1000000 : 0;
    const aimaxVal = stmEnabled === 'Yes' ? val : 0;
    const aimaxroas = aimaxCost > 0 ? (aimaxVal / aimaxCost) : 0;
    const aikeywordCost = kwGroup.cost / 1000000;
    const aikeywordroas = aikeywordCost > 0 ? (kwGroup.conversionsValue / aikeywordCost) : 0;
    const ailandingpageCost = lpGroup.cost / 1000000;
    const ailandingpageroas = ailandingpageCost > 0 ? (lpGroup.conversionsValue / ailandingpageCost) : 0;
    processedRows.push([
        customerName,
        date,
        campaignName,
        stmEnabled,
        clicks,
        impressions,
        conversions,
        cost/1000000,
        val,
        roas,
        aimaxClicks,
        aimaxImpressions,
        aimaxConversions,
        aimaxCost,
        aimaxVal,
        aimaxroas,
        kwGroup.clicks,
        kwGroup.impressions,
        kwGroup.conversions,
        kwGroup.cost/1000000,
        kwGroup.conversionsValue,
        aikeywordroas,
        lpGroup.clicks,
        lpGroup.impressions,
        lpGroup.conversions,
        lpGroup.cost/1000000,
        lpGroup.conversionsValue,
        ailandingpageroas
    ]);
  }
  return processedRows;
}
/**
 * Custom Processor for TimeSeriesCampaign to flatten Asset Automation Settings.
 * Extracts: AI Max Enabled, Text Customization Status, Final URL Expansion Status.
 *
 * @param {!Array<!Object>} rows - An array of
 * 'Campaign' report rows from the Google Ads API.
 * @param {!Array<!Object>} kwRows - An array of keyword rows.
 * @param {!Array<!Object>} lpRows - An array of landing page rows.
 * @param {string|number} mcc - The Manager Account (MCC) ID to be prepended to
 * the output rows.
 * @return {!Array<!Array<string|number>>} A 2D array formatted for a
 * spreadsheet.
 */
function processTimeSeriesCampaign(rows, kwRows, lpRows, mcc) {
  const processedRows = [];
  const kwGroups = aggregateCampaignRows(kwRows);
  const lpGroups = aggregateCampaignRows(lpRows);
  for (const row of rows) {
    const customerName = `${row.customer.descriptiveName || 'Unknown'} - ${row.customer.id || ''}`;
    const date = row.segments.date;
    const campaignName = (row.campaign.name && row.campaign.id) ? `${row.campaign.name} - ${row.campaign.id}` : (row.campaign.name || '');
    let stmEnabled = 'No';
    const aiMaxSetting = row.campaign && (row.campaign.aiMaxSetting || row.campaign.ai_max_setting);
    if (aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    )) {
      stmEnabled = 'Yes';
    }
    const clicks = row.metrics.clicks;
    const impressions = row.metrics.impressions;
    const conversions = row.metrics.conversions;
    const cost = row.metrics.costMicros;
    const val = row.metrics.conversionsValue;
    const groupKey = `${customerName}|${campaignName}|${date}`;
    const kwGroup = getGroupMetrics(kwGroups, groupKey);
    const lpGroup = getGroupMetrics(lpGroups, groupKey);
    processedRows.push([
        customerName,
        date,
        campaignName,
        stmEnabled,
        clicks,
        impressions,
        conversions,
        cost/1000000,
        val,
        kwGroup.clicks + lpGroup.clicks,
        kwGroup.impressions + lpGroup.impressions,
        kwGroup.conversions + lpGroup.conversions,
        (kwGroup.cost + lpGroup.cost)/1000000,
        kwGroup.conversionsValue + lpGroup.conversionsValue,
        kwGroup.clicks,
        kwGroup.impressions,
        kwGroup.conversions,
        kwGroup.cost/1000000,
        kwGroup.conversionsValue,
        lpGroup.clicks,
        lpGroup.impressions,
        lpGroup.conversions,
        lpGroup.cost/1000000,
        lpGroup.conversionsValue
    ]);
  }
  return processedRows;
}
/**
 * Retrieves the group metrics for a given key, initializing it if not present.
 * @param {!Map<string, !Object>} groups The map of aggregated group metrics.
 * @param {string} key The unique key for the group.
 * @return {!Object} The group metrics object.
 */
function getGroupMetrics(groups, key) {
  if (!groups.has(key)) {
    groups.set(key, {
        impressions: 0,
        clicks: 0,
        conversions: 0,
        cost: 0,
        conversionsValue: 0
    });
  }
  return groups.get(key);
}
/**
 * Aggregates search term report data by search term and match type.
 *
 * This function processes raw search term view rows from the Google Ads API,
 * aggregates metrics (clicks, cost, conversions, conversion value) for each
 * unique search term, and pivots the data to show metrics broken down by
 * each search term match type (e.g., BROAD, PHRASE, EXACT).
 *
 * It filters out search terms that do not meet a minimum click threshold
 * defined in `Config.SEARCH_TERMS_CLICKS_THRESHOLD`.
 *
 * The final output is an array of arrays, ready to be inserted into a
 * Google Sheet, with the first row being the headers.
 *
 * @param {!Array<!Object>} searchTermRows - An array of
 * 'campaignSearchTermView' report rows from the Google Ads API.
 * @param {string|number} mcc - The Manager Account (MCC) ID to be prepended to
 * the output rows.
 * @param {string} sheetName - The name of the sheet being processed.
 * @return {!Array<!Array<string|number>>} A 2D array formatted for a
 * spreadsheet.
 */
/**
 * Processes a single search term row and adds it to the aggregated data.
 * @param {!Object} item The raw row object.
 * @param {!Map} aggregatedData The Map to store aggregated data.
 * @param {string} mcc The MCC ID.
 * @param {string} sheetName The name of the sheet.
 */
function processSearchTermRow(item, aggregatedData, mcc, sheetName) {
  const searchTerm = item.campaignSearchTermView.searchTerm;
  const matchType = item.segments.searchTermMatchType;
  const metrics = item.metrics;
  const customerName = `${item.customer.descriptiveName || 'Unknown'} - ${item.customer.id || ''}`;
  const segmentDate = (item.segments && item.segments.date) || '';
  const campaignId = (item.campaign && item.campaign.id) || '';
  const campaignName = (item.campaign && item.campaign.name && item.campaign.id) ? `${item.campaign.name} - ${campaignId}` : ((item.campaign && item.campaign.name) || '');
  const adGroupId = (item.adGroup && item.adGroup.id) || '';
  const adGroupName = (item.adGroup && item.adGroup.name) || '';
  const adGroupString = adGroupId ? `${adGroupId} - ${adGroupName}` : '';
  let stmEnabled = 'No';
  const aiMaxSetting = item.campaign && (item.campaign.aiMaxSetting || item.campaign.ai_max_setting);
    if (aiMaxSetting && (
      aiMaxSetting.enableAiMax === true ||
      aiMaxSetting.enable_ai_max === true ||
      aiMaxSetting.enableAiMax === 'true' ||
      aiMaxSetting.enable_ai_max === 'true'
    )) {
      stmEnabled = 'Yes';
    }
  let uniqueKey;
  if (sheetName === SHEETNAMES.SHOPPING_SEARCH_TERMS_OVERVIEW) {
    uniqueKey = `${mcc}|${customerName}|${campaignName}|${adGroupString}|${searchTerm}`;
  } else {
    uniqueKey = `${mcc}|${customerName}|${segmentDate}|${campaignName}|${searchTerm}`;
  }
  if (!aggregatedData.has(uniqueKey)) {
    const metricsByMatchType = {};
    for (const type of ALL_MATCH_TYPES) {
      metricsByMatchType[type] =
          {clicks: 0, cost: 0, conversions: 0, conversionsValue: 0, impressions: 0};
    }
    aggregatedData.set(uniqueKey, {
      mcc,
      customerName,
      segmentDate,
      campaignName,
      adGroup: adGroupString,
      stmEnabled,
      searchTerm,
      totalClicks: 0,
      totalImpressions: 0,
      metricsByMatchType,
    });
  }
  const currentEntry = aggregatedData.get(uniqueKey);
  const clicks = parseInt(metrics.clicks || '0', 10);
  const impressions = parseInt(metrics.impressions || '0', 10);
  currentEntry.totalClicks += clicks;
  currentEntry.totalImpressions += impressions;
  if (currentEntry.metricsByMatchType[matchType]) {
    currentEntry.metricsByMatchType[matchType].clicks += clicks;
    currentEntry.metricsByMatchType[matchType].cost +=
        (parseInt(metrics.costMicros || '0', 10) / 1000000);
    currentEntry.metricsByMatchType[matchType].conversions +=
        (metrics.conversions || 0);
    currentEntry.metricsByMatchType[matchType].conversionsValue +=
        (metrics.conversionsValue || 0);
    currentEntry.metricsByMatchType[matchType].impressions += impressions;
  }
}
/**
 * Finalizes the aggregated search term data into a 2D array.
 * @param {!Map} aggregatedData The aggregated data.
 * @param {string} sheetName The name of the sheet.
 * @return {!Array<!Array<string|number>>} 2D array for the sheet.
 */
function finalizeSearchTermView(aggregatedData, sheetName) {
  const finalResult = [GaqlQueries[sheetName].headers];
  for (const data of aggregatedData.values()) {
    if (data.totalClicks > Config.SEARCH_TERMS_CLICKS_THRESHOLD) {
      if (sheetName === SHEETNAMES.SHOPPING_SEARCH_TERMS_OVERVIEW) {
        for (const type of ALL_MATCH_TYPES) {
          const typeMetrics = data.metricsByMatchType[type];
          if (typeMetrics.clicks > 0 || typeMetrics.impressions > 0 || typeMetrics.cost > 0 || typeMetrics.conversions > 0 || typeMetrics.conversionsValue > 0) {
            finalResult.push([
              data.mcc,
              data.customerName,
              data.campaignName,
              data.adGroup,
              data.stmEnabled,
              data.searchTerm,
              type,
              typeMetrics.clicks,
              parseFloat(typeMetrics.cost.toFixed(2)),
              typeMetrics.conversions,
              parseFloat(typeMetrics.conversionsValue.toFixed(2)),
              typeMetrics.impressions
            ]);
          }
        }
      } else {
        const row = [
          data.mcc,
          data.customerName,
          data.segmentDate,
          data.campaignName,
          data.stmEnabled,
          data.searchTerm,
          data.totalImpressions,
        ];
        for (const type of ALL_MATCH_TYPES) {
          const typeMetrics = data.metricsByMatchType[type];
          row.push(typeMetrics.clicks);
          row.push(parseFloat(typeMetrics.cost.toFixed(2)));
          row.push(typeMetrics.conversions);
          row.push(parseFloat(typeMetrics.conversionsValue.toFixed(2)));
          row.push(typeMetrics.impressions);
        }
        finalResult.push(row);
      }
    }
  }
  return finalResult;
}
/**
 * Aggregates search term metrics from a given array of rows.
 * @param {!Array<!Object>} searchTermRows Array of raw row objects.
 * @param {string|number} mcc The Manager Account (MCC) ID.
 * @param {string} sheetName The name of the sheet being processed.
 * @return {!Array<!Array<string|number>>} 2D array for the sheet.
 */
function getSearchTermView(searchTermRows, mcc, sheetName) {
  if (!Array.isArray(searchTermRows) || searchTermRows.length === 0) {
    return [];
  }
  const aggregatedData = new Map();
  for (const item of searchTermRows) {
    processSearchTermRow(item, aggregatedData, mcc, sheetName);
  }
  return finalizeSearchTermView(aggregatedData, sheetName);
}
/**
 * Aggregates search term metrics by streaming from the API.
 * @param {!AdsApp.Account} account The Google Ads account to query.
 * @param {string} query The GAQL query string.
 * @param {string|number} mcc The Manager Account (MCC) ID.
 * @param {string} sheetName The name of the sheet being processed.
 * @return {!Array<!Array<string|number>>} 2D array for the sheet.
 */
function getSearchTermViewStreamed(account, query, mcc, sheetName) {
  const aggregatedData = new Map();
  searchAdsApp(account, query, (item) => {
    processSearchTermRow(item, aggregatedData, mcc, sheetName);
  });
  return finalizeSearchTermView(aggregatedData, sheetName);
}
/**
 * Aggregates keyword and targeting expansion metrics at the campaign level.
 *
 * This function takes raw report data for keywords and targeting expansion
 * and combines them, grouped by campaign. It specifically isolates metrics
 * from "AI_MAX" match type keywords and targeting expansion to compare them
 * against the total campaign performance.
 *
 * The output is designed to show a side-by-side comparison of total campaign
 * metrics versus metrics generated by "broadening" features (AI_MAX +
 * Targeting Expansion).
 *
 * @param {!Array<!Object>} keywordRows - An array of 'keyword_view' report
 * rows.
 * @param {!Array<!Object>} targetingExpansionRows - An array of report rows
 * for targeting expansion.
 * @param {string|number} mcc - The Manager Account (MCC) ID to be prepended to
 * the output rows.
 * @return {!Array<!Array<string|number>>} A 2D array formatted for a
 *  spreadsheet.
 * - The first row contains headers (from `GaqlQueries.KeywordsView.headers`).
 * - Subsequent rows contain aggregated metrics per campaign.
 * - Returns an empty array `[]` if input arrays are invalid or empty.
 */
function getKeywordsView(keywordRows, targetingExpansionRows, mcc) {
  const aggregatedData = new Map();
  const initializeCampaign = (campaign, customerName) => {
    if (!aggregatedData.has(campaign.id)) {
      aggregatedData.set(campaign.id, {
        customerName: customerName,
        campaignName: (campaign.name && campaign.id) ? `${campaign.name} - ${campaign.id}` : (campaign.name || ''),
        targetingExpansionClicks: 0,
        aiMaxKeywordClicks: 0,
        totalKeywordClicks: 0,
        targetingExpansionCost: 0,
        aiMaxKeywordCost: 0,
        totalKeywordCost: 0,
        targetingExpansionConversions: 0,
        aiMaxKeywordConversions: 0,
        totalKeywordConversions: 0,
        targetingExpansionConversionsValue: 0,
        aiMaxKeywordConversionsValue: 0,
        totalKeywordConversionsValue: 0,
      });
    }
  };
  if (!Array.isArray(keywordRows) || keywordRows.length === 0) {
    return [];
  }
  if (!Array.isArray(targetingExpansionRows) ||
      targetingExpansionRows.length === 0) {
    return [];
  }
  for (const result of targetingExpansionRows) {
    const {customer, campaign, metrics} = result;
    initializeCampaign(campaign, `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`);
    const campaignEntry = aggregatedData.get(campaign.id);
    campaignEntry.targetingExpansionClicks += parseInt(metrics.clicks, 10) || 0;
    campaignEntry.targetingExpansionCost +=
        (parseInt(metrics.costMicros, 10) || 0) / 1000000;
    campaignEntry.targetingExpansionConversions +=
        parseFloat(metrics.conversions) || 0;
    campaignEntry.targetingExpansionConversionsValue +=
        parseFloat(metrics.conversionsValue);
  }
  for (const result of keywordRows) {
    const {customer, campaign, metrics, segments} = result;
    initializeCampaign(campaign, `${customer.descriptiveName || 'Unknown'} - ${customer.id || ''}`);
    const campaignEntry = aggregatedData.get(campaign.id);
    const currentKeywordClicks = parseInt(metrics.clicks, 10) || 0;
    const currentKeywordCost =
        (parseInt(metrics.costMicros, 10) || 0) / 1000000;
    const currentKeywordConversions = parseFloat(metrics.conversions) || 0;
    const currentKeywordConversionsValue =
        parseFloat(metrics.conversionsValue) || 0;
    campaignEntry.totalKeywordClicks += currentKeywordClicks;
    campaignEntry.totalKeywordCost += currentKeywordCost;
    campaignEntry.totalKeywordConversions += currentKeywordConversions;
    campaignEntry.totalKeywordConversionsValue +=
        currentKeywordConversionsValue;
    if (segments && segments.matchType === 'AI_MAX') {
      campaignEntry.aiMaxKeywordClicks += currentKeywordClicks;
      campaignEntry.aiMaxKeywordCost += currentKeywordCost;
      campaignEntry.aiMaxKeywordConversions += currentKeywordConversions;
      campaignEntry.aiMaxKeywordConversionsValue +=
          currentKeywordConversionsValue;
    }
  }
  const headers = [GaqlQueries.KeywordsView.headers];
  const result = headers.concat(
      Array.from(aggregatedData.values())
          .filter(data => (data.totalKeywordClicks + data.targetingExpansionClicks) !== 0)
          .map(
              data =>
                  [data.customerName,
                   data.campaignName,
                   data.totalKeywordClicks,
                   data.aiMaxKeywordClicks,
                   data.targetingExpansionClicks,
                   data.totalKeywordCost,
                   data.aiMaxKeywordCost,
                   data.targetingExpansionCost,
                   data.totalKeywordConversions,
                   data.aiMaxKeywordConversions,
                   data.targetingExpansionConversions,
                   data.totalKeywordConversionsValue,
                   data.aiMaxKeywordConversionsValue,
                   data.targetingExpansionConversionsValue,
  ]));
  return result;
}
/**
 * Converts an array of snake_case strings to camelCase.
 *
 * @param {!Array} arr The array of snake_case strings to convert.
 * @return {!Array} The resulting array of camelCase strings.
 */
function snakeToCamel(arr) {
  return arr.map(s => {
    // Use a regular expression to find all occurrences of an underscore
    // followed by a word character (e.g., "_a", "_1").
    // The 'g' flag ensures all matches are replaced, not just the first one.
    return s.replace(/(_\w)/g, (match) => {
      // 'match' will be the full matched string (e.g., "_c").
      // 'match[1]' is the second character (the "c").
      // We convert this character to uppercase and return it.
      return match[1].toUpperCase();
    });
  });
}
/**
 * Copies a Google Spreadsheet and store the url as script property.
 *
 * @param {string} sourceId - The ID of the spreadsheet to copy.
 * @param {!PropertiesService.Properties} scriptProperties object.
 * @return {string} The URL of the generated spreadsheet.
 */
function copySpreadsheetTemplate(sourceId, scriptProperties) {
  try {
    const sourceFile = DriveApp.getFileById(sourceId);
    const customerName = AdsApp.currentAccount().getName();
    const customerId = AdsApp.currentAccount().getCustomerId();
    const fileName = `[AI Maxima] - ${customerName} (${customerId})`;
    const newFile = sourceFile.makeCopy(fileName);
    const spreadsheetUrl = newFile.getUrl();
    console.log(`Successfully created Spreadsheet '${fileName}'.\nURL: ${spreadsheetUrl}`);
    scriptProperties.setProperty('aiMaximaSpreadsheetUrl', spreadsheetUrl);
    return spreadsheetUrl;
  } catch (e) {
    Logger.log('Error copying spreadsheet template...: ' + e.toString());
  }
}
/**
 * Generates and logs a Looker Studio report creation URL.
 *
 * @param {!SpreadsheetApp.Spreadsheet} spreadsheet The Google Spreadsheet
 * @return {string} The generated Looker Studio URL.
 */
function generateLookerStudioUrl(spreadsheet) {
  const baseUrl = "https://lookerstudio.google.com/reporting/create";
  const params = [];
  const spreadsheet_id = spreadsheet.getId();
  // 1. Add Report ID based on SEARCH_TABS_ONLY flag
  const isSearchOnly = Boolean(RunConfig.SEARCH_TABS_ONLY);
  const reportTemplateId = isSearchOnly
      ? (Config.LOOKER_STUDIO_SEARCH_ONLY_REPORT_TEMPLATE || Config.LOOKER_STUDIO_REPORT_TEMPLATE)
      : Config.LOOKER_STUDIO_REPORT_TEMPLATE;
  params.push(`c.reportId=${reportTemplateId}`);
  // Get all Metric Queries
  const sheetsToOverride = Object.keys(GaqlQueries);
  // Explicitly add 'DateRange' to the override list
  if (!sheetsToOverride.includes(SHEETNAMES.DATE_RANGE)) {
    sheetsToOverride.push(SHEETNAMES.DATE_RANGE);
  }
  // 2. Iterate through sheets and build params
  sheetsToOverride.forEach((sheetName) => {
    // If in search-only mode, skip shopping sheets
    if (isSearchOnly && isShoppingSheet(sheetName)) {
      return;
    }
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (sheet) {
      // Encode the sheet name to handle spaces safely (e.g., "Campaign Data" -> "Campaign%20Data")
      const safeAlias = encodeURIComponent(sheetName);
      const prefix = `ds.${safeAlias}`;
      params.push(`${prefix}.connector=googleSheets`);
      params.push(`${prefix}.spreadsheetId=${spreadsheet_id}`);
      params.push(`${prefix}.worksheetId=${sheet.getSheetId()}`);
      params.push(`${prefix}.refreshFields=false`);
      params.push(`${prefix}.datasourceName=${sheetName}`);
    }
  });
  // 3. Join with '&' and return
  return `${baseUrl}?${params.join('&')}`;
}
/**
 * Computes a salted SHA-256 hash of a string (e.g. Customer ID) and returns it as a lowercase hex string.
 * @param {string|number} input The input to hash.
 * @param {string=} salt Optional salt string.
 * @return {string} 64-character lowercase SHA-256 hex string.
 */
function hashSha256WithSalt(input, salt) {
  const cleanInput = String(input).replace(/-/g, '').trim();
  const saltedValue = cleanInput + (salt || '');
  const rawDigest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      saltedValue,
      Utilities.Charset.UTF_8);
  let hexString = '';
  for (let i = 0; i < rawDigest.length; i++) {
    let byteVal = rawDigest[i];
    if (byteVal < 0) {
      byteVal += 256;
    }
    let hex = byteVal.toString(16);
    if (hex.length === 1) {
      hex = '0' + hex;
    }
    hexString += hex;
  }
  return hexString;
}
/**
 * Calculates the telemetry campaign count or identifier based on the active CAMPAIGN_FILTER_MODE.
 * - 'TOP_N': Returns the configured TOP_N_COUNT (number).
 * - 'CUSTOM': Returns the count of selected campaigns in the array / map (number).
 * - 'ALL': Returns 'ALL'.
 *
 * @param {?AdsApp.Account=} account Optional single client account object if running in Single CID mode.
 * @return {number|string} The number of campaigns (for TOP_N/CUSTOM) or 'ALL'.
 */
function getTelemetryCampaignsCount(account) {
  const mode = RunConfig.CAMPAIGN_FILTER_MODE ? String(RunConfig.CAMPAIGN_FILTER_MODE).toUpperCase() : 'ALL';
  if (mode === 'TOP_N') {
    return (typeof RunConfig.TOP_N_COUNT === 'number' && RunConfig.TOP_N_COUNT > 0)
        ? RunConfig.TOP_N_COUNT
        : 5;
  } else if (mode === 'CUSTOM') {
    if (account) {
      // Single CID mode: count campaigns mapped for this specific account
      const customIds = getCustomCampaignIds(account);
      return customIds ? customIds.length : 0;
    } else {
      // MCC mode: count all unique campaign IDs across all accounts in CUSTOM_CAMPAIGN_MAP
      const customMap = RunConfig.CUSTOM_CAMPAIGN_MAP || {};
      const allIds = new Set();
      for (const key of Object.keys(customMap)) {
        const list = customMap[key] || [];
        list.forEach(id => {
          if (id && !isNaN(Number(id))) {
            allIds.add(String(id).trim());
          }
        });
      }
      return allIds.size;
    }
  } else {
    return 'ALL';
  }
}
/**
 * Sends telemetry data to Google Analytics 4 using the Measurement Protocol.
 * Only sends data when TELEMETRY_OPT_OUT is false.
 *
 * @param {string} actionType - 'Single_CID' or 'MCC'
 * @param {string} customerId - The Google Ads Customer ID to hash it further
 * @param {!SpreadsheetApp.Spreadsheet} spreadsheet - The Google Spreadsheet
 * @param {boolean=} optOut - Flag to decide whether to opt out of telemetry (default: false)
 * @param {(number|string)=} campaignsCount - Number of campaigns (for TOP_N/CUSTOM) or 'ALL'
 */
function trackAdoption(actionType, customerId, spreadsheet, optOut, campaignsCount) {
  if (optOut || RunConfig.TELEMETRY_OPT_OUT) {
    console.log('[Telemetry] TELEMETRY_OPT_OUT flag is true. Skipping GA4 adoption tracking.');
    return;
  }
  const cleanCid = String(customerId).replace(/-/g, '').trim();
  console.log("\n ---customerId (telemetry tracked): " + cleanCid);
  const userType = spreadsheet ? getExecutionUserType(spreadsheet) : 'External';
  console.log("Script executed by user type: " + userType);
  const runDate = Utilities.formatDate(new Date(), "Asia/Kolkata", "yyyy-MM-dd HH:mm:ss") + " IST";
  const measurementId = 'G-HJTBRM7GDM';
  const apiSecret = 'yARvDHsYTFyBAyrjbWAi2g';
  const hashedCid = hashSha256WithSalt(cleanCid, Config.TELEMETRY_SALT);
  const campaignsValue = (campaignsCount !== undefined && campaignsCount !== null)
      ? campaignsCount
      : getTelemetryCampaignsCount();
  const payload = {
    client_id: 'ai_maxima_script',
    events: [{
      name: 'script_execution',
      params: {
        action_type: actionType, // 'Single_CID' or 'MCC'
        c_ref: hashedCid, // Salted SHA-256 encoded CID
        campaigns_count: campaignsValue, // Number for TOP_N / CUSTOM, or 'ALL'
        campaign_filter_mode: RunConfig.CAMPAIGN_FILTER_MODE || 'ALL',
        channel_scope: RunConfig.SEARCH_TABS_ONLY ? 'SEARCH_ONLY' : 'ALL',
        version: 'v2.5',
        run_date: runDate,
        user_type: userType
      }
    }]
  };
  const options = {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  UrlFetchApp.fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`,
    options
  );
  console.log(`[Telemetry] GA4 telemetry event sent successfully (Campaigns: ${campaignsValue}, Hashed CID: ${hashedCid.substring(0, 10)}...).`);
}
/**
 * Determines if the execution is being run by a Google internal user.
 *
 * @param {!SpreadsheetApp.Spreadsheet} spreadsheet The Google Spreadsheet
 * @return {string} 'Internal' if the owner email ends with '@google.com',
 * otherwise 'External'.
 * @throws {Error} If the DriveApp fails to resolve the user email.
 */
function getExecutionUserType(spreadsheet) {
  try {
    const fileId = spreadsheet.getId();
    const file = DriveApp.getFileById(fileId);
    const ownerEmail = file.getOwner() ? file.getOwner().getEmail() : '';
    console.log("Drive Sheet Owner Email: " + ownerEmail);
    if (ownerEmail.toLowerCase().endsWith('@google.com')) {
      return 'Internal';
    }
  } catch (e) {
    console.log("Could not resolve user email via DriveApp: " + e.message);
  }
  return 'External';
}
/**
 * Updates the DateRange sheet with the start date, end date, account name, and campaign name
 * for all checked-in accounts.
 * @param {!SpreadsheetApp.Spreadsheet} spreadsheet The Google Spreadsheet object.
 * @param {string} startDate The start date for the range.
 * @param {string} endDate The end date for the range.
 * @param {!Array<!Array<string>>} customerSheetValues The values from the Customers sheet.
 * @return {number} Total count of unique active campaigns synced and processed.
 */
function updateDateRangeSheet(spreadsheet, startDate, endDate, customerSheetValues) {
  let dateSheet = spreadsheet.getSheetByName(SHEETNAMES.DATE_RANGE);
  if (!dateSheet) {
    dateSheet = spreadsheet.insertSheet(SHEETNAMES.DATE_RANGE);
  }
  dateSheet.clear();
  const outputRows = [];
  outputRows.push(['Start Date', 'End Date', 'Account', 'Campaign']);
  const mode = RunConfig.CAMPAIGN_FILTER_MODE ? String(RunConfig.CAMPAIGN_FILTER_MODE).toUpperCase() : 'ALL';
  const includedAccountIds = [];
  const customerNameMap = {};
  for (const row of customerSheetValues) {
    if (row[CustomerColumnMap.INCLUDE]) {
      const id = String(row[CustomerColumnMap.CUSTOMER_ID]).replace(/-/g, '').trim();
      if (id) {
        includedAccountIds.push(id);
        customerNameMap[id] = row[CustomerColumnMap.CUSTOMER_NAME];
      }
    }
  }
  if (includedAccountIds.length === 0) {
    dateSheet.getRange(1, 1, 1, 4).setValues(outputRows).setFontWeight('bold');
    return 0;
  }
  let accounts = [];
  if (typeof AdsManagerApp !== 'undefined') {
    const iter = AdsManagerApp.accounts().withIds(includedAccountIds).get();
    while (iter.hasNext()) {
      accounts.push(iter.next());
    }
  } else {
    accounts.push(AdsApp.currentAccount());
  }
  const uniqueCampaignIds = new Set();
  for (const account of accounts) {
    const cleanId = String(account.getCustomerId()).replace(/-/g, '').trim();
    let accountName = customerNameMap[cleanId];
    // If not found in map, or is just the ID, or starts with 'Unknown', try to get from account object
    if (!accountName || accountName === cleanId || accountName.startsWith('Unknown')) {
      accountName = '';
      if (typeof account.getName === 'function') {
        accountName = account.getName();
      } else if (typeof account.getDescriptiveName === 'function') {
        accountName = account.getDescriptiveName();
      }
    }
    // Absolute fallback if still empty or 'Unknown'
    if (!accountName || accountName === 'Unknown') {
      accountName = 'Unknown';
    }
    const accountStr = `${accountName} - ${cleanId}`;
    if (mode === 'CUSTOM') {
      const customIds = getCustomCampaignIds(account);
      if (customIds && customIds.length > 0) {
        const channelFilter = RunConfig.SEARCH_TABS_ONLY ? "AND campaign.advertising_channel_type = 'SEARCH'" : "";
        const query = `SELECT campaign.name, campaign.id FROM campaign WHERE campaign.id IN (${customIds.join(', ')}) ${channelFilter}`;
        const rows = searchAdsApp(account, query);
        for (const row of rows) {
          uniqueCampaignIds.add(String(row.campaign.id));
          outputRows.push([startDate, endDate, accountStr, `${row.campaign.name} - ${row.campaign.id}`]);
        }
      }
    } else if (mode === 'TOP_N') {
      const searchTop = getTopNCampaignIds(account, startDate, endDate, 'SEARCH');
      const shoppingTop = RunConfig.SEARCH_TABS_ONLY ? [] : getTopNCampaignIds(account, startDate, endDate, 'SHOPPING');
      const topCampaigns = searchTop.concat(shoppingTop);
      if (topCampaigns && topCampaigns.length > 0) {
        const campaignIds = topCampaigns.map(c => c.id);
        const query = `SELECT campaign.name, campaign.id FROM campaign WHERE campaign.id IN (${campaignIds.join(', ')})`;
        const rows = searchAdsApp(account, query);
        for (const row of rows) {
          uniqueCampaignIds.add(String(row.campaign.id));
          outputRows.push([startDate, endDate, accountStr, `${row.campaign.name} - ${row.campaign.id}`]);
        }
      }
    } else { // 'ALL'
      const channelTypes = RunConfig.SEARCH_TABS_ONLY ? "'SEARCH'" : "'SEARCH', 'SHOPPING'";
      const query = `SELECT campaign.name, campaign.id FROM campaign WHERE campaign.status = 'ENABLED' AND campaign.advertising_channel_type IN (${channelTypes})`;
      const rows = searchAdsApp(account, query);
      for (const row of rows) {
        uniqueCampaignIds.add(String(row.campaign.id));
        outputRows.push([startDate, endDate, accountStr, `${row.campaign.name} - ${row.campaign.id}`]);
      }
    }
  }
  if (outputRows.length > 1) {
    dateSheet.getRange(1, 1, outputRows.length, 4).setValues(outputRows);
    dateSheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  } else {
    dateSheet.getRange(1, 1, 1, 4).setValues(outputRows).setFontWeight('bold');
    dateSheet.getRange(2, 1, 1, 4).setValues([[startDate, endDate, '', '']]);
  }
  console.log(`Synchronized dates and ${uniqueCampaignIds.size} unique campaign(s) to DateRange sheet for dashboard display.`);
  return uniqueCampaignIds.size;
}
// unique script identifier: 1qN2Lyeiv2wpH111d1V-aqdRI6p52vowewxuVhz1PB9M
