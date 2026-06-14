package com.expensereport.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MediaScanTest {
    private fun m(id: Long) = MediaItem(id = id, dateTakenMs = id * 10, sizeBytes = 2048, mime = "image/jpeg")

    @Test fun newSinceFiltersAndSorts() {
        val items = listOf(m(5), m(2), m(8), m(3))
        val out = MediaScan.newSince(items, lastSeenId = 3)
        assertEquals(listOf(5L, 8L), out.map { it.id })
    }

    @Test fun newSinceEmptyWhenNothingNewer() {
        assertTrue(MediaScan.newSince(listOf(m(1), m(2)), lastSeenId = 9).isEmpty())
    }

    @Test fun advanceCheckpointTakesMax() {
        assertEquals(8L, MediaScan.advanceCheckpoint(3, listOf(m(5), m(8), m(2))))
    }

    @Test fun advanceCheckpointNeverGoesBackwards() {
        assertEquals(9L, MediaScan.advanceCheckpoint(9, listOf(m(1), m(2))))
        assertEquals(9L, MediaScan.advanceCheckpoint(9, emptyList()))
    }

    @Test fun clientDedupIdIsStableAndDistinct() {
        assertEquals("5:50:2048", MediaScan.clientDedupId(m(5)))
        assertTrue(MediaScan.clientDedupId(m(5)) != MediaScan.clientDedupId(m(6)))
    }

    @Test fun supportedMimeIsAndroidOnly() {
        assertTrue(MediaScan.isSupported("image/jpeg"))
        assertTrue(MediaScan.isSupported("IMAGE/PNG"))
        assertFalse(MediaScan.isSupported("image/heic")) // Apple format excluded
    }
}
