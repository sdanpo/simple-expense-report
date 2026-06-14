package com.expensereport.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class UploadQueueTest {
    private fun item(now: Long = 0L) = QueueItem(id = "1:2:3", createdAt = now)

    @Test fun successMarksDone() {
        val r = UploadQueue.onResult(item(), UploadDecision.TERMINAL_SUCCESS, now = 1000)
        assertEquals(ItemState.DONE, r.state)
        assertEquals(null, r.lastError)
    }

    @Test fun dropMarksDropped() {
        val r = UploadQueue.onResult(item(), UploadDecision.TERMINAL_DROP, now = 1000, error = "413")
        assertEquals(ItemState.DROPPED, r.state)
    }

    @Test fun retryStaysPendingAndSchedulesBackoff() {
        val r = UploadQueue.onResult(item(), UploadDecision.RETRY, now = 1000, error = "503")
        assertEquals(ItemState.PENDING, r.state)
        assertEquals(1, r.attempts)
        assertEquals(1000 + UploadQueue.backoffMillis(1), r.nextAttemptAt)
    }

    @Test fun reauthDoesNotBurnAnAttempt() {
        val r = UploadQueue.onResult(item().copy(attempts = 2), UploadDecision.REAUTH, now = 5000)
        assertEquals(ItemState.PENDING, r.state)
        assertEquals(2, r.attempts) // unchanged
        assertEquals(5000 + UploadQueue.BASE_BACKOFF_MS, r.nextAttemptAt)
    }

    @Test fun dropsAfterMaxAttempts() {
        var it = item().copy(attempts = UploadQueue.MAX_ATTEMPTS - 1)
        it = UploadQueue.onResult(it, UploadDecision.RETRY, now = 1000)
        assertEquals(ItemState.DROPPED, it.state)
    }

    @Test fun backoffIsExponentialAndCapped() {
        assertEquals(UploadQueue.BASE_BACKOFF_MS, UploadQueue.backoffMillis(1))
        assertEquals(UploadQueue.BASE_BACKOFF_MS * 2, UploadQueue.backoffMillis(2))
        assertEquals(UploadQueue.BASE_BACKOFF_MS * 4, UploadQueue.backoffMillis(3))
        assertTrue(UploadQueue.backoffMillis(100) <= UploadQueue.MAX_BACKOFF_MS)
        assertEquals(UploadQueue.MAX_BACKOFF_MS, UploadQueue.backoffMillis(100))
    }

    @Test fun unfinishedExcludesDoneAndDropped() {
        val items = listOf(
            item().copy(state = ItemState.PENDING),
            item().copy(state = ItemState.UPLOADING),
            item().copy(state = ItemState.DONE),
            item().copy(state = ItemState.DROPPED),
        )
        assertEquals(2, UploadQueue.unfinished(items).size)
    }
}
