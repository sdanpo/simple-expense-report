package com.expensereport.core

data class NetworkState(val online: Boolean, val unmetered: Boolean, val charging: Boolean)

data class UploadPolicy(
    val preferUnmetered: Boolean = true,
    val preferCharging: Boolean = true,
    val deadlineMs: Long = 30L * 60L * 1000L // 30 min: after this, send on ANY connection
)

/**
 * The v2 battery rule, encoded: PREFER cheap conditions (WiFi + charging), but NEVER
 * strand a receipt. Once an item is older than the deadline it uploads on whatever
 * connection exists. The on-device gate already shrank uploads to ~3/day, so the
 * battery saved by waiting for WiFi is a rounding error not worth a lost receipt.
 */
object NetworkPolicy {
    fun shouldUploadNow(
        item: QueueItem,
        now: Long,
        net: NetworkState,
        policy: UploadPolicy = UploadPolicy()
    ): Boolean {
        if (!net.online) return false
        if (item.state != ItemState.PENDING) return false
        if (now < item.nextAttemptAt) return false      // honor backoff
        val age = now - item.createdAt
        if (age >= policy.deadlineMs) return true        // deadline overrides preferences
        if (policy.preferUnmetered && !net.unmetered) return false
        if (policy.preferCharging && !net.charging) return false
        return true
    }

    /** Eligible items, oldest first (so the longest-waiting receipt goes out first). */
    fun eligible(
        items: List<QueueItem>,
        now: Long,
        net: NetworkState,
        policy: UploadPolicy = UploadPolicy()
    ): List<QueueItem> =
        items.filter { shouldUploadNow(it, now, net, policy) }.sortedBy { it.createdAt }
}
