package com.expensereport.core

/** A photo as seen in MediaStore (subset of columns we care about). */
data class MediaItem(
    val id: Long,            // MediaStore._ID — monotonically increasing
    val dateTakenMs: Long,
    val sizeBytes: Long,
    val mime: String
)

/**
 * Pure logic for the content-trigger + periodic-sweep scan. The Android layer
 * supplies the MediaStore rows and persists the checkpoint; the "what is new" and
 * "stable id" decisions live here so they are testable and identical for both the
 * real-time trigger and the backstop sweep.
 */
object MediaScan {
    /** Items newer than the last processed MediaStore id, oldest first. */
    fun newSince(items: List<MediaItem>, lastSeenId: Long): List<MediaItem> =
        items.filter { it.id > lastSeenId }.sortedBy { it.id }

    /** Advance the checkpoint to the highest id seen; never moves backwards. */
    fun advanceCheckpoint(lastSeenId: Long, items: List<MediaItem>): Long =
        items.fold(lastSeenId) { acc, it -> maxOf(acc, it.id) }

    /**
     * Stable per-photo id so the real-time trigger and the sweep never enqueue the
     * same photo twice, and so a retry reuses the same client_dedup_id server-side.
     */
    fun clientDedupId(item: MediaItem): String = "${item.id}:${item.dateTakenMs}:${item.sizeBytes}"

    /** Supported capture formats (Android-only: no HEIC). */
    val SUPPORTED_MIME = setOf("image/jpeg", "image/jpg", "image/png", "image/webp")

    fun isSupported(mime: String): Boolean = SUPPORTED_MIME.contains(mime.lowercase())
}
