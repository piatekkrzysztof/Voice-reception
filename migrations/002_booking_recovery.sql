-- A journalled confirmation survives hold expiry and process restarts.
ALTER TABLE voice_holds ADD COLUMN IF NOT EXISTS confirmation_json TEXT;
ALTER TABLE voice_holds ADD COLUMN IF NOT EXISTS provider_booking_uid TEXT;
CREATE INDEX IF NOT EXISTS voice_holds_recovery ON voice_holds(tenant_id, created_at)
  WHERE status = 'confirming';
CREATE INDEX IF NOT EXISTS voice_booking_resource_overlap ON voice_bookings(tenant_id, start_at, end_at)
  WHERE status = 'confirmed';
