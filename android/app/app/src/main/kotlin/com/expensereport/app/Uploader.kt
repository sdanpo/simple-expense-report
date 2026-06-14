package com.expensereport.app

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Multipart POST to the backend /api/inbound. Returns the HTTP status code, or null
 * on a transport failure (no connection / timeout). The caller maps that to a queue
 * decision via core.UploadOutcome — keeping the retry/terminal policy identical to
 * what the backend documents.
 */
object Uploader {
    private val client = OkHttpClient.Builder()
        .callTimeout(60, TimeUnit.SECONDS)
        .build()

    fun upload(
        baseUrl: String,
        token: String,
        bytes: ByteArray,
        fileName: String,
        mimeType: String,
        clientDedupId: String
    ): Int? {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("file", fileName, bytes.toRequestBody(mimeType.toMediaTypeOrNull()))
            .addFormDataPart("file_name", fileName)
            .addFormDataPart("client_dedup_id", clientDedupId)
            .build()

        val request = Request.Builder()
            .url(baseUrl.trimEnd('/') + "/api/inbound")
            .header("Authorization", "Bearer $token")
            .post(body)
            .build()

        return try {
            client.newCall(request).execute().use { it.code }
        } catch (_: IOException) {
            null // transport failure -> RETRY
        }
    }
}
