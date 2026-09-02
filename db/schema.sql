-- SPEC §6 schema；以 [P1] 標記的欄位是本階段新增（見 DECISIONS.md）
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY, symbol TEXT, name TEXT, decimals INTEGER,
  kind TEXT, rh_asset_id TEXT, rh_status TEXT, all_day_tradable TEXT,
  current_multiplier TEXT,           -- [P1] /assets currentMultiplier，比對價格前要乘
  raw TEXT,                          -- [P1] /assets 原文 JSON（含 tradingCapabilities）
  first_seen TEXT
);
CREATE TABLE IF NOT EXISTS pools (
  pool_id TEXT PRIMARY KEY, protocol TEXT, token0 TEXT REFERENCES tokens, token1 TEXT REFERENCES tokens,
  fee_ppm INTEGER, tick_spacing INTEGER, hooks TEXT, created_block INTEGER, created_at TEXT,
  quote_kind TEXT,
  stock_is_token0 INTEGER            -- [P1] 1 = 股票代幣是 currency0；price_usd 一律為「股票代幣 / USDG」
);
CREATE TABLE IF NOT EXISTS pool_snapshots (
  pool_id TEXT REFERENCES pools, date TEXT, is_weekday INTEGER,
  tvl_usd REAL, volume_24h_usd REAL, fees_24h_usd REAL, price_usd REAL, price_ref_usd REAL, price_dev_pct REAL,
  swap_count INTEGER, trader_count INTEGER, top1_share REAL, pingpong_ratio REAL, lp_trader_overlap INTEGER,
  lp_overlap_volume_share REAL,      -- [P1] DECISIONS C2
  age_days INTEGER, vol7_avg_usd REAL, vol7_cv REAL,
  raw_apr REAL,                      -- [P1] fees_24h*365/tvl，P1 摘要排序用
  sim TEXT, score REAL, flags TEXT, excluded INTEGER DEFAULT 0,
  PRIMARY KEY (pool_id, date)
);
CREATE TABLE IF NOT EXISTS pool_hourly (
  pool_id TEXT, ts INTEGER, price_usd REAL, volume_usd REAL, fees_usd REAL, tvl_usd REAL,
  liquidity TEXT,                    -- [P1] 該小時最後一筆 Swap 的 liquidity（uint128 字串），DECISIONS D1
  swap_count INTEGER,
  PRIMARY KEY (pool_id, ts)
);
CREATE TABLE IF NOT EXISTS corporate_actions (
  id TEXT PRIMARY KEY, token TEXT, type TEXT, status TEXT, effective_at TEXT, pending_multiplier TEXT, raw TEXT
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY, pool_id TEXT, label TEXT, range_lower REAL, range_upper REAL,
  deposit_usd REAL, deposit_token0 REAL, deposit_token1 REAL, opened_at TEXT, closed_at TEXT, notes TEXT
);
CREATE TABLE IF NOT EXISTS position_snapshots (
  position_id INTEGER, date TEXT, value_usd REAL, fees_cum_usd REAL, in_range INTEGER, gas_cum_usd REAL,
  PRIMARY KEY (position_id, date)
);
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY, started_at TEXT, finished_at TEXT, ok INTEGER,
  pools_scanned INTEGER, api_calls TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);  -- [P1] last_discovery_block 等
CREATE INDEX IF NOT EXISTS idx_snap_date ON pool_snapshots(date);
CREATE INDEX IF NOT EXISTS idx_hourly_pool_ts ON pool_hourly(pool_id, ts);
