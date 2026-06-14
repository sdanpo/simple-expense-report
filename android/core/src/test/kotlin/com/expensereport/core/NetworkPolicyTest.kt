package com.expensereport.core

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class NetworkPolicyTest {
    private val wifiCharging = NetworkState(online = true, unmetered = true, charging = true)
    private val cellularOnBattery = NetworkState(online = true, unmetered = false, charging = false)
    private val offline = NetworkState(online = false, unmetered = false, charging = false)

    private fun fresh(now: Long) = QueueItem(id = "a", createdAt = now)

    @Test fun uploadsImmediatelyOnWifiAndCharging() {
        assertTrue(NetworkPolicy.shouldUploadNow(fresh(1000), now = 1000, net = wifiCharging))
    }

    @Test fun waitsOnCellularBatteryBeforeDeadline() {
        val item = fresh(0)
        assertFalse(NetworkPolicy.shouldUploadNow(item, now = 60_000, net = cellularOnBattery))
    }

    @Test fun sendsOnAnythingAfterDeadline() {
        val item = fresh(0)
        val policy = UploadPolicy(deadlineMs = 30 * 60_000L)
        assertTrue(NetworkPolicy.shouldUploadNow(item, now = 31 * 60_000L, net = cellularOnBattery, policy = policy))
    }

    @Test fun neverUploadsOffline_evenPastDeadline() {
        val item = fresh(0)
        assertFalse(NetworkPolicy.shouldUploadNow(item, now = 99 * 60_000L, net = offline))
    }

    @Test fun honorsBackoffWindow() {
        val item = fresh(0).copy(nextAttemptAt = 10_000)
        assertFalse(NetworkPolicy.shouldUploadNow(item, now = 5_000, net = wifiCharging))
        assertTrue(NetworkPolicy.shouldUploadNow(item, now = 10_000, net = wifiCharging))
    }

    @Test fun ignoresNonPendingItems() {
        val uploading = fresh(0).copy(state = ItemState.UPLOADING)
        assertFalse(NetworkPolicy.shouldUploadNow(uploading, now = 1000, net = wifiCharging))
    }

    @Test fun eligibleReturnsOldestFirst() {
        val items = listOf(fresh(300), fresh(100), fresh(200))
        val ordered = NetworkPolicy.eligible(items, now = 1000, net = wifiCharging)
        assertTrue(ordered.map { it.createdAt } == listOf(100L, 200L, 300L))
    }
}
