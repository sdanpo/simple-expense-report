package com.expensereport.core

enum class ItemState { PENDING, UPLOADING, DONE, DROPPED }

/**
 * A durable queue entry. The Android layer persists these (e.g. Room/DataStore) so
 * the queue survives process death and reboot; all the transition LOGIC lives here
 * and is pure/testable.
 */
data class QueueItem(
    val id: String,            // stable client dedup id (see MediaScan.clientDedupId)
    val createdAt: Long,       // when the photo was detected (ms epoch)
    val state: ItemState = ItemState.PENDING,
    val attempts: Int = 0,
    val nextAttemptAt: Long = 0L,
    val lastError: String? = null
)

object UploadQueue {
    const val BASE_BACKOFF_MS = 30_000L              // 30s
    const val MAX_BACKOFF_MS = 6L * 60L * 60L * 1000L // 6h cap
    const val MAX_ATTEMPTS = 12                       // then drop, to avoid looping forever

    /** Exponential backoff: BASE * 2^(attempts-1), capped at MAX_BACKOFF_MS. */
    fun backoffMillis(attempts: Int): Long {
        if (attempts <= 0) return BASE_BACKOFF_MS
        val shift = minOf(attempts - 1, 40)
        val raw = BASE_BACKOFF_MS * (1L shl shift)
        return if (raw <= 0L || raw > MAX_BACKOFF_MS) MAX_BACKOFF_MS else raw
    }

    /** About to attempt an upload. */
    fun markUploading(item: QueueItem): QueueItem = item.copy(state = ItemState.UPLOADING)

    /** Apply the outcome of an attempt at time [now]. */
    fun onResult(item: QueueItem, decision: UploadDecision, now: Long, error: String? = null): QueueItem =
        when (decision) {
            UploadDecision.TERMINAL_SUCCESS ->
                item.copy(state = ItemState.DONE, lastError = null)
            UploadDecision.TERMINAL_DROP ->
                item.copy(state = ItemState.DROPPED, lastError = error)
            UploadDecision.REAUTH ->
                // Don't burn an attempt — the token, not the item, is the problem.
                item.copy(state = ItemState.PENDING, nextAttemptAt = now + BASE_BACKOFF_MS, lastError = "reauth")
            UploadDecision.RETRY -> {
                val attempts = item.attempts + 1
                if (attempts >= MAX_ATTEMPTS)
                    item.copy(state = ItemState.DROPPED, attempts = attempts, lastError = error ?: "max attempts")
                else
                    item.copy(
                        state = ItemState.PENDING,
                        attempts = attempts,
                        nextAttemptAt = now + backoffMillis(attempts),
                        lastError = error
                    )
            }
        }

    /** Items still needing work (not DONE/DROPPED). */
    fun unfinished(items: List<QueueItem>): List<QueueItem> =
        items.filter { it.state == ItemState.PENDING || it.state == ItemState.UPLOADING }
}
