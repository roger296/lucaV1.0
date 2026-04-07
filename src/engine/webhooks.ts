import { createHmac } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db/connection';
import { config } from '../config';

// ---------------------------------------------------------------------------
// webhooks.ts — Webhook event publishing and delivery engine
// ---------------------------------------------------------------------------

export type WebhookEventType =
  | 'TRANSACTION_POSTED'
  | 'TRANSACTION_STAGED'
  | 'TRANSACTION_APPROVED'
  | 'TRANSACTION_REJECTED'
  | 'PERIOD_OPENED'
  | 'PERIOD_SOFT_CLOSED'
  | 'PERIOD_CLOSED'
  | 'APPROVAL_ESCALATED';

// ── Publish event (non-blocking fire-and-forget) ──────────────────────────

export function publishEvent(eventType: WebhookEventType, data: object): void {
  setImmediate(() => {
    void deliverEvent(eventType, data).catch((err: unknown) => {
      console.error('[webhooks] Error delivering event:', err);
    });
  });
}

// ── Internal: deliver event to all active subscribers ────────────────────

async function deliverEvent(eventType: WebhookEventType, data: object): Promise<void> {
  const subscriptions = await db('webhook_subscriptions')
    .where('is_active', true)
    .whereRaw('? = ANY(event_types)', [eventType])
    .select('*');

  if (!subscriptions || subscriptions.length === 0) return;

  const eventId = uuidv4();
  const timestamp = new Date().toISOString();

  const payload = {
    event_id: eventId,
    event_type: eventType,
    timestamp,
    data,
  };

  for (const sub of subscriptions as Array<Record<string, unknown>>) {
    const subscriptionId = sub['id'] as string;
    const secret = sub['secret'] as string;
    const callbackUrl = sub['callback_url'] as string;

    const [deliveryRow] = await db('webhook_deliveries')
      .insert({
        subscription_id: subscriptionId,
        event_type: eventType,
        payload: JSON.stringify(payload),
        status: 'PENDING',
        attempts: 0,
      })
      .returning('id');

    const deliveryId = (deliveryRow as Record<string, unknown>)['id'] as string;

    await deliverToSubscription(subscriptionId, secret, callbackUrl, payload, deliveryId);
  }
}

// ── Internal: attempt delivery to one subscription ────────────────────────

async function deliverToSubscription(
  subscriptionId: string,
  subscriptionSecret: string,
  callbackUrl: string,
  payload: object,
  deliveryId: string,
): Promise<void> {
  const payloadStr = JSON.stringify(payload);
  const signature = signPayload(payloadStr, subscriptionSecret);

  let responseStatus: number | null = null;
  let lastError: string | null = null;
  let delivered = false;

  try {
    const resp = await fetch(callbackUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GL-Signature': signature,
        'X-GL-Event': (payload as Record<string, unknown>)['event_type'] as string,
        'X-GL-Delivery': deliveryId,
      },
      body: payloadStr,
      signal: AbortSignal.timeout(10_000),
    });

    responseStatus = resp.status;
    delivered = resp.ok;
  } catch (err: unknown) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  if (delivered) {
    await db('webhook_deliveries').where('id', deliveryId).update({
      status: 'DELIVERED',
      attempts: 1,
      last_attempt_at: new Date().toISOString(),
      last_response_status: responseStatus,
    });
    await db('webhook_subscriptions')
      .where('id', subscriptionId)
      .update({ last_delivery_at: new Date().toISOString(), failure_count: 0 });
  } else {
    await db('webhook_deliveries').where('id', deliveryId).update({
      status: 'RETRYING',
      attempts: 1,
      last_attempt_at: new Date().toISOString(),
      last_response_status: responseStatus,
      last_error: lastError,
    });
    await db('webhook_subscriptions').where('id', subscriptionId).increment('failure_count', 1);
  }
}

// ── Sign payload ──────────────────────────────────────────────────────────

export function signPayload(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

// ── Process retry queue ───────────────────────────────────────────────────

export async function processRetryQueue(): Promise<void> {
  const maxAttempts = config.webhooks.maxRetryAttempts;
  const retryDelays = config.webhooks.retryDelaysMs;
  const now = new Date();

  const retryRows = await db('webhook_deliveries')
    .where('status', 'RETRYING')
    .where('attempts', '<', maxAttempts)
    .select('*');

  for (const rawRow of retryRows as Array<Record<string, unknown>>) {
    const attempts = (rawRow['attempts'] as number) ?? 0;
    const lastAttemptAt = rawRow['last_attempt_at']
      ? new Date(rawRow['last_attempt_at'] as string)
      : null;

    if (lastAttemptAt !== null) {
      const delayMs = retryDelays[attempts - 1] ?? retryDelays[retryDelays.length - 1];
      const nextAttemptAt = new Date(lastAttemptAt.getTime() + (delayMs ?? 60_000));
      if (now < nextAttemptAt) continue;
    }

    const subscriptionId = rawRow['subscription_id'] as string;
    const deliveryId = rawRow['id'] as string;

    const sub = await db('webhook_subscriptions').where('id', subscriptionId).first();

    if (!sub) {
      await db('webhook_deliveries').where('id', deliveryId).update({ status: 'FAILED' });
      continue;
    }

    const subRow = sub as Record<string, unknown>;

    if ((subRow['failure_count'] as number) > 10) {
      await db('webhook_subscriptions').where('id', subscriptionId).update({ is_active: false });
      await db('webhook_deliveries').where('id', deliveryId).update({ status: 'FAILED' });
      continue;
    }

    const payloadRaw = rawRow['payload'];
    const payload: object =
      typeof payloadRaw === 'string'
        ? (JSON.parse(payloadRaw as string) as object)
        : (payloadRaw as object);

    await db('webhook_deliveries').where('id', deliveryId).update({
      attempts: attempts + 1,
      last_attempt_at: new Date().toISOString(),
    });

    const payloadStr = JSON.stringify(payload);
    const signature = signPayload(payloadStr, subRow['secret'] as string);

    let responseStatus: number | null = null;
    let lastError: string | null = null;
    let delivered = false;

    try {
      const resp = await fetch(subRow['callback_url'] as string, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GL-Signature': signature,
          'X-GL-Event': (payload as Record<string, unknown>)['event_type'] as string,
          'X-GL-Delivery': deliveryId,
        },
        body: payloadStr,
        signal: AbortSignal.timeout(10_000),
      });
      responseStatus = resp.status;
      delivered = resp.ok;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (delivered) {
      await db('webhook_deliveries').where('id', deliveryId).update({
        status: 'DELIVERED',
        last_response_status: responseStatus,
      });
      await db('webhook_subscriptions').where('id', subscriptionId).update({
        last_delivery_at: new Date().toISOString(),
        failure_count: 0,
      });
    } else {
      const newAttempts = attempts + 1;
      if (newAttempts >= maxAttempts) {
        await db('webhook_deliveries').where('id', deliveryId).update({
          status: 'FAILED',
          last_response_status: responseStatus,
          last_error: lastError,
        });
        await db('webhook_subscriptions').where('id', subscriptionId).increment('failure_count', 1);
      } else {
        await db('webhook_deliveries').where('id', deliveryId).update({
          last_response_status: responseStatus,
          last_error: lastError,
        });
        await db('webhook_subscriptions').where('id', subscriptionId).increment('failure_count', 1);
      }
    }
  }
}
