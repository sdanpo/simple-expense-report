package com.expensereport.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.expensereport.core.ReceiptGate
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * On-device receipt gate: ML Kit text recognition (no network, ~0.1 J/photo) feeds
 * the pure ReceiptGate scorer in core.
 *
 * NOTE: ML Kit's Latin recognizer does not read Hebrew script, so Hebrew keyword
 * cues will be missed — but ReceiptGate is permissive and still fires on the digits,
 * amount pattern, and ₪/currency that appear on Hebrew receipts. Acceptable given the
 * server is the authoritative classifier; revisit if recall on Hebrew is too low.
 */
object MlKitGate {
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    suspend fun isCandidate(context: Context, mediaId: Long): Boolean {
        val bytes = MediaQuery.readBytes(context, mediaId) ?: return false
        return isCandidate(bytes)
    }

    suspend fun isCandidate(bytes: ByteArray): Boolean {
        // Downscale to keep OCR cheap; receipts remain legible at ~1024px.
        val bmp = decodeDownscaled(bytes, 1024) ?: return false
        return try {
            val image = InputImage.fromBitmap(bmp, 0)
            val text = recognize(image)
            ReceiptGate.isCandidate(text, bmp.width, bmp.height)
        } finally {
            bmp.recycle()
        }
    }

    private suspend fun recognize(image: InputImage): String =
        suspendCancellableCoroutine { cont ->
            recognizer.process(image)
                .addOnSuccessListener { cont.resume(it.text) }
                .addOnFailureListener { cont.resume("") } // OCR failure -> empty text -> not a candidate
        }

    private fun decodeDownscaled(bytes: ByteArray, maxDim: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val longest = maxOf(bounds.outWidth, bounds.outHeight).coerceAtLeast(1)
        var sample = 1
        while (longest / sample > maxDim) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    }
}
