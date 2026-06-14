package com.expensereport.app

import android.content.Context
import com.expensereport.core.MediaScan
import com.expensereport.core.NetworkPolicy
import com.expensereport.core.QueueItem
import com.expensereport.core.UploadOutcome
import com.expensereport.core.UploadQueue

/**
 * The shared pipeline both the content-trigger worker and the periodic sweep run:
 *   1. find new photos since the checkpoint
 *   2. gate each on-device; copy candidate bytes to durable storage; enqueue
 *   3. advance the checkpoint
 *   4. flush the queue, honoring the network/battery policy and backoff
 *
 * All decisions (what's new, candidate?, upload outcome, retry) come from `core`,
 * which is unit-tested. This file is just the Android glue.
 */
object ScanEngine {

    suspend fun run(context: Context) {
        val prefs = Prefs(context)
        val queue = QueueStore(context)
        val payloads = PayloadStore(context)

        // 1. new media since checkpoint
        val media = MediaQuery.imagesSince(context, prefs.lastSeenMediaId)
        val fresh = MediaScan.newSince(media, prefs.lastSeenMediaId)

        // 2. gate + enqueue
        for (m in fresh) {
            if (!MediaScan.isSupported(m.mime)) continue
            val id = MediaScan.clientDedupId(m)
            if (queue.contains(id) || payloads.has(id)) continue
            val bytes = MediaQuery.readBytes(context, m.id) ?: continue
            val candidate = try {
                MlKitGate.isCandidate(bytes)
            } catch (_: Exception) {
                true // if OCR fails, be permissive — let the server decide
            }
            if (candidate) {
                payloads.save(id, bytes)           // capture bytes NOW (survives photo deletion)
                queue.upsert(QueueItem(id = id, createdAt = System.currentTimeMillis()))
            }
        }

        // 3. checkpoint (advance over ALL media seen, even non-candidates)
        prefs.lastSeenMediaId = MediaScan.advanceCheckpoint(prefs.lastSeenMediaId, media)

        // 4. flush
        flush(context, prefs, queue, payloads)
    }

    suspend fun flush(
        context: Context,
        prefs: Prefs = Prefs(context),
        queue: QueueStore = QueueStore(context),
        payloads: PayloadStore = PayloadStore(context)
    ) {
        val now = System.currentTimeMillis()
        val net = NetworkInfo.current(context)
        val eligible = NetworkPolicy.eligible(UploadQueue.unfinished(queue.load()), now, net)

        for (item in eligible) {
            queue.upsert(UploadQueue.markUploading(item))
            val bytes = payloads.read(item.id)
            if (bytes == null) {
                // Bytes gone and we have nothing to send — drop so we don't loop.
                queue.upsert(item.copy(state = com.expensereport.core.ItemState.DROPPED, lastError = "payload missing"))
                continue
            }
            val mediaId = item.id.substringBefore(':').toLongOrNull() ?: 0L
            val status = Uploader.upload(
                baseUrl = BuildConfig.BASE_URL,
                token = prefs.token,
                bytes = bytes,
                fileName = "receipt_$mediaId.jpg",
                mimeType = "image/jpeg",
                clientDedupId = item.id
            )
            val decision = UploadOutcome.fromHttpStatus(status)
            val updated = UploadQueue.onResult(item, decision, System.currentTimeMillis(), error = status?.toString())
            queue.upsert(updated)

            when (updated.state) {
                com.expensereport.core.ItemState.DONE -> {
                    payloads.delete(item.id)
                    Notifications.show(context, "Receipt added", "Synced to your expense sheet")
                }
                com.expensereport.core.ItemState.DROPPED -> {
                    payloads.delete(item.id)
                    Notifications.show(context, "Receipt skipped", "Couldn't process that photo")
                }
                else -> { /* still pending; will retry on a later run */ }
            }
        }
    }
}
