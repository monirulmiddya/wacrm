-- ============================================================
-- 013_background_jobs_queue.sql
--
-- Background job queue for async automation/flow dispatch.
-- Webhooks enqueue jobs and return 200 OK immediately.
-- A cron endpoint processes the queue on a schedule.
--
-- Architecture:
--   1. Webhook calls enqueueAutomationJob() → job created with status='pending'
--   2. Webhook returns 200 OK without waiting
--   3. Cron endpoint calls /api/jobs/process
--   4. Endpoint claims a batch of jobs (status='pending' → 'processing')
--   5. Processes each job, updates status='success' or 'failed'
--
-- Indexes: (user_id, status) for fast filtering
-- Retention: 7 days (automated by a separate cleanup cron if needed)
-- ============================================================

-- Table to hold job metadata
CREATE TABLE IF NOT EXISTS background_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL, -- 'automation_trigger' | 'flow_dispatch'
  status TEXT NOT NULL DEFAULT 'pending', -- pending | processing | success | failed
  payload JSONB NOT NULL, -- Contains all data needed to execute the job
  error_message TEXT,
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  claimed_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  CHECK (status IN ('pending', 'processing', 'success', 'failed'))
);

-- Indexes for fast job querying
CREATE INDEX IF NOT EXISTS idx_background_jobs_user_status 
  ON background_jobs(user_id, status) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_background_jobs_status_created 
  ON background_jobs(status, created_at DESC) WHERE status = 'pending';

-- Enable RLS
ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own jobs (for debugging)
CREATE POLICY "Users can view their own jobs"
  ON background_jobs
  FOR SELECT
  USING (auth.uid() = user_id);

-- Service role can do everything (for internal processing)
CREATE POLICY "Service role can manage all jobs"
  ON background_jobs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Function to enqueue an automation trigger
CREATE OR REPLACE FUNCTION enqueue_automation_job(
  p_user_id UUID,
  p_trigger_type TEXT,
  p_contact_id UUID,
  p_context JSONB
)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO background_jobs (user_id, job_type, payload)
  VALUES (
    p_user_id,
    'automation_trigger',
    jsonb_build_object(
      'trigger_type', p_trigger_type,
      'contact_id', p_contact_id,
      'context', p_context
    )
  )
  RETURNING id;
$$;

-- Function to enqueue a flow dispatch
CREATE OR REPLACE FUNCTION enqueue_flow_job(
  p_user_id UUID,
  p_contact_id UUID,
  p_conversation_id UUID,
  p_message JSONB,
  p_is_first_inbound_message BOOLEAN
)
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO background_jobs (user_id, job_type, payload)
  VALUES (
    p_user_id,
    'flow_dispatch',
    jsonb_build_object(
      'contact_id', p_contact_id,
      'conversation_id', p_conversation_id,
      'message', p_message,
      'is_first_inbound_message', p_is_first_inbound_message
    )
  )
  RETURNING id;
$$;

-- Revoke direct access; only service role can enqueue
REVOKE ALL ON FUNCTION enqueue_automation_job(UUID, TEXT, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_automation_job(UUID, TEXT, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION enqueue_automation_job(UUID, TEXT, UUID, JSONB) TO service_role;

REVOKE ALL ON FUNCTION enqueue_flow_job(UUID, UUID, UUID, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_flow_job(UUID, UUID, UUID, JSONB, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION enqueue_flow_job(UUID, UUID, UUID, JSONB, BOOLEAN) TO service_role;
