# Background Job Queue Setup

This document explains how to set up and configure the background job queue system for automations and flows.

## Why This Exists

Vercel's free tier serverless functions have a **10-second timeout**. Without the queue:
- Multiple automations would run sequentially in the webhook
- Each Meta API call (sending messages) adds 500-1500ms of latency
- Large automations easily exceed 10 seconds = timeout = no response

**Solution:** Webhook enqueues jobs and returns 200 OK immediately. A scheduled cron job processes the queue asynchronously.

## Architecture

```
Webhook Request
    ↓
1. Store inbound message
2. Enqueue automation/flow jobs
3. Return 200 OK (fast!)
    ↓
Cron Job (runs every 5-10 mins)
    ↓
Process pending background_jobs
    ↓
Execute automations (send messages, wait steps, etc.)
```

## Environment Variables

Add these to your `.env.local` (development) or Vercel deployment settings (production):

```bash
# Required: Secret for the background jobs cron endpoint
BACKGROUND_JOBS_CRON_SECRET=your-secure-random-string

# Optional: existing automation cron secret (for wait-step resumptions)
AUTOMATION_CRON_SECRET=your-other-secure-random-string
```

Generate secure secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Cron Configuration

Two separate cron jobs are now needed:

### 1. Background Jobs Processor (NEW - for this PR)
**Endpoint:** `GET /api/jobs/process`  
**Frequency:** Every 5 minutes  
**Header:** `x-cron-secret: <BACKGROUND_JOBS_CRON_SECRET>`

**Vercel cron.json:**
```json
{
  "crons": [
    {
      "path": "/api/jobs/process",
      "schedule": "*/5 * * * *"
    }
  ]
}
```

**External cron (e.g., EasyCron, Uptime Robot):**
```
GET https://your-domain.com/api/jobs/process
Header: x-cron-secret: YOUR_SECRET
```

### 2. Automation Wait-Step Resumption (EXISTING - don't remove)
**Endpoint:** `GET /api/automations/cron`  
**Frequency:** Every 5 minutes  
**Header:** `x-cron-secret: <AUTOMATION_CRON_SECRET>`

This handles resuming automations from `wait` steps — keep this running.

## Database Changes

A new migration (`013_background_jobs_queue.sql`) creates:
- `background_jobs` table (stores job metadata)
- `enqueue_automation_job()` function
- `enqueue_flow_job()` function
- RLS policies for security

Run migrations:
```bash
npx supabase migration up
```

Or manually in Supabase SQL editor:
```sql
-- Paste contents of supabase/migrations/013_background_jobs_queue.sql
```

## Job Status Flow

```
pending  →  processing  →  success
              ↓
            (error)  →  pending (retry)  OR  failed (if max retries exceeded)
```

- **pending:** Waiting to be processed
- **processing:** Claimed by a cron worker, currently executing
- **success:** Completed successfully
- **failed:** Max retries exceeded or fatal error
- **attempts:** Incremented each time; max 3 attempts per job

## Monitoring

### Check pending jobs
```sql
SELECT COUNT(*) FROM background_jobs WHERE status = 'pending';
```

### View failed jobs
```sql
SELECT * FROM background_jobs WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10;
```

### See job history
```sql
SELECT user_id, job_type, status, error_message, created_at 
FROM background_jobs 
WHERE created_at > NOW() - INTERVAL '1 day'
ORDER BY created_at DESC;
```

## Troubleshooting

### Jobs stuck in "processing"
If a job is claimed but never completes:
- Verify the cron job is running (check Vercel logs)
- Look for errors in the job's `error_message` column
- Manually update `status='pending'` to retry:
  ```sql
  UPDATE background_jobs 
  SET status='pending', claimed_at=NULL 
  WHERE status='processing' AND claimed_at < NOW() - INTERVAL '10 minutes';
  ```

### No jobs being processed
- Check `BACKGROUND_JOBS_CRON_SECRET` matches webhook request
- Verify cron endpoint is being called (check application logs)
- Ensure database migration has been applied

### Jobs failing repeatedly
- Check `error_message` column for the specific error
- Common causes:
  - User doesn't exist (deleted account)
  - Automation was deleted
  - Contact/conversation doesn't exist
  - Meta API rate limit hit

## Performance Tuning

**Batch size:** Edit `src/app/api/jobs/process/route.ts`
```typescript
processPendingJobs(50)  // Process 50 jobs per cron run instead of 25
```

**Cron frequency:** More frequent = faster job processing but higher database load
```json
"schedule": "*/2 * * * *"  // Run every 2 minutes
```

**Max retries:** Edit `src/lib/background-jobs/queue.ts`
```typescript
max_attempts: 5  // Instead of 3
```

## Backward Compatibility

- Existing `automation_pending_executions` table (for wait steps) is unchanged
- Both systems coexist peacefully
- No breaking changes to automation/flow APIs

## Future Improvements

- [ ] Exponential backoff for retries (instead of immediate retry)
- [ ] Dead letter queue for systematically failing jobs
- [ ] Webhook/notification system when jobs fail
- [ ] Admin dashboard to view queue stats
- [ ] Support for scheduled jobs (not just immediate processing)
