import { NextResponse } from 'next/server'
import { processPendingJobs } from '@/lib/background-jobs/queue'

/**
 * Process pending background jobs (automations & flows).
 * Meant to be hit on a schedule (Vercel Cron / external pinger).
 * Requires shared secret via `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * This is separate from /api/automations/cron which handles only
 * automation wait-step resumptions. This handles the async dispatch queue.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }

  const supplied = request.headers.get('x-cron-secret')
  if (supplied !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { processed, failed } = await processPendingJobs(25)
    return NextResponse.json({ processed, failed })
  } catch (err) {
    console.error('[jobs-cron] process failed:', err)
    return NextResponse.json(
      { error: 'Processing failed', details: String(err) },
      { status: 500 },
    )
  }
}
