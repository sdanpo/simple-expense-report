package com.expensereport.app

import android.content.Context
import java.io.File

/**
 * Copies a candidate photo's bytes into app-private storage AT DETECTION TIME, so a
 * receipt survives even if the user deletes it from the camera roll before it
 * uploads (a key v2 reliability guarantee). Bytes are removed once the item reaches
 * a terminal state.
 */
class PayloadStore(context: Context) {
    private val dir = File(context.filesDir, "queue").apply { mkdirs() }

    private fun fileFor(id: String) = File(dir, sanitize(id) + ".bin")

    fun save(id: String, bytes: ByteArray) {
        fileFor(id).writeBytes(bytes)
    }

    fun read(id: String): ByteArray? {
        val f = fileFor(id)
        return if (f.exists()) f.readBytes() else null
    }

    fun delete(id: String) {
        fileFor(id).delete()
    }

    fun has(id: String): Boolean = fileFor(id).exists()

    private fun sanitize(id: String) = id.replace(Regex("[^A-Za-z0-9_.-]"), "_")
}
