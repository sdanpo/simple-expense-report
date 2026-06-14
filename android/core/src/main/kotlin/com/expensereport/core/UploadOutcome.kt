package com.expensereport.core

/** What the queue should do with an item after an upload attempt. */
enum class UploadDecision {
    TERMINAL_SUCCESS, // handled by the server; remove from queue
    TERMINAL_DROP,    // server says this can never succeed; remove
    RETRY,            // transient; try again later with backoff
    REAUTH            // token rejected; pause and prompt sign-in (do not drop)
}

/**
 * Maps an HTTP status (or null for a transport/network failure) to a queue decision.
 * This MUST mirror the /api/inbound contract on the backend:
 *   2xx          -> success (terminal)         [approved/needs_review/not_a_receipt/duplicate/ignored_*]
 *   400, 413     -> drop (terminal)            [bad request / too large]
 *   401          -> re-auth                    [bad/missing token]
 *   408, 429,5xx -> retry
 *   other 4xx    -> drop (unexpected client error, not worth looping)
 *   null         -> retry                       [no connection / timeout]
 */
object UploadOutcome {
    fun fromHttpStatus(status: Int?): UploadDecision = when {
        status == null -> UploadDecision.RETRY
        status in 200..299 -> UploadDecision.TERMINAL_SUCCESS
        status == 401 -> UploadDecision.REAUTH
        status == 408 || status == 429 -> UploadDecision.RETRY
        status in 500..599 -> UploadDecision.RETRY
        status in 400..499 -> UploadDecision.TERMINAL_DROP
        else -> UploadDecision.RETRY
    }
}
