package com.expensereport.app

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Fired by the OS when MediaStore changes (a new photo). Runs the scan/flush, then
 * RE-ARMS the content-URI trigger — content triggers fire once, so the worker must
 * reschedule itself to keep watching. No foreground service, no polling: the app is
 * dormant between triggers, which is the whole battery story.
 */
class PhotoScanWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        return try {
            ScanEngine.run(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        } finally {
            // Re-arm regardless of outcome so we never stop watching.
            WorkScheduler.scheduleContentTrigger(applicationContext)
        }
    }
}
