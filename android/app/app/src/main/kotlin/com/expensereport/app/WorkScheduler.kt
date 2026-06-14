package com.expensereport.app

import android.content.Context
import android.provider.MediaStore
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Registers the two background entry points. Battery discipline lives entirely here:
 *  - a content-URI trigger that the OS fires on new photos (no service, no polling)
 *  - a periodic sweep as the reliability backstop
 * Note there are NO charging/unmetered constraints on the trigger — the gate already
 * makes uploads tiny, so we prioritize promptness; NetworkPolicy decides per-item
 * whether to actually send now or wait.
 */
object WorkScheduler {
    private const val TRIGGER_WORK = "photo-content-trigger"
    private const val SWEEP_WORK = "photo-sweep"
    private const val SYNC_NOW_WORK = "sync-now"

    fun scheduleAll(context: Context) {
        scheduleContentTrigger(context)
        schedulePeriodicSweep(context)
    }

    fun scheduleContentTrigger(context: Context) {
        val constraints = Constraints.Builder()
            .addContentUriTrigger(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
            .setTriggerContentUpdateDelay(10, TimeUnit.SECONDS)  // coalesce bursts
            .setTriggerContentMaxDelay(5, TimeUnit.MINUTES)      // but never wait long
            .build()
        val req = OneTimeWorkRequestBuilder<PhotoScanWorker>()
            .setConstraints(constraints)
            .build()
        // REPLACE: the worker re-arms from its own finally{} block, where it still
        // counts as "running" — KEEP would skip the re-arm and we'd stop watching.
        WorkManager.getInstance(context)
            .enqueueUniqueWork(TRIGGER_WORK, ExistingWorkPolicy.REPLACE, req)
    }

    fun schedulePeriodicSweep(context: Context) {
        val req = PeriodicWorkRequestBuilder<SweepWorker>(6, TimeUnit.HOURS).build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(SWEEP_WORK, ExistingPeriodicWorkPolicy.KEEP, req)
    }

    /** User tapped "Sync now" — run immediately (battery is irrelevant when foreground). */
    fun syncNow(context: Context) {
        val req = OneTimeWorkRequestBuilder<SweepWorker>().build()
        WorkManager.getInstance(context)
            .enqueueUniqueWork(SYNC_NOW_WORK, ExistingWorkPolicy.REPLACE, req)
    }
}
