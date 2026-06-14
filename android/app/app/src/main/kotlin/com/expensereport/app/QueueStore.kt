package com.expensereport.app

import android.content.Context
import com.expensereport.core.ItemState
import com.expensereport.core.QueueItem
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Durable JSON persistence for the upload queue (survives process death / reboot).
 * The transition LOGIC lives in core.UploadQueue; this only reads/writes state.
 */
class QueueStore(context: Context) {
    private val file = File(context.filesDir, "upload_queue.json")

    @Synchronized
    fun load(): MutableList<QueueItem> {
        if (!file.exists()) return mutableListOf()
        return try {
            val arr = JSONArray(file.readText())
            MutableList(arr.length()) { fromJson(arr.getJSONObject(it)) }
        } catch (_: Exception) {
            mutableListOf()
        }
    }

    @Synchronized
    fun save(items: List<QueueItem>) {
        val arr = JSONArray()
        items.forEach { arr.put(toJson(it)) }
        file.writeText(arr.toString())
    }

    @Synchronized
    fun upsert(item: QueueItem) {
        val items = load()
        val idx = items.indexOfFirst { it.id == item.id }
        if (idx >= 0) items[idx] = item else items.add(item)
        save(items)
    }

    @Synchronized
    fun contains(id: String): Boolean = load().any { it.id == id }

    private fun toJson(i: QueueItem) = JSONObject().apply {
        put("id", i.id)
        put("createdAt", i.createdAt)
        put("state", i.state.name)
        put("attempts", i.attempts)
        put("nextAttemptAt", i.nextAttemptAt)
        put("lastError", i.lastError ?: JSONObject.NULL)
    }

    private fun fromJson(o: JSONObject) = QueueItem(
        id = o.getString("id"),
        createdAt = o.getLong("createdAt"),
        state = ItemState.valueOf(o.getString("state")),
        attempts = o.getInt("attempts"),
        nextAttemptAt = o.getLong("nextAttemptAt"),
        lastError = if (o.isNull("lastError")) null else o.getString("lastError")
    )
}
