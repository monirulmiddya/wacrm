# 🚀 Background Job Queue - Quick Setup Checklist

Your webhook timeout issue is now fixed! Follow these steps to activate the queue:

## ✅ Step 1: Add Environment Variable to Vercel

1. Go to [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your **wacrm** project
3. Click **Settings** → **Environment Variables**
4. Add new variable:
   - **Name:** `BACKGROUND_JOBS_CRON_SECRET`
   - **Value:** (generate a secure random string - paste this in terminal:)
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - **Environments:** Production + Preview
5. Click **Save** and **Redeploy**

## ✅ Step 2: Run Database Migration

**Option A: Via Supabase CLI (Recommended)**
```bash
npx supabase migration up
```

**Option B: Manual SQL in Supabase Console**
1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your database
3. Go to **SQL Editor** → **New Query**
4. Copy-paste the contents of `supabase/migrations/013_background_jobs_queue.sql`
5. Click **Run**

## ✅ Step 3: Deploy Code Changes

```bash
git add -A
git commit -m "feat: add background job queue for async automation/flow processing"
git push origin main
```

Vercel will auto-deploy. Your `vercel.json` already includes the new cron job.

## ✅ Step 4: Verify Setup

### Test 1: Check if cron job is running
1. Go to Vercel Dashboard → **Deployments** → Current deployment
2. Scroll to **Cron Jobs** section
3. You should see:
   - `/api/jobs/process` ✅ (NEW - for this queue)
   - `/api/automations/cron` ✅ (existing)
   - `/api/flows/cron` ✅ (existing)

### Test 2: Trigger a test automation
1. Go to your wacrm dashboard
2. Create a test automation (or use existing)
3. Send a message via WhatsApp that matches the trigger
4. Check Supabase:
   ```sql
   SELECT * FROM background_jobs WHERE status='pending' LIMIT 5;
   ```
   You should see a new job!

### Test 3: Watch it process
Wait 5 minutes for the cron to run, then:
```sql
SELECT * FROM background_jobs WHERE job_type='automation_trigger' ORDER BY created_at DESC LIMIT 10;
```
Jobs should show `status='success'` and `completed_at` timestamp.

## 🐛 Troubleshooting

**No jobs appearing in database?**
- Confirm migration ran successfully:
  ```sql
  SELECT * FROM background_jobs LIMIT 1;  -- should not error
  ```

**Jobs stuck in "pending"?**
- Check if `/api/jobs/process` is being called:
  - Go to Vercel → Deployments → Current → Function Log
  - Filter for `jobs/process`
  - Should see requests every 5 minutes
  
- Verify env var is set correctly:
  ```sql
  SELECT * FROM background_jobs WHERE status='failed' LIMIT 1;
  ```
  Check the `error_message` column

**Still timing out?**
- Run `SELECT COUNT(*) FROM background_jobs WHERE status='processing'`
- If many jobs stuck there, jobs are taking >5 mins to complete
- Increase cron frequency in `vercel.json`:
  ```json
  "schedule": "*/2 * * * *"  // Every 2 mins instead of 5
  ```

## 📊 Monitor Queue Health

Add this to your dashboard or monitoring:

```sql
-- Jobs waiting to process
SELECT COUNT(*) as pending_count FROM background_jobs WHERE status='pending';

-- Failed jobs (last 24h)
SELECT COUNT(*) as failed_count FROM background_jobs 
WHERE status='failed' AND created_at > NOW() - INTERVAL '1 day';

-- Average processing time
SELECT AVG(EXTRACT(EPOCH FROM (completed_at - claimed_at))) as avg_seconds
FROM background_jobs 
WHERE status='success' AND completed_at > NOW() - INTERVAL '1 day';
```

## 📚 More Info

See [docs/BACKGROUND_JOBS_QUEUE.md](../docs/BACKGROUND_JOBS_QUEUE.md) for:
- Full architecture explanation
- Performance tuning
- Advanced troubleshooting
- Future improvements

---

**That's it!** Your webhooks now return 200 OK immediately, and automations/flows process asynchronously. No more timeout issues on Vercel free tier. 🎉
