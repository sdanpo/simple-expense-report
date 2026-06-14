package com.expensereport.app

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Periodic backstop (every few hours). Content-URI triggers can be missed after a
 * force-stop or reboot, so this re-scans from the checkpoint and flushes the queue.
 * This is the GUARANTEE that nothing is ever permanently lost — not a nicety.
 */
class SweepWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        return try {
            ScanEngine.run(applicationContext)
            // Make sure the real-time trigger is armed (e.g. after reboot).
            WorkScheduler.scheduleContentTrigger(applicationContext)
            Result.success()
        } catch (e: Exception) {
            Result.retry()
        }
    }
}
