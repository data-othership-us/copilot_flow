-- Confirmed Co-Pilot hybrid class sessions.
-- Replaced by syncHybridSessions from Hybrid Requests before the
-- performance view is applied. session_id is the Mariana Tek class session.
CREATE TABLE IF NOT EXISTS `YOUR_PROJECT.copilots.copilot_hybrid_sessions` (
  session_id STRING,
  contact_email STRING,
  promo_code STRING,
  updated_at TIMESTAMP
);
