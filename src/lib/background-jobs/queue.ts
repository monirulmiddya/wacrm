import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import type { AutomationContext, DispatchInput } from '@/lib/automations/engine'
import type { DispatchInboundInput } from '@/lib/flows/types'

/**
 * Job queue utilities for async automation/flow processing.
 * Webhooks enqueue jobs and return 200 OK immediately.
 * Cron endpoint processes the queue on a schedule.
 */

interface AutomationJobPayload {
  trigger_type: string
  contact_id: string | null
  context: AutomationContext
}

interface FlowJobPayload {
  contact_id: string
  conversation_id: string
  message: Record<string, unknown>
  is_first_inbound_message: boolean
}

interface BackgroundJob {
  id: string
  user_id: string
  job_type: 'automation_trigger' | 'flow_dispatch'
  status: 'pending' | 'processing' | 'success' | 'failed'
  payload: AutomationJobPayload | FlowJobPayload
  error_message: string | null
  attempts: number
  max_attempts: number
  created_at: string
  claimed_at: string | null
  completed_at: string | null
}

/**
 * Enqueue an automation trigger for async processing.
 * Called from the webhook to avoid blocking.
 */
export async function enqueueAutomationJob(
  userId: string,
  triggerType: string,
  contactId: string | null,
  context: AutomationContext,
): Promise<string | null> {
  try {
    const db = supabaseAdmin()
    const { data: jobId, error } = await db.rpc('enqueue_automation_job', {
      p_user_id: userId,
      p_trigger_type: triggerType,
      p_contact_id: contactId,
      p_context: context ?? {},
    })

    if (error) {
      console.error('[queue] enqueue automation failed:', error)
      return null
    }
    return jobId
  } catch (err) {
    console.error('[queue] enqueue automation exception:', err)
    return null
  }
}

/**
 * Enqueue a flow dispatch for async processing.
 * Called from the webhook to avoid blocking.
 */
export async function enqueueFlowJob(
  userId: string,
  contactId: string,
  conversationId: string,
  message: Record<string, unknown>,
  isFirstInboundMessage: boolean,
): Promise<string | null> {
  try {
    const db = supabaseAdmin()
    const { data: jobId, error } = await db.rpc('enqueue_flow_job', {
      p_user_id: userId,
      p_contact_id: contactId,
      p_conversation_id: conversationId,
      p_message: message,
      p_is_first_inbound_message: isFirstInboundMessage,
    })

    if (error) {
      console.error('[queue] enqueue flow failed:', error)
      return null
    }
    return jobId
  } catch (err) {
    console.error('[queue] enqueue flow exception:', err)
    return null
  }
}

/**
 * Process a batch of pending jobs.
 * Called from cron endpoint.
 * Returns count of successfully processed jobs.
 */
export async function processPendingJobs(
  batchSize: number = 25,
): Promise<{ processed: number; failed: number }> {
  const db = supabaseAdmin()

  // Fetch pending jobs (oldest first)
  const { data: jobs, error: fetchErr } = await db
    .from('background_jobs')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (fetchErr) {
    console.error('[queue] fetch pending jobs failed:', fetchErr)
    return { processed: 0, failed: 0 }
  }

  if (!jobs || jobs.length === 0) {
    return { processed: 0, failed: 0 }
  }

  let processed = 0
  let failed = 0

  for (const job of jobs as unknown as BackgroundJob[]) {
    const { data: claimed } = await db
      .from('background_jobs')
      .update({
        status: 'processing',
        claimed_at: new Date().toISOString(),
      })
      .eq('id', job.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()

    if (!claimed) {
      // Another cron instance already claimed this job
      continue
    }

    try {
      if (job.job_type === 'automation_trigger') {
        const payload = job.payload as AutomationJobPayload
        await runAutomationsForTrigger({
          userId: job.user_id,
          triggerType: payload.trigger_type as any,
          contactId: payload.contact_id,
          context: payload.context,
        })
      } else if (job.job_type === 'flow_dispatch') {
        const payload = job.payload as FlowJobPayload
        await dispatchInboundToFlows({
          userId: job.user_id,
          contactId: payload.contact_id,
          conversationId: payload.conversation_id,
          message: payload.message as any,
          isFirstInboundMessage: payload.is_first_inbound_message,
        })
      }

      // Mark as successful
      const { error: updateErr } = await db
        .from('background_jobs')
        .update({
          status: 'success',
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)

      if (!updateErr) {
        processed++
      } else {
        console.error('[queue] mark success failed:', updateErr)
        failed++
      }
    } catch (err) {
      console.error('[queue] job execution failed:', job.id, err)

      // Retry logic: increment attempts and re-queue if under max_attempts
      if (job.attempts < job.max_attempts - 1) {
        const { error: retryErr } = await db
          .from('background_jobs')
          .update({
            status: 'pending',
            attempts: job.attempts + 1,
            error_message: String(err),
          })
          .eq('id', job.id)

        if (!retryErr) {
          // Will be retried on next cron run
          continue
        }
      }

      // Mark as failed (max retries exceeded or retry queue update failed)
      const { error: failErr } = await db
        .from('background_jobs')
        .update({
          status: 'failed',
          error_message: String(err),
          attempts: job.attempts + 1,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)

      if (!failErr) {
        failed++
      }
    }
  }

  return { processed, failed }
}
