package com.expensereport.app

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import com.expensereport.core.MediaItem

/** Reads camera-roll image rows from MediaStore (the data MediaScan reasons over). */
object MediaQuery {
    fun contentUri(id: Long): Uri =
        ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)

    /** Images with _ID greater than [sinceId], oldest first. */
    fun imagesSince(context: Context, sinceId: Long): List<MediaItem> {
        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DATE_TAKEN,
            MediaStore.Images.Media.DATE_ADDED,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.MIME_TYPE
        )
        val selection = "${MediaStore.Images.Media._ID} > ?"
        val args = arrayOf(sinceId.toString())
        val sort = "${MediaStore.Images.Media._ID} ASC"

        val out = ArrayList<MediaItem>()
        context.contentResolver.query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI, projection, selection, args, sort
        )?.use { c ->
            val idC = c.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            val takenC = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_TAKEN)
            val addedC = c.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED)
            val sizeC = c.getColumnIndexOrThrow(MediaStore.Images.Media.SIZE)
            val mimeC = c.getColumnIndexOrThrow(MediaStore.Images.Media.MIME_TYPE)
            while (c.moveToNext()) {
                val taken = c.getLong(takenC).let { if (it > 0) it else c.getLong(addedC) * 1000 }
                out.add(
                    MediaItem(
                        id = c.getLong(idC),
                        dateTakenMs = taken,
                        sizeBytes = c.getLong(sizeC),
                        mime = c.getString(mimeC) ?: ""
                    )
                )
            }
        }
        return out
    }

    fun readBytes(context: Context, id: Long): ByteArray? =
        context.contentResolver.openInputStream(contentUri(id))?.use { it.readBytes() }
}
